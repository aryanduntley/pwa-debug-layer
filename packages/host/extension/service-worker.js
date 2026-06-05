const probeTabScripting = async (tabId) => {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'ISOLATED',
            func: () => '__pwa_debug_probe__',
        });
        return 'scripts_run';
    }
    catch {
        return 'scripts_blocked';
    }
};
const RESTRICTED_PROTOCOLS = [
    'chrome:',
    'chrome-extension:',
    'about:',
    'devtools:',
    'edge:',
    'brave:',
    'view-source:',
    'file:',
];
const RESTRICTED_HOST_SUFFIXES = [
    'chromewebstore.google.com',
    'chrome.google.com',
];
const classifyRestrictedUrl = (url) => {
    if (!url)
        return null;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return null;
    }
    if (RESTRICTED_PROTOCOLS.includes(parsed.protocol))
        return 'restricted_url';
    if (RESTRICTED_HOST_SUFFIXES.includes(parsed.hostname)) {
        return 'restricted_url';
    }
    return null;
};
const classifyDispatchFailure = async (input) => {
    const restricted = classifyRestrictedUrl(input.url);
    if (restricted !== null) {
        return { code: 'restricted_url', message: input.lastErrorMessage };
    }
    const probe = await probeTabScripting(input.tabId);
    if (probe === 'scripts_blocked') {
        return { code: 'page_blocks_scripts', message: input.lastErrorMessage };
    }
    return {
        code: 'cs_not_attached_refresh_tab',
        message: input.lastErrorMessage,
    };
};
const CS_BUNDLE_PATH = 'content-script.js';
const PAGE_WORLD_BUNDLE_PATH = 'page-world.js';
const selfHealCsAttachment = async (tabId) => {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'ISOLATED',
            files: [CS_BUNDLE_PATH],
        });
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            files: [PAGE_WORLD_BUNDLE_PATH],
        });
        return { ok: true };
    }
    catch (err) {
        return { ok: false, reason: err.message };
    }
};

const DEFAULT_TIMEOUT_MS = 4500;
const SELF_HEAL_SETTLE_MS = 100;
const dispatchToTab = async (tabId, req, opts = {}) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(new Error(`sw-tab-dispatch timeout after ${timeoutMs}ms (tabId=${tabId})`));
        }, timeoutMs);
    });
    try {
        const response = await Promise.race([
            chrome.tabs.sendMessage(tabId, req),
            timeoutPromise,
        ]);
        return response;
    }
    finally {
        if (timeoutHandle !== undefined)
            clearTimeout(timeoutHandle);
    }
};
const dispatchToActiveTab = async (req, opts = {}) => {
    const tabs = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
    });
    const tabId = tabs[0]?.id;
    if (tabId === undefined) {
        throw new Error('no active tab');
    }
    return dispatchToTab(tabId, req, opts);
};
const getTabUrl = async (tabId) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        return tab?.url;
    }
    catch {
        return undefined;
    }
};
const dispatchToTabClassified = async (tabId, req, opts = {}) => {
    let response;
    try {
        response = await dispatchToTab(tabId, req, opts);
    }
    catch (err) {
        const lastErrorMessage = err.message;
        const url = await getTabUrl(tabId);
        const failure = await classifyDispatchFailure({
            tabId,
            url,
            lastErrorMessage,
        });
        if (failure.code !== 'cs_not_attached_refresh_tab') {
            return { ok: false, code: failure.code, message: failure.message };
        }
        const heal = await selfHealCsAttachment(tabId);
        if (!heal.ok) {
            return {
                ok: false,
                code: 'cs_inject_failed',
                message: heal.reason,
                selfHealed: true,
            };
        }
        await new Promise((resolve) => setTimeout(resolve, SELF_HEAL_SETTLE_MS));
        try {
            const retryResponse = await dispatchToTab(tabId, req, opts);
            if (retryResponse.error) {
                return {
                    ok: false,
                    code: 'page_world_blocked',
                    message: retryResponse.error.message,
                    selfHealed: true,
                };
            }
            return { ok: true, response: retryResponse, selfHealed: true };
        }
        catch (retryErr) {
            return {
                ok: false,
                code: 'cs_not_attached_refresh_tab',
                message: retryErr.message,
                selfHealed: true,
            };
        }
    }
    if (response.error) {
        return {
            ok: false,
            code: 'page_world_blocked',
            message: response.error.message,
        };
    }
    return { ok: true, response };
};

const compilePatternList = (sources, fieldPathPrefix) => {
    if (sources === undefined || sources.length === 0) {
        return { ok: true, value: [] };
    }
    const out = [];
    let i = 0;
    for (const src of sources) {
        try {
            out.push(new RegExp(src));
        }
        catch (e) {
            return {
                ok: false,
                error: {
                    kind: 'pattern_invalid',
                    fieldPath: `${fieldPathPrefix}[${i}]`,
                    error: e instanceof Error ? e.message : String(e),
                },
            };
        }
        i++;
    }
    return { ok: true, value: out };
};
const eventTextForPattern = (event) => {
    try {
        return JSON.stringify(event) ?? '';
    }
    catch {
        return '';
    }
};
const compileSourceFilter = (spec) => {
    const includeResult = compilePatternList(spec?.pattern?.include, 'pattern.include');
    if (!includeResult.ok)
        return { ok: false, error: includeResult.error };
    const excludeResult = compilePatternList(spec?.pattern?.exclude, 'pattern.exclude');
    if (!excludeResult.ok)
        return { ok: false, error: excludeResult.error };
    const include = includeResult.value;
    const exclude = excludeResult.value;
    const levelSet = spec?.level !== undefined && spec.level.length > 0
        ? new Set(spec.level)
        : null;
    const predicate = (event) => {
        if (levelSet !== null) {
            const lvl = event.level;
            if (lvl === undefined || !levelSet.has(lvl))
                return false;
        }
        if (include.length === 0 && exclude.length === 0)
            return true;
        const text = eventTextForPattern(event);
        for (const re of exclude) {
            if (re.test(text))
                return false;
        }
        if (include.length > 0) {
            let any = false;
            for (const re of include) {
                if (re.test(text)) {
                    any = true;
                    break;
                }
            }
            if (!any)
                return false;
        }
        return true;
    };
    return { ok: true, predicate };
};

/**
 * Cross-package settings vocabulary — the single source of truth for every
 * user-tunable setting in pwa-debug.
 *
 * Plug-ability invariant (M7): adding a new setting is exactly ONE line in
 * {@link SettingTypeMap} + ONE entry in {@link SETTINGS_SCHEMA}. The host
 * settings store, the settings.* MCP tools, and the extension settings cache
 * all iterate {@link settingKeys} / {@link getSettingEntry} — no key is ever
 * hardcoded — so a new key needs zero changes to any consumer's shape.
 *
 * Lives in @pwa-debug/shared so the host store and the (T3) extension cache
 * enforce identical key/value shapes at compile time via getSetting<K>.
 */
/** Runtime tuple of every {@link CaptureKind}, for validation and introspection. */
const CAPTURE_KINDS = [
    'console',
    'network',
    'dom_mutations',
    'lifecycle',
    'store_change',
    'replay',
    'library_popup',
    'page_error',
    'sw_state',
];
// --- internal primitive guards (not exported; not part of the public surface) ---
const isNonNegInt = (v) => typeof v === 'number' &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    v >= 0;
const isBoolean = (v) => typeof v === 'boolean';
/** A valid TCP port for remote debugging: integer in [1, 65535]. */
const isPort = (v) => typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= 1 &&
    v <= 65535;
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isCaptureKindSubset = (v) => Array.isArray(v) &&
    new Set(v).size === v.length &&
    v.every((x) => CAPTURE_KINDS.includes(x));
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isReadControlValue = (v) => {
    if (!isPlainObject(v))
        return false;
    const allowed = CAPTURE_KINDS;
    for (const [k, flag] of Object.entries(v)) {
        if (!allowed.includes(k))
            return false;
        if (typeof flag !== 'boolean')
            return false;
    }
    return true;
};
const isReadControlsRecord = (v) => {
    if (!isPlainObject(v))
        return false;
    for (const value of Object.values(v)) {
        if (!isReadControlValue(value))
            return false;
    }
    return true;
};
const CONSOLE_LEVELS = [
    'log',
    'info',
    'warn',
    'error',
    'debug',
    'trace',
];
const isFilterPattern = (v) => {
    if (!isPlainObject(v))
        return false;
    for (const [k, val] of Object.entries(v)) {
        if (k !== 'include' && k !== 'exclude')
            return false;
        if (val === undefined)
            continue;
        if (!Array.isArray(val))
            return false;
        if (!val.every((x) => typeof x === 'string'))
            return false;
    }
    return true;
};
const FILTER_SPEC_SOURCE_KEYS = ['level', 'pattern'];
const isSourceFilterSpec = (v) => {
    if (!isPlainObject(v))
        return false;
    for (const [k, val] of Object.entries(v)) {
        if (!FILTER_SPEC_SOURCE_KEYS.includes(k))
            return false;
        if (val === undefined)
            continue;
        if (k === 'level') {
            if (!Array.isArray(val))
                return false;
            if (!val.every((x) => typeof x === 'string' && CONSOLE_LEVELS.includes(x)))
                return false;
        }
        else if (k === 'pattern') {
            if (!isFilterPattern(val))
                return false;
        }
    }
    return true;
};
const isCaptureFiltersRecord = (v) => {
    if (!isPlainObject(v))
        return false;
    const allowed = CAPTURE_KINDS;
    for (const [k, val] of Object.entries(v)) {
        if (!allowed.includes(k))
            return false;
        if (val === undefined)
            continue;
        if (!isSourceFilterSpec(val))
            return false;
    }
    return true;
};
/**
 * The schema as data. Frozen. THIS is the single const instance; every
 * consumer reaches it through {@link settingKeys} / {@link getSettingEntry}.
 */
const SETTINGS_SCHEMA = Object.freeze({
    'capture.memoryCutoffPerKind': {
        key: 'capture.memoryCutoffPerKind',
        type: 'number',
        default: 5000,
        scope: 'host',
        description: 'Max events retained in memory per capture kind before eviction (overflow goes to disk when capture.diskSpill.enabled).',
        validate: isNonNegInt,
    },
    'capture.diskSpill.enabled': {
        key: 'capture.diskSpill.enabled',
        type: 'boolean',
        default: false,
        scope: 'host',
        description: 'When true, events evicted from the in-memory ring buffer are written to on-disk jsonl archives instead of dropped.',
        validate: isBoolean,
    },
    'capture.diskSpill.archiveLongevityDays': {
        key: 'capture.diskSpill.archiveLongevityDays',
        type: 'number',
        default: 7,
        scope: 'host',
        description: 'Age in days after which a disk archive file is pruned on the next pruner tick.',
        validate: isNonNegInt,
    },
    'capture.diskSpill.maxBytes': {
        key: 'capture.diskSpill.maxBytes',
        type: 'number',
        default: 100_000_000,
        scope: 'host',
        description: 'Total disk-archive byte cap; oldest archive files are evicted first when exceeded.',
        validate: isNonNegInt,
    },
    'sites.allowlist': {
        key: 'sites.allowlist',
        type: 'string[]',
        default: ['*'],
        scope: 'both',
        description: 'Glob patterns of origins/URLs the capture pipeline is permitted to record. Default ["*"] = all sites.',
        validate: isStringArray,
    },
    'sites.blocklist': {
        key: 'sites.blocklist',
        type: 'string[]',
        default: [],
        scope: 'both',
        description: 'Glob patterns of origins/URLs never captured; takes precedence over sites.allowlist.',
        validate: isStringArray,
    },
    'capture.enabledKinds': {
        key: 'capture.enabledKinds',
        type: 'enum[]',
        default: [
            'console',
            'network',
            'dom_mutations',
            'lifecycle',
            'store_change',
            'replay',
            'library_popup',
            'sw_state',
        ],
        scope: 'both',
        description: 'Subset of capture kinds actively recorded. Empty = capture nothing.',
        validate: isCaptureKindSubset,
        enumValues: CAPTURE_KINDS,
    },
    'sites.readControls': {
        key: 'sites.readControls',
        type: 'record',
        default: Object.freeze({}),
        scope: 'both',
        description: 'Per-site, per-kind read-permission overrides. Keys are glob patterns (same matcher as sites.allowlist); values are objects of CaptureKind→boolean flags. Missing flag = allowed; false denies that kind for matching URLs. Most-specific (longest) pattern wins per URL; ties broken lexicographically. Only DENIES events otherwise allowed by sites.allowlist + capture.enabledKinds — cannot re-enable what allowlist already rejected.',
        validate: isReadControlsRecord,
    },
    'capture.filters': {
        key: 'capture.filters',
        type: 'record',
        default: Object.freeze({}),
        scope: 'both',
        description: 'Per-kind source-side capture filters. Keys are CaptureKinds; values are wire FilterSpecs (level + pattern only — cursors and limit are seq-based, meaningful only on the host). When set, the capture chokepoint applies the compiled predicate BEFORE the event reaches the host buffer; rejected events are dropped at the source. Validation tightens the wire shape to source-applicable fields only.',
        validate: isCaptureFiltersRecord,
    },
    'capture.stores.allowDispatch': {
        key: 'capture.stores.allowDispatch',
        type: 'boolean',
        default: false,
        scope: 'both',
        description: 'When true, redux_dispatch (and forthcoming store-system dispatch tools) may write to the page-world store; when false (default), the dispatch tool rejects with an actionable next_steps[] hint. Gates the only write surface in the store-introspection family — reads (redux_get_state, redux_subscribe, redux_tail) are unaffected.',
        validate: isBoolean,
    },
    'capture.sourceMap.enabled': {
        key: 'capture.sourceMap.enabled',
        type: 'boolean',
        default: true,
        scope: 'both',
        description: 'When true (default), source_map_resolve fetches and resolves source maps to translate generated stack frames into original-source coordinates. When false, the tool returns errorResponse with a hint. M13 ships query-time resolution only; capture-time auto-annotation is deferred to M13.5.',
        validate: isBoolean,
    },
    'launch.defaultPort': {
        key: 'launch.defaultPort',
        type: 'number',
        default: 9222,
        scope: 'host',
        description: 'Default remote-debugging port used by pdl_launch_browser when no explicit `port` arg is given. 9222 is the chrome-devtools-mcp convention. Change it if 9222 is already in use on your machine.',
        validate: isPort,
    },
});
/**
 * All setting keys in stable schema-declaration order — the canonical
 * iteration order for defaults-merge and settings.list_schema.
 */
const settingKeys = () => Object.keys(SETTINGS_SCHEMA);
/**
 * Typed accessor for a single schema entry — the one DRY lookup point so a
 * future key change is a single schema edit, never a consumer change.
 */
const getSettingEntry = (key) => SETTINGS_SCHEMA[key];
/**
 * Central pure type-guard: validate an unknown value against a key's schema
 * validator. Single validation path shared by the host_settings store and the
 * settings.set MCP tool. Narrows `value` to SettingTypeMap[K] on true.
 */
const validateSettingValue = (key, value) => getSettingEntry(key).validate(value);
/**
 * Factory producing a fresh fully-materialized {@link SettingsRecord} of every
 * key's default. Array and plain-object defaults are cloned so the result
 * never aliases the frozen SETTINGS_SCHEMA. The base the host_settings store
 * merges over.
 */
const defaultSettings = () => Object.fromEntries(settingKeys().map((k) => {
    const d = getSettingEntry(k).default;
    if (Array.isArray(d))
        return [k, [...d]];
    if (isPlainObject(d))
        return [k, { ...d }];
    return [k, d];
}));

// Single source of truth for the Path 7 pdl_* interaction action tools.
//
// Both the host (builds a ToolDef + Zod schema per entry) and the extension
// (SW request routing + page-world dispatch) import this table, so tool names,
// their dom_actions action kind, and their parameters stay in sync across
// packages. Adding a tool = one entry here + (for new param shapes) the typed
// param model below; the three generic layers need no per-tool code.
const S = (key, required = false, description) => ({
    key,
    type: 'string',
    ...(required ? { required } : {}),
    ...(description !== undefined ? { description } : {}),
});
const N = (key, required = false, description) => ({
    key,
    type: 'number',
    ...(required ? { required } : {}),
    ...(description !== undefined ? { description } : {}),
});
const B = (key, description) => ({
    key,
    type: 'boolean',
    ...(description !== undefined ? { description } : {}),
});
const ACTION_TOOL_SPECS = Object.freeze([
    // --- discrete (pointer/keyboard) ---
    { tool: 'pdl_click', action: 'click', params: [], summary: 'Click an element (full pointer/mouse event chain so React/Vue delegated onClick fires).' },
    { tool: 'pdl_dblclick', action: 'dblclick', params: [], summary: 'Double-click an element.' },
    { tool: 'pdl_fill', action: 'fill', params: [S('value', true, 'text to set')], summary: "Set an input/textarea/select value via the native setter + input/change (works with React controlled inputs)." },
    { tool: 'pdl_submit', action: 'submit', params: [], summary: 'Submit the form owning the located element (requestSubmit).' },
    { tool: 'pdl_hover', action: 'hover', params: [], summary: 'Hover an element (pointer/mouse over/enter/move).' },
    { tool: 'pdl_focus', action: 'focus', params: [], summary: 'Focus an element.' },
    { tool: 'pdl_blur', action: 'blur', params: [], summary: 'Blur an element.' },
    { tool: 'pdl_check', action: 'check', params: [], summary: 'Check a checkbox/radio (idempotent; native click path so onChange fires).' },
    { tool: 'pdl_uncheck', action: 'uncheck', params: [], summary: 'Uncheck a checkbox (idempotent).' },
    { tool: 'pdl_select_option', action: 'selectOption', params: [S('value', false, 'option value'), S('label', false, 'visible option label')], summary: 'Select a <select> option by value or visible label (one required).' },
    { tool: 'pdl_key_press', action: 'keyPress', params: [S('key', true, "a character or named key e.g. 'Enter','Tab','ArrowDown'")], summary: 'Press a single key on an element.' },
    { tool: 'pdl_type_sequence', action: 'typeSequence', params: [S('value', true, 'string to type char-by-char')], summary: 'Type a string into an editable element char-by-char.' },
    // --- gestures (pointer/touch) ---
    { tool: 'pdl_drag', action: 'drag', params: [N('toX', false, 'destination viewport X'), N('toY', false, 'destination viewport Y'), S('targetSelector', false, 'CSS selector for the drop target (alternative to toX/toY)'), N('steps', false, 'pointermove steps (default 10)'), B('html5', 'also fire the native HTML5 drag/drop sequence with a DataTransfer')], summary: 'Drag the located element to a point (toX/toY) or onto targetSelector; pointer drag + optional HTML5 DnD.' },
    { tool: 'pdl_scroll', action: 'scroll', params: [N('deltaX', false, 'horizontal scroll delta'), N('deltaY', false, 'vertical scroll delta'), B('intoView', 'scrollIntoView (centered) instead of by-delta')], summary: 'Scroll the located element by delta (dispatches wheel + scrollBy) or scrollIntoView.' },
    { tool: 'pdl_swipe', action: 'swipe', params: [{ key: 'direction', type: 'enum', required: true, enum: ['up', 'down', 'left', 'right'], description: 'swipe direction' }, N('distance', false, 'px distance (default 100)'), N('steps', false, 'touchmove steps (default 10)')], summary: 'Swipe a touch across the located element in a direction.' },
    { tool: 'pdl_tap', action: 'tap', params: [], summary: 'Tap (touchstart/touchend) the located element.' },
    { tool: 'pdl_double_tap', action: 'doubleTap', params: [], summary: 'Double-tap the located element.' },
    { tool: 'pdl_long_press', action: 'longPress', params: [N('duration', false, 'hold ms before release (default 500)')], summary: 'Long-press the located element (holds, then releases + contextmenu).' },
    { tool: 'pdl_pinch', action: 'pinch', params: [N('scale', true, 'target scale: >1 zoom in, <1 zoom out'), N('steps', false, 'touchmove steps (default 10)')], summary: 'Pinch-zoom on the located element with two touches.' },
]);

const isSwRequestEnvelope = (m) => {
    if (m === null || typeof m !== 'object')
        return false;
    const r = m;
    return (r['type'] === 'request' &&
        typeof r['requestId'] === 'string' &&
        typeof r['tool'] === 'string');
};
const fetchPageWorld = async (tabId) => {
    const result = await dispatchToTabClassified(tabId, { tool: 'session_ping' });
    if (result.ok) {
        const payload = result.response.payload;
        return {
            pageWorld: payload ?? null,
            ...(result.selfHealed ? { pageWorldSelfHealed: true } : {}),
        };
    }
    return {
        pageWorld: null,
        pageWorldError: result.code,
        pageWorldErrorMessage: result.message,
        ...(result.selfHealed ? { pageWorldSelfHealed: true } : {}),
    };
};
const handleSessionPing = async () => {
    const tabs = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
    });
    const attachedTabId = tabs[0]?.id ?? null;
    const extensionVersion = chrome.runtime.getManifest().version;
    const pageWorldResult = attachedTabId !== null
        ? await fetchPageWorld(attachedTabId)
        : {
            pageWorld: null,
            pageWorldError: 'no_active_tab',
            pageWorldErrorMessage: 'no active tab',
        };
    const result = {
        extensionVersion,
        attachedTabId,
        pageWorld: pageWorldResult.pageWorld,
        ...(pageWorldResult.pageWorldError !== undefined
            ? { pageWorldError: pageWorldResult.pageWorldError }
            : {}),
        ...(pageWorldResult.pageWorldErrorMessage !== undefined
            ? { pageWorldErrorMessage: pageWorldResult.pageWorldErrorMessage }
            : {}),
        ...(pageWorldResult.pageWorldSelfHealed
            ? { pageWorldSelfHealed: true }
            : {}),
    };
    return result;
};
const sanitizeRecentFilter = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return {};
    const r = raw;
    const kinds = Array.isArray(r['kinds'])
        ? r['kinds'].filter((k) => typeof k === 'string')
        : undefined;
    const sinceMs = typeof r['sinceMs'] === 'number' ? r['sinceMs'] : undefined;
    const limit = typeof r['limit'] === 'number' ? r['limit'] : undefined;
    return {
        ...(kinds !== undefined ? { kinds } : {}),
        ...(sinceMs !== undefined ? { sinceMs } : {}),
        ...(limit !== undefined ? { limit } : {}),
    };
};
const handleRecentEvents = async (env, ctx) => {
    const filter = sanitizeRecentFilter(env.payload);
    const result = ctx.sink.getRecent(filter);
    return result;
};
const sanitizeEvaluateInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const expression = r['expression'];
    if (typeof expression !== 'string' || expression.length === 0)
        return null;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    return {
        tabId,
        payload: {
            expression,
            ...(typeof r['timeout_ms'] === 'number' && r['timeout_ms'] > 0
                ? { timeout_ms: r['timeout_ms'] }
                : {}),
            ...(typeof r['await_promise'] === 'boolean'
                ? { await_promise: r['await_promise'] }
                : {}),
        },
    };
};
const handleEvaluate = async (env) => {
    const sanitized = sanitizeEvaluateInput(env.payload);
    if (sanitized === null) {
        throw new Error('evaluate: payload must be { expression: non-empty string, tab_id?, timeout_ms?, await_promise? }');
    }
    const csReq = { tool: 'evaluate', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeReactTreeInput = (raw) => {
    if (raw === undefined || raw === null) {
        return { tabId: undefined, payload: {} };
    }
    if (typeof raw !== 'object')
        return null;
    const r = raw;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = {};
    if (typeof r['root_index'] === 'number' &&
        Number.isInteger(r['root_index']) &&
        r['root_index'] >= 0) {
        payload['root_index'] = r['root_index'];
    }
    if (typeof r['depth_limit'] === 'number' &&
        Number.isInteger(r['depth_limit']) &&
        r['depth_limit'] > 0) {
        payload['depth_limit'] = r['depth_limit'];
    }
    if (typeof r['max_nodes'] === 'number' &&
        Number.isInteger(r['max_nodes']) &&
        r['max_nodes'] > 0) {
        payload['max_nodes'] = r['max_nodes'];
    }
    return { tabId, payload };
};
const handleReactTree = async (env) => {
    const sanitized = sanitizeReactTreeInput(env.payload);
    if (sanitized === null) {
        throw new Error('react_tree: payload must be an object with optional { tab_id?, root_index?, depth_limit?, max_nodes? }');
    }
    const csReq = { tool: 'react_tree', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeReactGetStateInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const stableId = r['stable_id'];
    if (typeof stableId !== 'string' || stableId.length === 0)
        return null;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = { stable_id: stableId };
    if (typeof r['root_index'] === 'number' &&
        Number.isInteger(r['root_index']) &&
        r['root_index'] >= 0) {
        payload['root_index'] = r['root_index'];
    }
    if (typeof r['include_props'] === 'boolean')
        payload['include_props'] = r['include_props'];
    if (typeof r['include_hooks'] === 'boolean')
        payload['include_hooks'] = r['include_hooks'];
    return { tabId, payload };
};
const handleReactGetState = async (env) => {
    const sanitized = sanitizeReactGetStateInput(env.payload);
    if (sanitized === null) {
        throw new Error('react_get_state: payload must be { stable_id: non-empty string, tab_id?, root_index?, include_props?, include_hooks? }');
    }
    const csReq = { tool: 'react_get_state', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeReactFindByTextInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const pattern = r['pattern'];
    if (typeof pattern !== 'string' || pattern.length === 0)
        return null;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = { pattern };
    if (typeof r['exact'] === 'boolean')
        payload['exact'] = r['exact'];
    if (typeof r['root_index'] === 'number' &&
        Number.isInteger(r['root_index']) &&
        r['root_index'] >= 0) {
        payload['root_index'] = r['root_index'];
    }
    if (typeof r['max_matches'] === 'number' &&
        Number.isInteger(r['max_matches']) &&
        r['max_matches'] > 0) {
        payload['max_matches'] = r['max_matches'];
    }
    return { tabId, payload };
};
const handleReactFindByText = async (env) => {
    const sanitized = sanitizeReactFindByTextInput(env.payload);
    if (sanitized === null) {
        throw new Error('react_find_by_text: payload must be { pattern: non-empty string, tab_id?, exact?, root_index?, max_matches? }');
    }
    const csReq = { tool: 'react_find_by_text', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeReactFindByRoleInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const role = r['role'];
    if (typeof role !== 'string' || role.length === 0)
        return null;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = { role };
    if (typeof r['name'] === 'string' && r['name'].length > 0) {
        payload['name'] = r['name'];
    }
    if (typeof r['root_index'] === 'number' &&
        Number.isInteger(r['root_index']) &&
        r['root_index'] >= 0) {
        payload['root_index'] = r['root_index'];
    }
    if (typeof r['max_matches'] === 'number' &&
        Number.isInteger(r['max_matches']) &&
        r['max_matches'] > 0) {
        payload['max_matches'] = r['max_matches'];
    }
    return { tabId, payload };
};
const handleReactFindByRole = async (env) => {
    const sanitized = sanitizeReactFindByRoleInput(env.payload);
    if (sanitized === null) {
        throw new Error('react_find_by_role: payload must be { role: non-empty string, tab_id?, name?, root_index?, max_matches? }');
    }
    const csReq = { tool: 'react_find_by_role', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeVueTreeInput = (raw) => {
    if (raw === undefined || raw === null) {
        return { tabId: undefined, payload: {} };
    }
    if (typeof raw !== 'object')
        return null;
    const r = raw;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = {};
    if (typeof r['root_index'] === 'number' &&
        Number.isInteger(r['root_index']) &&
        r['root_index'] >= 0) {
        payload['root_index'] = r['root_index'];
    }
    if (typeof r['depth_limit'] === 'number' &&
        Number.isInteger(r['depth_limit']) &&
        r['depth_limit'] > 0) {
        payload['depth_limit'] = r['depth_limit'];
    }
    if (typeof r['max_nodes'] === 'number' &&
        Number.isInteger(r['max_nodes']) &&
        r['max_nodes'] > 0) {
        payload['max_nodes'] = r['max_nodes'];
    }
    return { tabId, payload };
};
const handleVueTree = async (env) => {
    const sanitized = sanitizeVueTreeInput(env.payload);
    if (sanitized === null) {
        throw new Error('vue_tree: payload must be an object with optional { tab_id?, root_index?, depth_limit?, max_nodes? }');
    }
    const csReq = { tool: 'vue_tree', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeVueGetStateInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const stableId = r['stable_id'];
    if (typeof stableId !== 'string' || stableId.length === 0)
        return null;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = { stable_id: stableId };
    if (typeof r['include_props'] === 'boolean')
        payload['include_props'] = r['include_props'];
    if (typeof r['include_state'] === 'boolean')
        payload['include_state'] = r['include_state'];
    return { tabId, payload };
};
const handleVueGetState = async (env) => {
    const sanitized = sanitizeVueGetStateInput(env.payload);
    if (sanitized === null) {
        throw new Error('vue_get_state: payload must be { stable_id: non-empty string, tab_id?, include_props?, include_state? }');
    }
    const csReq = { tool: 'vue_get_state', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeVueFindByTextInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const pattern = r['pattern'];
    if (typeof pattern !== 'string' || pattern.length === 0)
        return null;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = { pattern };
    if (typeof r['exact'] === 'boolean')
        payload['exact'] = r['exact'];
    if (typeof r['root_index'] === 'number' &&
        Number.isInteger(r['root_index']) &&
        r['root_index'] >= 0) {
        payload['root_index'] = r['root_index'];
    }
    if (typeof r['max_matches'] === 'number' &&
        Number.isInteger(r['max_matches']) &&
        r['max_matches'] > 0) {
        payload['max_matches'] = r['max_matches'];
    }
    return { tabId, payload };
};
const handleVueFindByText = async (env) => {
    const sanitized = sanitizeVueFindByTextInput(env.payload);
    if (sanitized === null) {
        throw new Error('vue_find_by_text: payload must be { pattern: non-empty string, tab_id?, exact?, root_index?, max_matches? }');
    }
    const csReq = { tool: 'vue_find_by_text', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeVueFindByRoleInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const role = r['role'];
    if (typeof role !== 'string' || role.length === 0)
        return null;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = { role };
    if (typeof r['name'] === 'string' && r['name'].length > 0) {
        payload['name'] = r['name'];
    }
    if (typeof r['root_index'] === 'number' &&
        Number.isInteger(r['root_index']) &&
        r['root_index'] >= 0) {
        payload['root_index'] = r['root_index'];
    }
    if (typeof r['max_matches'] === 'number' &&
        Number.isInteger(r['max_matches']) &&
        r['max_matches'] > 0) {
        payload['max_matches'] = r['max_matches'];
    }
    return { tabId, payload };
};
const handleVueFindByRole = async (env) => {
    const sanitized = sanitizeVueFindByRoleInput(env.payload);
    if (sanitized === null) {
        throw new Error('vue_find_by_role: payload must be { role: non-empty string, tab_id?, name?, root_index?, max_matches? }');
    }
    const csReq = { tool: 'vue_find_by_role', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
// ── Svelte introspection (Path 5 M42) ───────────────────────────────────────
const handleSvelteComponents = async (env) => {
    const raw = env.payload;
    const tabId = raw !== null &&
        typeof raw === 'object' &&
        typeof raw['tab_id'] === 'number' &&
        Number.isFinite(raw['tab_id'])
        ? raw['tab_id']
        : undefined;
    const csReq = { tool: 'svelte_components', payload: {} };
    const response = tabId !== undefined
        ? await dispatchToTab(tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
// sw_status (PWA Runtime Diagnostics): forward to the active (or given) tab's
// page-world, which reads navigator.serviceWorker. No params beyond tab_id —
// same shape as svelte_components.
const handleSwStatus = async (env) => {
    const raw = env.payload;
    const tabId = raw !== null &&
        typeof raw === 'object' &&
        typeof raw['tab_id'] === 'number' &&
        Number.isFinite(raw['tab_id'])
        ? raw['tab_id']
        : undefined;
    const csReq = { tool: 'sw_status', payload: {} };
    const response = tabId !== undefined
        ? await dispatchToTab(tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
// cache_* (PWA Runtime Diagnostics): forward to the active/given tab's page-world.
const readTabId = (raw) => raw !== null &&
    typeof raw === 'object' &&
    typeof raw['tab_id'] === 'number' &&
    Number.isFinite(raw['tab_id'])
    ? raw['tab_id']
    : undefined;
const handleCacheList = async (env) => {
    const tabId = readTabId(env.payload);
    const csReq = { tool: 'cache_list', payload: {} };
    const response = tabId !== undefined
        ? await dispatchToTab(tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error)
        throw new Error(response.error.message);
    return response.payload;
};
const handlePwaStatus = async (env) => {
    const tabId = readTabId(env.payload);
    const csReq = { tool: 'pwa_status', payload: {} };
    const response = tabId !== undefined
        ? await dispatchToTab(tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error)
        throw new Error(response.error.message);
    return response.payload;
};
const handlePwaInstallability = async (env) => {
    const tabId = readTabId(env.payload);
    const csReq = { tool: 'pwa_installability', payload: {} };
    const response = tabId !== undefined
        ? await dispatchToTab(tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error)
        throw new Error(response.error.message);
    return response.payload;
};
// storage_get (PWA Runtime Diagnostics T2): forward area + limit to the page-world.
const handleStorageGet = async (env) => {
    const r = env.payload !== null && typeof env.payload === 'object'
        ? env.payload
        : {};
    const payload = {};
    if (r['area'] === 'session' || r['area'] === 'local')
        payload['area'] = r['area'];
    if (typeof r['limit'] === 'number' &&
        Number.isInteger(r['limit']) &&
        r['limit'] > 0) {
        payload['limit'] = r['limit'];
    }
    const tabId = readTabId(env.payload);
    const csReq = { tool: 'storage_get', payload };
    const response = tabId !== undefined
        ? await dispatchToTab(tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error)
        throw new Error(response.error.message);
    return response.payload;
};
// idb_list (PWA Runtime Diagnostics T2): forward to the active/given tab's
// page-world, which reads indexedDB. No params beyond tab_id.
const handleIdbList = async (env) => {
    const tabId = readTabId(env.payload);
    const csReq = { tool: 'idb_list', payload: {} };
    const response = tabId !== undefined
        ? await dispatchToTab(tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error)
        throw new Error(response.error.message);
    return response.payload;
};
// idb_query (PWA Runtime Diagnostics T2): forward db + store + limit to the
// page-world over a read-only IndexedDB transaction.
const handleIdbQuery = async (env) => {
    const r = env.payload !== null && typeof env.payload === 'object'
        ? env.payload
        : {};
    const db = r['db'];
    if (typeof db !== 'string' || db.length === 0) {
        throw new Error('idb_query: payload must include { db: non-empty string }');
    }
    const store = r['store'];
    if (typeof store !== 'string' || store.length === 0) {
        throw new Error('idb_query: payload must include { store: non-empty string }');
    }
    const payload = { db, store };
    if (typeof r['limit'] === 'number' &&
        Number.isInteger(r['limit']) &&
        r['limit'] > 0) {
        payload['limit'] = r['limit'];
    }
    const tabId = readTabId(env.payload);
    const csReq = { tool: 'idb_query', payload };
    const response = tabId !== undefined
        ? await dispatchToTab(tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error)
        throw new Error(response.error.message);
    return response.payload;
};
// pwa_update_gather (PWA Runtime Diagnostics T3): forward to the active/given
// tab's page-world, which gathers the SW snapshot + cache entries. Optional
// per_cache_limit beyond tab_id.
const handlePwaUpdateGather = async (env) => {
    const r = env.payload !== null && typeof env.payload === 'object'
        ? env.payload
        : {};
    const payload = {};
    if (typeof r['per_cache_limit'] === 'number' &&
        Number.isInteger(r['per_cache_limit']) &&
        r['per_cache_limit'] > 0) {
        payload['per_cache_limit'] = r['per_cache_limit'];
    }
    const tabId = readTabId(env.payload);
    const csReq = { tool: 'pwa_update_gather', payload };
    const response = tabId !== undefined
        ? await dispatchToTab(tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error)
        throw new Error(response.error.message);
    return response.payload;
};
// pwa_snapshot (PWA Runtime Diagnostics T3): forward to the active/given tab's
// page-world, which composes the runtime-state blob. No params beyond tab_id.
const handlePwaSnapshotGather = async (env) => {
    const tabId = readTabId(env.payload);
    const csReq = { tool: 'pwa_snapshot_gather', payload: {} };
    const response = tabId !== undefined
        ? await dispatchToTab(tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error)
        throw new Error(response.error.message);
    return response.payload;
};
const handleCacheInspect = async (env) => {
    const r = env.payload !== null && typeof env.payload === 'object'
        ? env.payload
        : {};
    const name = r['cache_name'];
    if (typeof name !== 'string' || name.length === 0) {
        throw new Error('cache_inspect: payload must include { cache_name: non-empty string }');
    }
    const payload = { cache_name: name };
    if (typeof r['limit'] === 'number' && Number.isInteger(r['limit']) && r['limit'] > 0) {
        payload['limit'] = r['limit'];
    }
    const tabId = readTabId(env.payload);
    const csReq = { tool: 'cache_inspect', payload };
    const response = tabId !== undefined
        ? await dispatchToTab(tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error)
        throw new Error(response.error.message);
    return response.payload;
};
const handleCacheMatch = async (env) => {
    const r = env.payload !== null && typeof env.payload === 'object'
        ? env.payload
        : {};
    const url = r['url'];
    if (typeof url !== 'string' || url.length === 0) {
        throw new Error('cache_match: payload must include { url: non-empty string }');
    }
    const tabId = readTabId(env.payload);
    const csReq = { tool: 'cache_match', payload: { url } };
    const response = tabId !== undefined
        ? await dispatchToTab(tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error)
        throw new Error(response.error.message);
    return response.payload;
};
const sanitizeSvelteFindByTextInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const pattern = r['pattern'];
    if (typeof pattern !== 'string' || pattern.length === 0)
        return null;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = { pattern };
    if (typeof r['exact'] === 'boolean')
        payload['exact'] = r['exact'];
    if (typeof r['max_matches'] === 'number' &&
        Number.isInteger(r['max_matches']) &&
        r['max_matches'] > 0) {
        payload['max_matches'] = r['max_matches'];
    }
    return { tabId, payload };
};
const handleSvelteFindByText = async (env) => {
    const sanitized = sanitizeSvelteFindByTextInput(env.payload);
    if (sanitized === null) {
        throw new Error('svelte_find_by_text: payload must be { pattern: non-empty string, tab_id?, exact?, max_matches? }');
    }
    const csReq = { tool: 'svelte_find_by_text', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeSvelteFindByRoleInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const role = r['role'];
    if (typeof role !== 'string' || role.length === 0)
        return null;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = { role };
    if (typeof r['name'] === 'string' && r['name'].length > 0) {
        payload['name'] = r['name'];
    }
    if (typeof r['max_matches'] === 'number' &&
        Number.isInteger(r['max_matches']) &&
        r['max_matches'] > 0) {
        payload['max_matches'] = r['max_matches'];
    }
    return { tabId, payload };
};
const handleSvelteFindByRole = async (env) => {
    const sanitized = sanitizeSvelteFindByRoleInput(env.payload);
    if (sanitized === null) {
        throw new Error('svelte_find_by_role: payload must be { role: non-empty string, tab_id?, name?, max_matches? }');
    }
    const csReq = { tool: 'svelte_find_by_role', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
// ── Solid introspection (Path 5 M43) ────────────────────────────────────────
const handleSolidDetect = async (env) => {
    const raw = env.payload;
    const tabId = raw !== null &&
        typeof raw === 'object' &&
        typeof raw['tab_id'] === 'number' &&
        Number.isFinite(raw['tab_id'])
        ? raw['tab_id']
        : undefined;
    const csReq = { tool: 'solid_detect', payload: {} };
    const response = tabId !== undefined
        ? await dispatchToTab(tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeSolidFindByTextInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const pattern = r['pattern'];
    if (typeof pattern !== 'string' || pattern.length === 0)
        return null;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = { pattern };
    if (typeof r['exact'] === 'boolean')
        payload['exact'] = r['exact'];
    if (typeof r['max_matches'] === 'number' &&
        Number.isInteger(r['max_matches']) &&
        r['max_matches'] > 0) {
        payload['max_matches'] = r['max_matches'];
    }
    return { tabId, payload };
};
const handleSolidFindByText = async (env) => {
    const sanitized = sanitizeSolidFindByTextInput(env.payload);
    if (sanitized === null) {
        throw new Error('solid_find_by_text: payload must be { pattern: non-empty string, tab_id?, exact?, max_matches? }');
    }
    const csReq = { tool: 'solid_find_by_text', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeSolidFindByRoleInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const role = r['role'];
    if (typeof role !== 'string' || role.length === 0)
        return null;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = { role };
    if (typeof r['name'] === 'string' && r['name'].length > 0) {
        payload['name'] = r['name'];
    }
    if (typeof r['max_matches'] === 'number' &&
        Number.isInteger(r['max_matches']) &&
        r['max_matches'] > 0) {
        payload['max_matches'] = r['max_matches'];
    }
    return { tabId, payload };
};
const handleSolidFindByRole = async (env) => {
    const sanitized = sanitizeSolidFindByRoleInput(env.payload);
    if (sanitized === null) {
        throw new Error('solid_find_by_role: payload must be { role: non-empty string, tab_id?, name?, max_matches? }');
    }
    const csReq = { tool: 'solid_find_by_role', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeReduxGetStateInput = (raw) => {
    if (raw === undefined || raw === null) {
        return { tabId: undefined, payload: {} };
    }
    if (typeof raw !== 'object')
        return null;
    const r = raw;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = {};
    if (typeof r['path'] === 'string' && r['path'].length > 0) {
        payload['path'] = r['path'];
    }
    return { tabId, payload };
};
const handleReduxGetState = async (env) => {
    const sanitized = sanitizeReduxGetStateInput(env.payload);
    if (sanitized === null) {
        throw new Error('redux_get_state: payload must be an object with optional { tab_id?, path? }');
    }
    const csReq = { tool: 'redux_get_state', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeReduxSubscribeInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const action = r['action'];
    if (action !== 'start' && action !== 'stop')
        return null;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = { action };
    if (typeof r['path'] === 'string' && r['path'].length > 0) {
        payload['path'] = r['path'];
    }
    return { tabId, payload };
};
const handleReduxSubscribe = async (env) => {
    const sanitized = sanitizeReduxSubscribeInput(env.payload);
    if (sanitized === null) {
        throw new Error("redux_subscribe: payload must be { action: 'start' | 'stop', tab_id?, path? }");
    }
    const csReq = { tool: 'redux_subscribe', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeReduxDispatchInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const action = r['action'];
    if (action === null || typeof action !== 'object')
        return null;
    const a = action;
    if (typeof a['type'] !== 'string' || a['type'].length === 0) {
        return null;
    }
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    return { tabId, payload: { action } };
};
const handleReduxDispatch = async (env) => {
    const sanitized = sanitizeReduxDispatchInput(env.payload);
    if (sanitized === null) {
        throw new Error('redux_dispatch: payload must be { action: { type: non-empty string; payload? }, tab_id? }');
    }
    const csReq = { tool: 'redux_dispatch', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
// ── Unified store_* family (Path 4 M2) ──────────────────────────────────────
// Framework-aware variants of the redux_* sanitizers: they additionally pass
// an optional `framework` selector through to the page-world store handlers
// (which auto-detect when it is absent) and forward to the store_* page keys.
// The redux_* handlers above are kept untouched as deprecated aliases.
const extractFramework = (r) => typeof r['framework'] === 'string' && r['framework'].length > 0
    ? r['framework']
    : undefined;
const routedTabId = (r) => typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
    ? r['tab_id']
    : undefined;
const sanitizeStoreGetStateInput = (raw) => {
    if (raw === undefined || raw === null) {
        return { tabId: undefined, payload: {} };
    }
    if (typeof raw !== 'object')
        return null;
    const r = raw;
    const payload = {};
    if (typeof r['path'] === 'string' && r['path'].length > 0) {
        payload['path'] = r['path'];
    }
    const framework = extractFramework(r);
    if (framework !== undefined)
        payload['framework'] = framework;
    return { tabId: routedTabId(r), payload };
};
const handleStoreGetState = async (env) => {
    const sanitized = sanitizeStoreGetStateInput(env.payload);
    if (sanitized === null) {
        throw new Error('store_get_state: payload must be an object with optional { tab_id?, path?, framework? }');
    }
    const csReq = { tool: 'store_get_state', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeStoreSubscribeInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const action = r['action'];
    if (action !== 'start' && action !== 'stop')
        return null;
    const payload = { action };
    if (typeof r['path'] === 'string' && r['path'].length > 0) {
        payload['path'] = r['path'];
    }
    const framework = extractFramework(r);
    if (framework !== undefined)
        payload['framework'] = framework;
    return { tabId: routedTabId(r), payload };
};
const handleStoreSubscribe = async (env) => {
    const sanitized = sanitizeStoreSubscribeInput(env.payload);
    if (sanitized === null) {
        throw new Error("store_subscribe: payload must be { action: 'start' | 'stop', tab_id?, path?, framework? }");
    }
    const csReq = { tool: 'store_subscribe', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeStoreDispatchInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const action = r['action'];
    if (action === null || typeof action !== 'object')
        return null;
    const a = action;
    if (typeof a['type'] !== 'string' || a['type'].length === 0) {
        return null;
    }
    const payload = { action };
    const framework = extractFramework(r);
    if (framework !== undefined)
        payload['framework'] = framework;
    return { tabId: routedTabId(r), payload };
};
const handleStoreDispatch = async (env) => {
    const sanitized = sanitizeStoreDispatchInput(env.payload);
    if (sanitized === null) {
        throw new Error('store_dispatch: payload must be { action: { type: non-empty string; payload? }, tab_id?, framework? }');
    }
    const csReq = { tool: 'store_dispatch', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeSourceMapResolveInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const scriptUrl = r['script_url'];
    if (typeof scriptUrl !== 'string' || scriptUrl.length === 0)
        return null;
    const line = r['line'];
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1)
        return null;
    const column = r['column'];
    if (typeof column !== 'number' || !Number.isInteger(column) || column < 0) {
        return null;
    }
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    return {
        tabId,
        payload: { script_url: scriptUrl, line, column },
    };
};
const handleSourceMapResolve = async (env) => {
    const sanitized = sanitizeSourceMapResolveInput(env.payload);
    if (sanitized === null) {
        throw new Error('source_map_resolve: payload must be { script_url, line: int>=1, column: int>=0, tab_id? }');
    }
    const csReq = { tool: 'source_map_resolve', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
const sanitizeSessionRecordInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const action = r['action'];
    if (action !== 'start' && action !== 'stop')
        return null;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = { action };
    if (typeof r['session_id'] === 'string' && r['session_id'].length > 0) {
        payload['session_id'] = r['session_id'];
    }
    if (typeof r['duration_cap_ms'] === 'number' &&
        Number.isInteger(r['duration_cap_ms']) &&
        r['duration_cap_ms'] > 0) {
        payload['duration_cap_ms'] = r['duration_cap_ms'];
    }
    return { tabId, payload };
};
const handleSessionRecord = async (env) => {
    const sanitized = sanitizeSessionRecordInput(env.payload);
    if (sanitized === null) {
        throw new Error("session_record: payload must be { action: 'start' | 'stop', tab_id?, session_id?, duration_cap_ms? }");
    }
    const csReq = { tool: 'session_record', payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.payload;
};
// --- Path 7 interaction action tools (pdl_*) ---------------------------------
// One generic handler per ACTION_TOOL_SPECS entry: extract tab_id for routing,
// forward the locator + params payload to the page-world unchanged.
const sanitizeActionInput = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const tabId = typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
        ? r['tab_id']
        : undefined;
    const payload = {};
    for (const [k, v] of Object.entries(r)) {
        if (k !== 'tab_id' && k !== 'extension_id' && v !== undefined)
            payload[k] = v;
    }
    return tabId !== undefined ? { tabId, payload } : { payload };
};
const makeActionRequestHandler = (tool) => async (env) => {
    const sanitized = sanitizeActionInput(env.payload);
    if (sanitized === null) {
        throw new Error(`${tool}: payload must be an object carrying a locator`);
    }
    const csReq = { tool, payload: sanitized.payload };
    const response = sanitized.tabId !== undefined
        ? await dispatchToTab(sanitized.tabId, csReq)
        : await dispatchToActiveTab(csReq);
    if (response.error)
        throw new Error(response.error.message);
    return response.payload;
};
const actionRequestHandlers = Object.freeze(Object.fromEntries(ACTION_TOOL_SPECS.map((s) => [s.tool, makeActionRequestHandler(s.tool)])));
const HANDLERS = Object.freeze({
    ...actionRequestHandlers,
    session_ping: handleSessionPing,
    recent_events: handleRecentEvents,
    evaluate: handleEvaluate,
    react_tree: handleReactTree,
    react_get_state: handleReactGetState,
    react_find_by_text: handleReactFindByText,
    react_find_by_role: handleReactFindByRole,
    vue_tree: handleVueTree,
    vue_get_state: handleVueGetState,
    vue_find_by_text: handleVueFindByText,
    vue_find_by_role: handleVueFindByRole,
    svelte_components: handleSvelteComponents,
    svelte_find_by_text: handleSvelteFindByText,
    svelte_find_by_role: handleSvelteFindByRole,
    solid_detect: handleSolidDetect,
    solid_find_by_text: handleSolidFindByText,
    solid_find_by_role: handleSolidFindByRole,
    redux_get_state: handleReduxGetState,
    redux_subscribe: handleReduxSubscribe,
    redux_dispatch: handleReduxDispatch,
    store_get_state: handleStoreGetState,
    store_subscribe: handleStoreSubscribe,
    store_dispatch: handleStoreDispatch,
    source_map_resolve: handleSourceMapResolve,
    session_record: handleSessionRecord,
    sw_status: handleSwStatus,
    cache_list: handleCacheList,
    cache_inspect: handleCacheInspect,
    cache_match: handleCacheMatch,
    pwa_status: handlePwaStatus,
    pwa_installability: handlePwaInstallability,
    storage_get: handleStorageGet,
    idb_list: handleIdbList,
    idb_query: handleIdbQuery,
    pwa_update_gather: handlePwaUpdateGather,
    pwa_snapshot_gather: handlePwaSnapshotGather,
});
const errorResponse = (requestId, message) => Object.freeze({
    type: 'response',
    requestId,
    error: Object.freeze({ message }),
});
const okResponse = (requestId, payload) => Object.freeze({
    type: 'response',
    requestId,
    payload,
});
const routeRequest = async (env, ctx) => {
    const handler = HANDLERS[env.tool];
    if (!handler) {
        return errorResponse(env.requestId, `unknown tool: ${env.tool}`);
    }
    try {
        const payload = await handler(env, ctx);
        return okResponse(env.requestId, payload);
    }
    catch (err) {
        return errorResponse(env.requestId, err.message);
    }
};

const PAGE_EVENT_SW_TAG = 'pwa-debug-page-event';

const createBatchAccumulator = (opts) => {
    if (!Number.isFinite(opts.maxSize) || opts.maxSize <= 0) {
        throw new Error(`createBatchAccumulator: maxSize must be > 0, got ${String(opts.maxSize)}`);
    }
    if (!Number.isFinite(opts.maxMs) || opts.maxMs <= 0) {
        throw new Error(`createBatchAccumulator: maxMs must be > 0, got ${String(opts.maxMs)}`);
    }
    const maxSize = opts.maxSize;
    const maxMs = opts.maxMs;
    const flush = opts.flush;
    const pending = [];
    let timerHandle;
    const clearTimer = () => {
        if (timerHandle !== undefined) {
            clearTimeout(timerHandle);
            timerHandle = undefined;
        }
    };
    const flushNow = () => {
        clearTimer();
        if (pending.length === 0)
            return;
        const snapshot = pending.slice();
        pending.length = 0;
        flush(snapshot);
    };
    const push = (item) => {
        pending.push(item);
        if (pending.length >= maxSize) {
            flushNow();
            return;
        }
        if (timerHandle === undefined) {
            timerHandle = setTimeout(flushNow, maxMs);
        }
    };
    const dispose = () => {
        clearTimer();
        pending.length = 0;
    };
    return Object.freeze({ push, flushNow, dispose });
};

const DEFAULT_BUFFER_SIZE = 200;
const DEFAULT_LIMIT = 50;
const DEFAULT_FORWARD_MAX_SIZE = 50;
const DEFAULT_FORWARD_MAX_MS = 100;
const createEventSink = (input = {}) => {
    const logger = input.logger;
    const shouldRecord = input.shouldRecord;
    const bufferSize = input.bufferSize !== undefined && input.bufferSize > 0
        ? Math.floor(input.bufferSize)
        : DEFAULT_BUFFER_SIZE;
    const buffer = [];
    let writeIndex = 0;
    const perKind = {};
    let totalReceived = 0;
    const forwardAcc = input.forwardEvents !== undefined
        ? createBatchAccumulator({
            maxSize: input.forwardMaxSize ?? DEFAULT_FORWARD_MAX_SIZE,
            maxMs: input.forwardMaxMs ?? DEFAULT_FORWARD_MAX_MS,
            flush: input.forwardEvents,
        })
        : undefined;
    const snapshotStats = () => Object.freeze({
        totalReceived,
        perKind: Object.freeze({ ...perKind }),
        bufferSize,
    });
    const handle = (event) => {
        if (shouldRecord !== undefined && !shouldRecord(event)) {
            // Gated out: no stats, no buffer, no logger, no forward.
            return;
        }
        perKind[event.kind] = (perKind[event.kind] ?? 0) + 1;
        totalReceived += 1;
        if (buffer.length < bufferSize) {
            buffer.push(event);
        }
        else {
            buffer[writeIndex] = event;
        }
        writeIndex = (writeIndex + 1) % bufferSize;
        if (logger !== undefined) {
            try {
                logger(event);
            }
            catch {
                // Logger failures must not interrupt event ingestion.
            }
        }
        if (forwardAcc !== undefined) {
            forwardAcc.push(event);
        }
    };
    const getStats = () => snapshotStats();
    const getRecent = (filter = {}) => {
        const ordered = [];
        if (buffer.length < bufferSize) {
            for (let i = 0; i < buffer.length; i++) {
                ordered.push(buffer[i]);
            }
        }
        else {
            for (let i = 0; i < bufferSize; i++) {
                ordered.push(buffer[(writeIndex + i) % bufferSize]);
            }
        }
        const kindsSet = filter.kinds !== undefined && filter.kinds.length > 0
            ? new Set(filter.kinds)
            : undefined;
        const afterKinds = kindsSet === undefined
            ? ordered
            : ordered.filter((e) => kindsSet.has(e.kind));
        const sinceMs = filter.sinceMs;
        const afterSince = sinceMs === undefined
            ? afterKinds
            : afterKinds.filter((e) => e.ts > sinceMs);
        const requested = filter.limit !== undefined ? Math.floor(filter.limit) : DEFAULT_LIMIT;
        const cap = Math.max(0, Math.min(requested, bufferSize));
        const events = afterSince.length > cap
            ? afterSince.slice(afterSince.length - cap)
            : afterSince;
        return Object.freeze({
            events: Object.freeze([...events]),
            stats: snapshotStats(),
        });
    };
    const flushNow = () => {
        forwardAcc?.flushNow();
    };
    const dispose = () => {
        forwardAcc?.dispose();
    };
    return Object.freeze({ handle, getStats, getRecent, flushNow, dispose });
};
const isPageEventSwMessage = (msg) => {
    if (msg === null || typeof msg !== 'object')
        return false;
    const r = msg;
    return r['tag'] === PAGE_EVENT_SW_TAG && 'event' in r;
};

const isEnabled = (opts, subkind) => opts?.enabled?.[subkind] !== false;
const frameKeyFor = (frameId) => frameId === undefined || frameId === 0 ? 'top' : `frame-${frameId}`;
const createSwLifecycleProducer = (deps) => {
    if (typeof chrome === 'undefined' ||
        !chrome.tabs ||
        !chrome.webNavigation) {
        return () => { };
    }
    const { sink, opts, getTabUrl } = deps;
    const now = () => Date.now();
    let disposed = false;
    const cleanups = [];
    const tryEmit = (event) => {
        if (disposed)
            return;
        try {
            sink.handle(event);
        }
        catch {
            // Capture failure must never break the SW.
        }
    };
    const buildEvent = (payload, frameUrl, frameKey) => Object.freeze({
        kind: 'lifecycle',
        source: 'sw',
        ts: now(),
        frameUrl,
        frameKey,
        ...payload,
    });
    if (isEnabled(opts, 'navigation_committed')) {
        const onCommitted = (d) => {
            const payload = {
                subkind: 'navigation_committed',
                tabId: d.tabId,
                frameId: d.frameId,
                url: d.url,
                ...(d.transitionType ? { transitionType: d.transitionType } : {}),
                ...(d.transitionQualifiers
                    ? { transitionQualifiers: d.transitionQualifiers }
                    : {}),
            };
            tryEmit(buildEvent(payload, d.url, frameKeyFor(d.frameId)));
        };
        chrome.webNavigation.onCommitted.addListener(onCommitted);
        cleanups.push(() => chrome.webNavigation.onCommitted.removeListener(onCommitted));
    }
    if (isEnabled(opts, 'history_state_updated')) {
        const onHistory = (d) => {
            const payload = {
                subkind: 'history_state_updated',
                tabId: d.tabId,
                frameId: d.frameId,
                url: d.url,
                ...(d.transitionType ? { transitionType: d.transitionType } : {}),
                ...(d.transitionQualifiers
                    ? { transitionQualifiers: d.transitionQualifiers }
                    : {}),
            };
            tryEmit(buildEvent(payload, d.url, frameKeyFor(d.frameId)));
        };
        chrome.webNavigation.onHistoryStateUpdated.addListener(onHistory);
        cleanups.push(() => chrome.webNavigation.onHistoryStateUpdated.removeListener(onHistory));
    }
    if (isEnabled(opts, 'tab_status')) {
        const onUpdated = (tabId, changeInfo, tab) => {
            if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') {
                return;
            }
            const payload = {
                subkind: 'tab_status',
                tabId,
                status: changeInfo.status,
            };
            const url = tab.url ?? getTabUrl?.(tabId) ?? '';
            tryEmit(buildEvent(payload, url, 'top'));
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        cleanups.push(() => chrome.tabs.onUpdated.removeListener(onUpdated));
    }
    if (isEnabled(opts, 'tab_removed')) {
        const onRemoved = (tabId, removeInfo) => {
            const payload = {
                subkind: 'tab_removed',
                tabId,
                isWindowClosing: removeInfo.isWindowClosing,
            };
            const url = getTabUrl?.(tabId) ?? '';
            tryEmit(buildEvent(payload, url, 'top'));
        };
        chrome.tabs.onRemoved.addListener(onRemoved);
        cleanups.push(() => chrome.tabs.onRemoved.removeListener(onRemoved));
    }
    return () => {
        if (disposed)
            return;
        disposed = true;
        for (const cleanup of cleanups) {
            try {
                cleanup();
            }
            catch {
                // Ignore cleanup failures.
            }
        }
    };
};

const attachFrameId = (event, frameId) => {
    if (frameId === undefined)
        return event;
    return { ...event, frameId };
};

/**
 * Extension-side typed settings cache — SW-side mirror of host_settings.
 *
 * The host sends:
 *   • One IpcEventEnvelope{ tool:'settings_snapshot', payload:{values: SettingsRecord} }
 *     on extension register/handshake.
 *   • One IpcEventEnvelope{ tool:'settings_changed', payload: SettingChange }
 *     on each host store change.
 *
 * The SW orchestrator routes the envelope's payload to applySnapshot or
 * applyChange. This module owns the cache state — nothing here knows about
 * chrome.*, sockets, or IPC framing; it accepts already-decoded payloads as
 * `unknown` and defensively validates everything at the boundary.
 *
 * Pre-snapshot, getSetting returns the schema default for every key so
 * consumers (capture pipeline at T4, future UI) tolerate boot ordering.
 */
const isKnownKey = (k) => typeof k === 'string' &&
    settingKeys().includes(k);
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const createSettingsCache = () => {
    let current = defaultSettings();
    const getSetting = (key) => current[key];
    const getAll = () => current;
    const applySnapshot = (payload) => {
        if (!isRecord(payload))
            return { applied: 0 };
        const values = payload['values'];
        if (!isRecord(values))
            return { applied: 0 };
        const next = {
            ...defaultSettings(),
        };
        let applied = 0;
        for (const k of settingKeys()) {
            const v = values[k];
            if (v !== undefined && validateSettingValue(k, v)) {
                next[k] = v;
                applied += 1;
            }
        }
        current = next;
        return { applied };
    };
    const applyChange = (payload) => {
        if (!isRecord(payload))
            return { applied: false };
        const key = payload['key'];
        if (!isKnownKey(key))
            return { applied: false };
        const value = payload['value'];
        if (!validateSettingValue(key, value))
            return { applied: false };
        // Re-narrowing: getSettingEntry confirms the key exists in schema (defensive).
        if (!getSettingEntry(key))
            return { applied: false };
        current = { ...current, [key]: value };
        return { applied: true };
    };
    return { getSetting, getAll, applySnapshot, applyChange };
};

const REGEX_SPECIALS = /[.+?^${}()|[\]\\]/g;
const globToRegex = (pattern) => {
    const escaped = pattern.replace(REGEX_SPECIALS, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
};
const matchesAnyGlob = (value, patterns) => patterns.some((p) => globToRegex(p).test(value));
/**
 * Raw captured-event kinds (6) -> M7 capture categories (4).
 * The union side reflects the captured_event.ts kind discriminants.
 */
const KIND_MAP = Object.freeze({
    console: 'console',
    fetch: 'network',
    xhr: 'network',
    websocket: 'network',
    dom_mutation: 'dom_mutations',
    lifecycle: 'lifecycle',
    // App service-worker lifecycle: its own capture category + host buffer.
    sw_state: 'sw_state',
    store_change: 'store_change',
    replay: 'replay',
    library_popup: 'library_popup',
});
const eventKindToCaptureKind = (rawKind) => KIND_MAP[rawKind] ?? null;
const isKindEnabled = (rawKind, enabledKinds) => {
    const ck = eventKindToCaptureKind(rawKind);
    if (ck === null)
        return true; // unknown raw kinds default-allow (future-compat)
    return enabledKinds.includes(ck);
};
const isUrlAllowed = (url, allowlist, blocklist) => {
    if (matchesAnyGlob(url, blocklist))
        return false; // blocklist wins
    if (allowlist.length === 0)
        return false; // explicit opt-in model
    return matchesAnyGlob(url, allowlist);
};
/**
 * Pick the most-specific readControls entry whose glob pattern matches `url`.
 * Specificity = longest pattern string; ties broken by lexicographic order of
 * the pattern so the choice is deterministic. Returns undefined when no
 * pattern matches (caller treats as no restriction).
 */
const pickMostSpecificReadControl = (url, controls) => {
    let winnerPattern;
    let winnerValue;
    for (const [pattern, value] of Object.entries(controls)) {
        if (!matchesAnyGlob(url, [pattern]))
            continue;
        if (winnerPattern === undefined) {
            winnerPattern = pattern;
            winnerValue = value;
            continue;
        }
        if (pattern.length > winnerPattern.length ||
            (pattern.length === winnerPattern.length && pattern < winnerPattern)) {
            winnerPattern = pattern;
            winnerValue = value;
        }
    }
    return winnerValue;
};
/**
 * True iff the resolved readControls entry permits the given CaptureKind.
 * Missing flag = allowed (no restriction); explicit `false` denies. Undefined
 * control (no matching readControls entry) = allowed.
 */
const isKindAllowedByReadControls = (kind, control) => control?.[kind] !== false;
/**
 * True iff the per-kind capture.filters predicate (if configured) accepts the
 * event. No filter for the resolved kind => allow. compileSourceFilter ok:false
 * (malformed regex despite the schema validator) => fail-open (allow) so a
 * single bad filter cannot suppress all events of a kind.
 */
const passesCaptureFilter = (event, captureKind, filters) => {
    const spec = filters[captureKind];
    if (spec === undefined)
        return true;
    const compiled = compileSourceFilter(spec);
    if (!compiled.ok)
        return true;
    return compiled.predicate(event);
};
const shouldCaptureEvent = (event, settings) => {
    if (!isKindEnabled(event.kind, settings['capture.enabledKinds'])) {
        return false;
    }
    if (!isUrlAllowed(event.frameUrl, settings['sites.allowlist'], settings['sites.blocklist'])) {
        return false;
    }
    const captureKind = eventKindToCaptureKind(event.kind);
    if (captureKind === null)
        return true; // unknown raw kinds default-allow
    const control = pickMostSpecificReadControl(event.frameUrl, settings['sites.readControls']);
    if (!isKindAllowedByReadControls(captureKind, control))
        return false;
    return passesCaptureFilter(event, captureKind, settings['capture.filters']);
};

const isSettingsEventMessage = (msg) => {
    if (msg === null || typeof msg !== 'object')
        return false;
    const m = msg;
    return (m['type'] === 'event' &&
        (m['tool'] === 'settings_snapshot' || m['tool'] === 'settings_changed'));
};
const HOST_NAME = 'com.pwa_debug.host';
const CAPTURES_EVENT_TOOL = 'captures';
const installEventSinkListener = (sink) => {
    chrome.runtime.onMessage.addListener((msg, sender) => {
        if (!isPageEventSwMessage(msg))
            return;
        sink.handle(attachFrameId(msg.event, sender.frameId));
    });
};
const logSetupHint = (extId, errorMessage) => {
    const reason = errorMessage ? `: ${errorMessage}` : '';
    console.warn(`[pwa-debug/sw] native host not registered for this extension${reason}\n` +
        `[pwa-debug/sw] To register, ask Claude (or any MCP client) to call:\n` +
        `[pwa-debug/sw]   mcp__pwa_debug__host_register_extension { extension_id: "${extId}" }\n` +
        `[pwa-debug/sw] Then reload this extension at chrome://extensions and the connect will retry.`);
};
const connectNativeHost = (sink, portRef, settingsCache) => {
    const extId = chrome.runtime.id;
    console.log(`[pwa-debug/sw] connecting to native host: ${HOST_NAME}`);
    let port;
    try {
        port = chrome.runtime.connectNative(HOST_NAME);
    }
    catch (e) {
        logSetupHint(extId, e.message);
        return;
    }
    portRef.current = port;
    port.onMessage.addListener((msg) => {
        if (isSwRequestEnvelope(msg)) {
            routeRequest(msg, { sink }).then((response) => {
                try {
                    port.postMessage(response);
                }
                catch (err) {
                    console.warn('[pwa-debug/sw] postMessage failed:', err.message);
                }
            }, (err) => {
                console.warn('[pwa-debug/sw] routeRequest rejected (should not happen):', err.message);
            });
            return;
        }
        if (isSettingsEventMessage(msg)) {
            if (msg.tool === 'settings_snapshot') {
                const r = settingsCache.applySnapshot(msg.payload);
                console.log(`[pwa-debug/sw] settings_snapshot applied (${r.applied} keys)`);
            }
            else {
                const r = settingsCache.applyChange(msg.payload);
                if (!r.applied) {
                    console.warn('[pwa-debug/sw] settings_changed dropped (invalid payload):', msg.payload);
                }
            }
            return;
        }
        console.log('[pwa-debug/sw] from host:', msg);
    });
    port.onDisconnect.addListener(() => {
        portRef.current = null;
        const err = chrome.runtime.lastError;
        const msg = err?.message ?? '';
        if (/not found|forbidden|access/i.test(msg)) {
            logSetupHint(extId, msg);
        }
        else if (msg.length > 0) {
            console.log('[pwa-debug/sw] native port disconnected:', msg);
        }
        else {
            console.log('[pwa-debug/sw] native port disconnected (clean)');
        }
    });
};
const bootstrap = () => {
    chrome.runtime.onInstalled.addListener((details) => {
        console.log('[pwa-debug/sw] installed:', details.reason);
    });
    console.log(`[pwa-debug/sw] id=${chrome.runtime.id}`);
    console.log('[pwa-debug/sw] up');
    const portRef = { current: null };
    const extensionId = chrome.runtime.id;
    const sendEventEnvelope = (events) => {
        const port = portRef.current;
        if (port === null)
            return;
        try {
            port.postMessage({
                type: 'event',
                tool: CAPTURES_EVENT_TOOL,
                extensionId,
                payload: { events },
            });
        }
        catch (err) {
            console.warn('[pwa-debug/sw] event flush postMessage failed:', err.message);
        }
    };
    const settingsCache = createSettingsCache();
    const sink = createEventSink({
        logger: (event) => {
            console.log('[pwa-debug/sw] event', event.kind, event);
        },
        forwardEvents: sendEventEnvelope,
        // Re-reads settings on every event so live host pushes (T3) take effect
        // without an extension reload (M7 acceptance).
        shouldRecord: (event) => shouldCaptureEvent(event, settingsCache.getAll()),
    });
    installEventSinkListener(sink);
    createSwLifecycleProducer({ sink });
    connectNativeHost(sink, portRef, settingsCache);
};
bootstrap();

export { bootstrap };
//# sourceMappingURL=service-worker.js.map
