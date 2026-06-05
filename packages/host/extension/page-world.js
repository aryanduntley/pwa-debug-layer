var PwaDebugPageWorld = (function (exports) {
    'use strict';

    const PAGE_BRIDGE_NS = 'pwa-debug';
    const encodeResponse = (input) => {
        const base = {
            ns: PAGE_BRIDGE_NS,
            dir: 'page->cs',
            requestId: input.requestId,
        };
        if (input.payload !== undefined)
            base.payload = input.payload;
        if (input.error !== undefined) {
            base.error = Object.freeze({ message: input.error.message });
        }
        return Object.freeze(base);
    };
    const isPageBridgeNs = (v) => v === PAGE_BRIDGE_NS;
    const isInboundCsToPage = (event) => {
        if (event.source !== window)
            return false;
        const data = event.data;
        if (data === null || typeof data !== 'object')
            return false;
        const r = data;
        return (isPageBridgeNs(r['ns']) &&
            r['dir'] === 'cs->page' &&
            typeof r['requestId'] === 'string' &&
            typeof r['tool'] === 'string');
    };
    const encodeEvent = (event) => Object.freeze({
        ns: PAGE_BRIDGE_NS,
        dir: 'page-event',
        event,
    });

    const DEFAULT_MAX_BYTES = 16_384;
    const tagDomNode = (n) => {
        const el = n;
        const id = typeof el.id === 'string' && el.id.length > 0 ? el.id : undefined;
        return id === undefined
            ? { __type: 'DOMNode', nodeName: n.nodeName }
            : { __type: 'DOMNode', nodeName: n.nodeName, id };
    };
    const tagError = (e) => e.stack === undefined
        ? { __type: 'Error', name: e.name, message: e.message }
        : { __type: 'Error', name: e.name, message: e.message, stack: e.stack };
    const serializeValue = (value, seen) => {
        if (value === null)
            return null;
        const t = typeof value;
        if (t === 'undefined')
            return undefined;
        if (t === 'string' || t === 'boolean')
            return value;
        if (t === 'number')
            return Number.isFinite(value) ? value : String(value);
        if (t === 'bigint')
            return `${value.toString()}n`;
        if (t === 'symbol')
            return value.toString();
        if (t === 'function') {
            const name = value.name;
            return name !== undefined && name.length > 0
                ? { __type: 'Function', name }
                : { __type: 'Function' };
        }
        if (t !== 'object')
            return String(value);
        const obj = value;
        if (seen.has(obj))
            return { __type: 'Cycle' };
        seen.add(obj);
        if (typeof Node !== 'undefined' && obj instanceof Node)
            return tagDomNode(obj);
        if (obj instanceof Error)
            return tagError(obj);
        if (typeof Promise !== 'undefined' && obj instanceof Promise) {
            return { __type: 'Promise' };
        }
        if (Array.isArray(obj)) {
            return obj.map((item) => serializeValue(item, seen));
        }
        const out = {};
        for (const key of Object.keys(obj)) {
            out[key] = serializeValue(obj[key], seen);
        }
        return out;
    };
    const approxByteSize = (v) => {
        try {
            return JSON.stringify(v)?.length ?? 0;
        }
        catch {
            return Number.POSITIVE_INFINITY;
        }
    };
    const serializeArgs$1 = (args, opts) => {
        const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
        let truncated = false;
        const serialized = args.map((arg) => {
            const walked = serializeValue(arg, new WeakSet());
            const size = approxByteSize(walked);
            if (size > maxBytes) {
                truncated = true;
                return {
                    __type: 'Truncated',
                    approxSize: size,
                    max: maxBytes,
                };
            }
            return walked;
        });
        return { serialized, truncated };
    };

    const REACT_FIBER_KEY_PREFIX = '__reactFiber$';
    const REACT_CONTAINER_KEY_PREFIX = '__reactContainer$';

    const hasContainerKey = (el) => {
        for (const key of Object.keys(el)) {
            if (key.startsWith(REACT_CONTAINER_KEY_PREFIX))
                return true;
        }
        return false;
    };
    const findReactRoots = (doc) => {
        const roots = [];
        const all = doc.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (el !== undefined && hasContainerKey(el))
                roots.push(el);
        }
        return roots;
    };

    const HOST_ROOT_TAG$2 = 3;
    const readKeyValue = (el, prefix) => {
        let keys;
        try {
            keys = Object.keys(el);
        }
        catch {
            return undefined;
        }
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (key === undefined)
                continue;
            if (!key.startsWith(prefix))
                continue;
            try {
                return el[key];
            }
            catch {
                return undefined;
            }
        }
        return undefined;
    };
    const climbToHostRoot = (fiber) => {
        if (fiber.tag === HOST_ROOT_TAG$2)
            return fiber;
        let cursor = fiber.return;
        while (cursor !== null) {
            if (cursor.tag === HOST_ROOT_TAG$2)
                return cursor;
            cursor = cursor.return;
        }
        return undefined;
    };
    const isFiberLike = (value) => typeof value === 'object' &&
        value !== null &&
        typeof value.tag === 'number';
    // Resolve the committed HostRoot fiber from a value attached under
    // __reactContainer$*. That value can be either:
    //   (a) a FiberRoot — { current } points at the HostRoot fiber (the shape
    //       earlier notes assumed; still produced by some paths/synthetic tests); or
    //   (b) the HostRoot fiber itself — what React 18 `createRoot` actually
    //       attaches. Under React's double-buffering the directly-attached fiber
    //       may be the work-in-progress/alternate copy with no child; the committed
    //       tree lives at fiber.stateNode.current (i.e. FiberRoot.current).
    // (c) falls back to treating a bare fiber-like value as the root directly
    //     (legacy / synthetic). A non-fiber object (e.g. {}) yields undefined so
    //     it is never handed to climbToHostRoot.
    const resolveHostRoot = (value) => {
        if (value === null || value === undefined)
            return undefined;
        const v = value;
        const current = v.current;
        if (current !== null && current !== undefined) {
            return climbToHostRoot(current);
        }
        const committed = v.stateNode != null ? v.stateNode.current : undefined;
        if (committed !== null && committed !== undefined) {
            return climbToHostRoot(committed);
        }
        if (isFiberLike(value)) {
            return climbToHostRoot(value);
        }
        return undefined;
    };
    const hasChildFiber = (fiber) => fiber !== undefined &&
        fiber.child !== null &&
        fiber.child !== undefined;
    // Strategy 3 (most defect-resistant): climb to the HostRoot from the first
    // descendant host node carrying a __reactFiber$* back-pointer. React sets
    // __reactFiber$ on *mounted* host nodes, so this path is always rooted in the
    // committed tree — it corroborates / falls back from the container-key
    // strategies when those land on a stale or double-buffered alternate.
    // Guarded so synthetic (non-DOM) test elements simply skip it.
    const rootFromDescendantFiber = (rootEl) => {
        let nodes;
        try {
            if (typeof rootEl.querySelectorAll !== 'function')
                return undefined;
            nodes = rootEl.querySelectorAll('*');
        }
        catch {
            return undefined;
        }
        const limit = Math.min(nodes.length, 50);
        for (let i = 0; i < limit; i++) {
            const node = nodes[i];
            if (node === undefined)
                continue;
            const fiber = readKeyValue(node, REACT_FIBER_KEY_PREFIX);
            if (fiber !== undefined && fiber !== null) {
                const host = climbToHostRoot(fiber);
                if (host !== undefined)
                    return host;
            }
        }
        return undefined;
    };
    // Resolve the HostRoot via three independent strategies and prefer whichever
    // yields a *walkable* tree. A HostRoot with no child is the known-defective
    // outcome (e.g. React 18's double-buffered alternate attached under
    // __reactContainer$) — discard it in favour of a strategy that produces a
    // real subtree. Tie-break order container > fiber-key > descendant preserves
    // behaviour for genuinely childless / synthetic-test roots.
    const getRootFiber = (rootEl) => {
        const fromContainer = resolveHostRoot(readKeyValue(rootEl, REACT_CONTAINER_KEY_PREFIX));
        const fiberKeyValue = readKeyValue(rootEl, REACT_FIBER_KEY_PREFIX);
        const fromFiberKey = fiberKeyValue !== undefined && fiberKeyValue !== null
            ? climbToHostRoot(fiberKeyValue)
            : undefined;
        const fromDescendant = rootFromDescendantFiber(rootEl);
        const ordered = [fromContainer, fromFiberKey, fromDescendant];
        for (const candidate of ordered) {
            if (hasChildFiber(candidate))
                return candidate;
        }
        for (const candidate of ordered) {
            if (candidate !== undefined)
                return candidate;
        }
        return undefined;
    };

    const HOST_ROOT_TAG$1 = 3;
    const HOST_COMPONENT_TAG$2 = 5;
    const HOST_TEXT_TAG = 6;
    const FRAGMENT_TAG = 7;
    const nameFromType = (type) => {
        if (type === null || type === undefined)
            return undefined;
        if (typeof type === 'object' || typeof type === 'function') {
            const obj = type;
            if (typeof obj.displayName === 'string' && obj.displayName.length > 0) {
                return obj.displayName;
            }
            if (typeof obj.name === 'string' && obj.name.length > 0) {
                return obj.name;
            }
        }
        return undefined;
    };
    const unwrapMemo = (type) => {
        if (type !== null && typeof type === 'object' && 'type' in type) {
            return type.type;
        }
        return undefined;
    };
    const unwrapForwardRef = (type) => {
        if (type !== null && typeof type === 'object' && 'render' in type) {
            return type.render;
        }
        return undefined;
    };
    const isMemoWrapper = (type) => type !== null && typeof type === 'object' && 'type' in type && !('render' in type);
    const isForwardRefWrapper = (type) => type !== null && typeof type === 'object' && 'render' in type;
    const extractDisplayName$1 = (fiber) => {
        switch (fiber.tag) {
            case HOST_ROOT_TAG$1:
                return 'HostRoot';
            case HOST_COMPONENT_TAG$2:
                return typeof fiber.type === 'string' ? fiber.type : 'HostComponent';
            case HOST_TEXT_TAG:
                return 'Text';
            case FRAGMENT_TAG:
                return 'Fragment';
        }
        const direct = nameFromType(fiber.type);
        if (direct !== undefined)
            return direct;
        if (isForwardRefWrapper(fiber.type)) {
            const inner = unwrapForwardRef(fiber.type);
            const innerName = nameFromType(inner) ?? 'Anonymous';
            return `ForwardRef(${innerName})`;
        }
        if (isMemoWrapper(fiber.type)) {
            const inner = unwrapMemo(fiber.type);
            if (isForwardRefWrapper(inner)) {
                const innerInner = unwrapForwardRef(inner);
                const innerName = nameFromType(innerInner) ?? 'Anonymous';
                return `Memo(ForwardRef(${innerName}))`;
            }
            const innerName = nameFromType(inner) ?? 'Anonymous';
            return `Memo(${innerName})`;
        }
        return 'Anonymous';
    };

    const extractKey$1 = (fiber) => {
        const key = fiber.key;
        if (key === null)
            return undefined;
        if (typeof key !== 'string')
            return undefined;
        if (key.length === 0)
            return undefined;
        return key;
    };

    // 0-based occurrence index of an unkeyed fiber among its prior UNKEYED
    // siblings that share the same extractDisplayName. This is the exact inverse
    // of resolve_stable_id.childAtIndex's predicate
    // (extractKey === undefined && extractDisplayName === name), so
    // computeStableId's unkeyed discriminator round-trips with resolveStableId on
    // real heterogeneous sibling sets. Returns 0 for a parentless fiber or one
    // unreachable in the parent.child chain (malformed tree) — matching the prior
    // max(siblingPosition, 0) floor for those cases.
    const unkeyedOccurrence$1 = (fiber) => {
        const parent = fiber.return;
        if (parent === null)
            return 0;
        const name = extractDisplayName$1(fiber);
        let occurrence = 0;
        let cursor = parent.child;
        while (cursor !== null) {
            if (cursor === fiber)
                return occurrence;
            if (extractKey$1(cursor) === undefined && extractDisplayName$1(cursor) === name) {
                occurrence += 1;
            }
            cursor = cursor.sibling;
        }
        return 0;
    };

    const HOST_ROOT_TAG = 3;
    const segmentFor$1 = (fiber) => {
        const name = extractDisplayName$1(fiber);
        const key = extractKey$1(fiber);
        const discriminator = key ?? String(unkeyedOccurrence$1(fiber));
        return `${name}[${discriminator}]`;
    };
    const computeStableId$1 = (fiber, rootIndex = 0) => {
        const segments = [];
        let cursor = fiber;
        while (cursor !== null && cursor.tag !== HOST_ROOT_TAG) {
            segments.unshift(segmentFor$1(cursor));
            cursor = cursor.return;
        }
        segments.unshift(`root${rootIndex}`);
        return segments.join('/');
    };

    const DEFAULT_DEPTH_LIMIT$1 = 8;
    const DEFAULT_MAX_NODES$1 = 200;
    const CLASS_COMPONENT_TAG$1 = 1;
    const FUNCTION_COMPONENT_TAG$1 = 0;
    const FORWARD_REF_TAG$1 = 11;
    const MEMO_COMPONENT_TAG$1 = 14;
    const hasStateFor = (fiber) => fiber.tag === CLASS_COMPONENT_TAG$1 && fiber.memoizedState !== null;
    const hasHooksFor = (fiber) => {
        if (fiber.memoizedState === null)
            return false;
        return (fiber.tag === FUNCTION_COMPONENT_TAG$1 ||
            fiber.tag === FORWARD_REF_TAG$1 ||
            fiber.tag === MEMO_COMPONENT_TAG$1);
    };
    const serializeNode$2 = (fiber, rootIndex, depth, depthLimit, state, maxNodes) => {
        if (state.nodesEmitted >= maxNodes) {
            state.truncated = true;
            return undefined;
        }
        state.nodesEmitted += 1;
        const children = [];
        if (depth < depthLimit) {
            let cursor = fiber.child;
            while (cursor !== null) {
                const childNode = serializeNode$2(cursor, rootIndex, depth + 1, depthLimit, state, maxNodes);
                if (childNode === undefined)
                    break;
                children.push(childNode);
                cursor = cursor.sibling;
            }
        }
        else if (fiber.child !== null) {
            state.truncated = true;
        }
        const key = extractKey$1(fiber);
        const node = {
            stableId: computeStableId$1(fiber, rootIndex),
            displayName: extractDisplayName$1(fiber),
            ...(key !== undefined ? { key } : {}),
            hasState: hasStateFor(fiber),
            hasHooks: hasHooksFor(fiber),
            children,
        };
        return node;
    };
    const serializeTree = (doc, options = {}) => {
        const rootEls = findReactRoots(doc);
        const rootCount = rootEls.length;
        const depthLimit = options.depthLimit ?? DEFAULT_DEPTH_LIMIT$1;
        const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES$1;
        const selectedIndices = options.rootIndex === undefined
            ? rootEls.map((_, i) => i)
            : options.rootIndex >= 0 && options.rootIndex < rootCount
                ? [options.rootIndex]
                : [];
        const state = { nodesEmitted: 0, truncated: false };
        const roots = [];
        for (const i of selectedIndices) {
            const rootEl = rootEls[i];
            if (rootEl === undefined)
                continue;
            const rootFiber = getRootFiber(rootEl);
            if (rootFiber === undefined)
                continue;
            const node = serializeNode$2(rootFiber, i, 0, depthLimit, state, maxNodes);
            if (node !== undefined)
                roots.push(node);
            if (state.nodesEmitted >= maxNodes)
                break;
        }
        return { roots, truncated: state.truncated, rootCount };
    };

    const ROOT_SEGMENT$1 = /^root(\d+)$/;
    const CHILD_SEGMENT$1 = /^(.+)\[(.*)\]$/;
    const isNumericString$1 = (s) => s.length > 0 && /^\d+$/.test(s);
    const childAtIndex$1 = (parent, name, index) => {
        let cursor = parent.child;
        let matchedCount = 0;
        while (cursor !== null) {
            if (extractKey$1(cursor) === undefined && extractDisplayName$1(cursor) === name) {
                if (matchedCount === index)
                    return cursor;
                matchedCount += 1;
            }
            cursor = cursor.sibling;
        }
        return undefined;
    };
    const childByKey$1 = (parent, name, key) => {
        let cursor = parent.child;
        while (cursor !== null) {
            if (extractDisplayName$1(cursor) === name && extractKey$1(cursor) === key)
                return cursor;
            cursor = cursor.sibling;
        }
        return undefined;
    };
    const resolveStableId$1 = (stableId, roots) => {
        const segments = stableId.split('/');
        if (segments.length === 0)
            return undefined;
        const head = segments[0];
        if (head === undefined)
            return undefined;
        const rootMatch = ROOT_SEGMENT$1.exec(head);
        if (rootMatch === null)
            return undefined;
        const rootIndexStr = rootMatch[1];
        if (rootIndexStr === undefined)
            return undefined;
        const rootIndex = Number.parseInt(rootIndexStr, 10);
        if (rootIndex < 0 || rootIndex >= roots.length)
            return undefined;
        const rootEl = roots[rootIndex];
        if (rootEl === undefined)
            return undefined;
        const rootFiber = getRootFiber(rootEl);
        if (rootFiber === undefined)
            return undefined;
        let current = rootFiber;
        for (let i = 1; i < segments.length; i++) {
            const seg = segments[i];
            if (seg === undefined)
                return undefined;
            const m = CHILD_SEGMENT$1.exec(seg);
            if (m === null)
                return undefined;
            const name = m[1];
            const discriminator = m[2];
            if (name === undefined || discriminator === undefined)
                return undefined;
            // A numeric discriminator is ambiguous: it can be a numeric React key
            // (e.g. <li key={1}> -> 'li[1]') OR a per-name unkeyed-occurrence index
            // (computeStableId via unkeyedOccurrence). Try the keyed child first,
            // then fall back to the unkeyed-occurrence child. Residual ambiguity
            // (a parent with BOTH a child keyed 'N' and an unkeyed same-name child
            // at occurrence N) is a documented known limitation — keyed wins.
            const next = isNumericString$1(discriminator)
                ? (childByKey$1(current, name, discriminator) ??
                    childAtIndex$1(current, name, Number.parseInt(discriminator, 10)))
                : childByKey$1(current, name, discriminator);
            if (next === undefined)
                return undefined;
            current = next;
        }
        return current;
    };

    const isObject = (v) => v !== null && typeof v === 'object';
    const isEffectShape = (v) => {
        if (!isObject(v))
            return false;
        return ('tag' in v &&
            'create' in v &&
            'destroy' in v &&
            'deps' in v);
    };
    const isMemoTuple = (v) => {
        if (!Array.isArray(v))
            return false;
        if (v.length !== 2)
            return false;
        return Array.isArray(v[1]) || v[1] === null;
    };
    const isRefShape = (v) => {
        if (!isObject(v))
            return false;
        if (!('current' in v))
            return false;
        for (const k of Object.keys(v)) {
            if (k !== 'current')
                return false;
        }
        return true;
    };
    const isHookNode = (v) => isObject(v) && 'memoizedState' in v && 'next' in v;
    const classify = (node) => {
        if (node.queue !== null && node.queue !== undefined) {
            return { type: 'state', value: node.memoizedState, hasValue: true, hasDeps: false };
        }
        if (isEffectShape(node.memoizedState)) {
            const m = node.memoizedState;
            return { type: 'effect', hasValue: false, deps: m['deps'], hasDeps: true };
        }
        if (isMemoTuple(node.memoizedState)) {
            const tuple = node.memoizedState;
            return {
                type: 'memo',
                value: tuple[0],
                hasValue: true,
                deps: tuple[1],
                hasDeps: true,
            };
        }
        if (isRefShape(node.memoizedState)) {
            const r = node.memoizedState;
            return { type: 'ref', value: r.current, hasValue: true, hasDeps: false };
        }
        return { type: 'custom', value: node.memoizedState, hasValue: true, hasDeps: false };
    };
    const isTruncatedTag = (v) => isObject(v) && v['__type'] === 'Truncated';
    const extractHooks = (fiber) => {
        const head = fiber.memoizedState;
        if (!isHookNode(head))
            return [];
        const result = [];
        let cursor = head;
        let index = 0;
        while (cursor !== null) {
            const c = classify(cursor);
            const payload = [];
            if (c.hasValue)
                payload.push(c.value);
            if (c.hasDeps)
                payload.push(c.deps);
            const ser = payload.length > 0 ? serializeArgs$1(payload) : { serialized: [], truncated: false };
            const entry = { type: c.type, index };
            let i = 0;
            if (c.hasValue) {
                entry.value = ser.serialized[i];
                i += 1;
            }
            if (c.hasDeps) {
                entry.deps = ser.serialized[i];
            }
            const anyTruncated = ser.truncated ||
                (c.hasValue && isTruncatedTag(entry.value)) ||
                (c.hasDeps && isTruncatedTag(entry.deps));
            if (anyTruncated)
                entry.truncated = true;
            result.push(entry);
            const next = cursor.next;
            cursor = isHookNode(next) ? next : null;
            index += 1;
        }
        return result;
    };

    const CLASS_COMPONENT_TAG = 1;
    const FUNCTION_COMPONENT_TAG = 0;
    const FORWARD_REF_TAG = 11;
    const MEMO_COMPONENT_TAG = 14;
    const serializeField$1 = (value) => {
        const r = serializeArgs$1([value]);
        return { value: r.serialized[0], truncated: r.truncated };
    };
    const isHooksFiber = (fiber) => fiber.tag === FUNCTION_COMPONENT_TAG ||
        fiber.tag === FORWARD_REF_TAG ||
        fiber.tag === MEMO_COMPONENT_TAG;
    const serializeComponent = (fiber, rootIndex = 0, options = {}) => {
        const includeProps = options.includeProps !== false;
        const includeHooks = options.includeHooks !== false;
        const stableId = computeStableId$1(fiber, rootIndex);
        const displayName = extractDisplayName$1(fiber);
        const key = extractKey$1(fiber);
        let props;
        let propsTruncated = false;
        if (includeProps && fiber.memoizedProps !== null && fiber.memoizedProps !== undefined) {
            const ser = serializeField$1(fiber.memoizedProps);
            props = ser.value;
            propsTruncated = ser.truncated;
        }
        let state;
        let stateTruncated = false;
        if (fiber.tag === CLASS_COMPONENT_TAG &&
            fiber.memoizedState !== null &&
            fiber.memoizedState !== undefined) {
            const ser = serializeField$1(fiber.memoizedState);
            state = ser.value;
            stateTruncated = ser.truncated;
        }
        let hooks;
        let hooksTruncated = false;
        if (includeHooks && isHooksFiber(fiber)) {
            hooks = extractHooks(fiber);
            hooksTruncated = hooks.some((h) => h.truncated === true);
        }
        const truncated = propsTruncated || stateTruncated || hooksTruncated;
        return {
            stableId,
            displayName,
            ...(key !== undefined ? { key } : {}),
            ...(props !== undefined ? { props } : {}),
            ...(state !== undefined ? { state } : {}),
            ...(hooks !== undefined ? { hooks } : {}),
            ...(truncated ? { truncated: true } : {}),
        };
    };

    const visit = (fiber, depth, visitor) => {
        const result = visitor(fiber, depth);
        if (result !== false && fiber.child !== null)
            visit(fiber.child, depth + 1, visitor);
        if (fiber.sibling !== null)
            visit(fiber.sibling, depth, visitor);
    };
    const walkFiber = (fiber, visitor) => {
        const result = visitor(fiber, 0);
        if (result === false)
            return;
        if (fiber.child !== null)
            visit(fiber.child, 1, visitor);
    };

    /**
     * Framework-agnostic DOM/ARIA selector primitives, extracted from react/find.ts
     * once findByRole gained a second caller (Vue). Pure DOM reads — no React, no
     * Vue, no chrome.*. react/find.ts re-exports these for its existing importers;
     * vue/find_by_role imports them directly.
     */
    const explicitRole = (el) => {
        const attr = el.getAttribute('role');
        if (attr === null)
            return undefined;
        const token = attr.trim().split(/\s+/)[0];
        return token !== undefined && token.length > 0 ? token : undefined;
    };
    const inputRole = (el) => {
        const type = (el.getAttribute('type') ?? 'text').toLowerCase();
        switch (type) {
            case 'checkbox':
                return 'checkbox';
            case 'radio':
                return 'radio';
            case 'button':
            case 'submit':
            case 'reset':
            case 'image':
                return 'button';
            case 'search':
                return 'searchbox';
            case 'number':
                return 'spinbutton';
            case 'range':
                return 'slider';
            default:
                return 'textbox';
        }
    };
    /**
     * Map a DOM Element to its ARIA role. An explicit `role` attribute always wins;
     * otherwise an implicit role is derived from the element's tag (a simplified
     * WAI-ARIA subset covering the common interactive/landmark/heading cases —
     * NOT the full host-language role mapping). Returns undefined when no role
     * applies (e.g. <a> without href, <div>, unmapped tags).
     */
    const implicitRoleForElement = (el) => {
        const explicit = explicitRole(el);
        if (explicit !== undefined)
            return explicit;
        const tag = el.tagName.toLowerCase();
        switch (tag) {
            case 'button':
                return 'button';
            case 'a':
            case 'area':
                return el.hasAttribute('href') ? 'link' : undefined;
            case 'h1':
            case 'h2':
            case 'h3':
            case 'h4':
            case 'h5':
            case 'h6':
                return 'heading';
            case 'nav':
                return 'navigation';
            case 'main':
                return 'main';
            case 'header':
                return 'banner';
            case 'footer':
                return 'contentinfo';
            case 'aside':
                return 'complementary';
            case 'section':
                return 'region';
            case 'article':
                return 'article';
            case 'form':
                return 'form';
            case 'input':
                return inputRole(el);
            case 'textarea':
                return 'textbox';
            case 'select':
                return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
            case 'img':
                return 'img';
            case 'ul':
            case 'ol':
                return 'list';
            case 'li':
                return 'listitem';
            case 'table':
                return 'table';
            case 'progress':
                return 'progressbar';
            case 'output':
                return 'status';
            default:
                return undefined;
        }
    };
    /**
     * Simplified ARIA accessible-name computation: aria-label, then the resolved
     * text of the first aria-labelledby id reference, then the element's trimmed
     * textContent. This is intentionally NOT the full computed-name algorithm
     * (no recursion, no value/placeholder/title fallbacks, no multi-id labelledby);
     * sufficient for selector matching. Returns undefined when no name.
     */
    const computeAccessibleName = (el) => {
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel !== null) {
            const trimmed = ariaLabel.trim();
            if (trimmed.length > 0)
                return trimmed;
        }
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy !== null) {
            const id = labelledBy.trim().split(/\s+/)[0];
            if (id !== undefined && id.length > 0) {
                const ref = el.ownerDocument?.getElementById(id);
                const refText = ref?.textContent?.trim();
                if (refText !== undefined && refText.length > 0)
                    return refText;
            }
        }
        const text = el.textContent?.trim();
        return text !== undefined && text.length > 0 ? text : undefined;
    };

    const HOST_COMPONENT_TAG$1 = 5;
    const isElement$7 = (node) => node !== null &&
        typeof node === 'object' &&
        node.nodeType === 1;
    /**
     * Generic predicate-driven fiber walk shared by react.findByText and
     * react.findByRole. Walks each root subtree (reusing the walkFiber primitive),
     * and for every HostComponent fiber whose stateNode is a DOM Element, invokes
     * filterFn(fiber, hostNode); matches are collected until maxMatches is reached.
     *
     * Pure: no DOM mutation, no side effects beyond the returned arrays.
     */
    const walkAndFilter = (roots, filterFn, options = {}) => {
        const cap = options.maxMatches;
        const matches = [];
        let truncated = false;
        for (const root of roots) {
            walkFiber(root, (fiber) => {
                if (cap !== undefined && matches.length >= cap) {
                    truncated = true;
                    return false;
                }
                if (fiber.tag !== HOST_COMPONENT_TAG$1)
                    return;
                const node = fiber.stateNode;
                if (!isElement$7(node))
                    return;
                if (filterFn(fiber, node))
                    matches.push({ fiber, hostNode: node });
                return;
            });
        }
        return { matches, truncated };
    };

    const DEFAULT_MAX_MATCHES$4 = 20;
    /**
     * Find React HostComponent fibers whose host node's (trimmed) textContent
     * matches a regex. Composes the M22 walkAndFilter primitive once per selected
     * React root so each match can be assigned the correct root-scoped stableId
     * via computeStableId — the same root resolution + rootIndex scoping pattern
     * serializeTree uses (deferred from find.ts per the M22 T1 decision note).
     *
     * pattern is a pre-compiled RegExp (the page-world handler owns compilation +
     * regex-error shaping) so this function is pure and never throws.
     */
    const findByText = (doc, pattern, options = {}) => {
        const rootEls = findReactRoots(doc);
        const rootCount = rootEls.length;
        const exact = options.exact === true;
        const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES$4;
        const selectedIndices = options.rootIndex === undefined
            ? rootEls.map((_, i) => i)
            : options.rootIndex >= 0 && options.rootIndex < rootCount
                ? [options.rootIndex]
                : [];
        const matches = [];
        let truncated = false;
        for (const i of selectedIndices) {
            if (matches.length >= maxMatches) {
                truncated = true;
                break;
            }
            const rootEl = rootEls[i];
            if (rootEl === undefined)
                continue;
            const rootFiber = getRootFiber(rootEl);
            if (rootFiber === undefined)
                continue;
            const matchedTexts = new Map();
            const result = walkAndFilter([rootFiber], (fiber, hostNode) => {
                const text = (hostNode.textContent ?? '').trim();
                if (text.length === 0)
                    return false;
                const m = pattern.exec(text);
                if (m === null)
                    return false;
                if (exact && m[0] !== text)
                    return false;
                matchedTexts.set(fiber, exact ? text : m[0]);
                return true;
            }, { maxMatches: maxMatches - matches.length });
            for (const fm of result.matches) {
                const key = extractKey$1(fm.fiber);
                matches.push(Object.freeze({
                    stableId: computeStableId$1(fm.fiber, i),
                    displayName: extractDisplayName$1(fm.fiber),
                    ...(key !== undefined ? { key } : {}),
                    matchedText: matchedTexts.get(fm.fiber) ?? '',
                }));
            }
            if (result.truncated)
                truncated = true;
        }
        return Object.freeze({ matches, truncated, rootCount });
    };

    const DEFAULT_MAX_MATCHES$3 = 20;
    /**
     * Find React HostComponent fibers whose host node has a given ARIA role
     * (explicit role attribute or the simplified implicit-role mapping), optionally
     * narrowed by an accessible-name regex. Mirrors findByText's root resolution +
     * per-root walkAndFilter composition so each match gets the correct
     * root-scoped stableId. nameRe is a pre-compiled RegExp (the page-world
     * handler owns compilation + regex-error shaping) so this stays pure.
     */
    const findByRole = (doc, role, nameRe, options = {}) => {
        const rootEls = findReactRoots(doc);
        const rootCount = rootEls.length;
        const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES$3;
        const selectedIndices = options.rootIndex === undefined
            ? rootEls.map((_, i) => i)
            : options.rootIndex >= 0 && options.rootIndex < rootCount
                ? [options.rootIndex]
                : [];
        const matches = [];
        let truncated = false;
        for (const i of selectedIndices) {
            if (matches.length >= maxMatches) {
                truncated = true;
                break;
            }
            const rootEl = rootEls[i];
            if (rootEl === undefined)
                continue;
            const rootFiber = getRootFiber(rootEl);
            if (rootFiber === undefined)
                continue;
            const names = new Map();
            const result = walkAndFilter([rootFiber], (fiber, hostNode) => {
                if (implicitRoleForElement(hostNode) !== role)
                    return false;
                const accName = computeAccessibleName(hostNode);
                if (nameRe !== undefined) {
                    if (accName === undefined || !nameRe.test(accName))
                        return false;
                }
                names.set(fiber, accName);
                return true;
            }, { maxMatches: maxMatches - matches.length });
            for (const fm of result.matches) {
                const key = extractKey$1(fm.fiber);
                const name = names.get(fm.fiber);
                matches.push(Object.freeze({
                    stableId: computeStableId$1(fm.fiber, i),
                    displayName: extractDisplayName$1(fm.fiber),
                    ...(key !== undefined ? { key } : {}),
                    role,
                    ...(name !== undefined ? { name } : {}),
                }));
            }
            if (result.truncated)
                truncated = true;
        }
        return Object.freeze({ matches, truncated, rootCount });
    };

    // Framework-agnostic element resolution strategies.
    //
    // Role and text matching are pure DOM/ARIA concerns — the same dom_aria
    // predicates react.findByRole and vue.findByRole already share — so the locator
    // applies them across the whole document regardless of framework. Only stableId
    // (see stable_id.ts) needs per-framework dispatch.
    /** All elements matching a CSS selector; [] on an invalid selector. */
    const bySelector = (doc, selector) => {
        try {
            return Array.from(doc.querySelectorAll(selector));
        }
        catch {
            return [];
        }
    };
    /** Elements whose ARIA role equals `role`, optionally narrowed by a name regex. */
    const byRole = (doc, role, nameRe) => {
        const out = [];
        const all = doc.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (el === undefined)
                continue;
            if (implicitRoleForElement(el) !== role)
                continue;
            if (nameRe !== undefined) {
                const accName = computeAccessibleName(el);
                if (accName === undefined || !nameRe.test(accName))
                    continue;
            }
            out.push(el);
        }
        return out;
    };
    /**
     * Leaf-most elements whose OWN direct text-node content matches `re`. Matching
     * on direct text (not textContent) avoids also selecting every ancestor that
     * merely contains the text deeper in its subtree.
     */
    const byText = (doc, re) => {
        const out = [];
        const all = doc.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (el === undefined)
                continue;
            let direct = '';
            for (let n = 0; n < el.childNodes.length; n++) {
                const node = el.childNodes[n];
                if (node !== undefined && node.nodeType === 3)
                    direct += node.textContent ?? '';
            }
            if (re.test(direct.trim()))
                out.push(el);
        }
        return out;
    };

    /**
     * Vue 3 introspection vocabulary — the subset of Vue's internal runtime shapes
     * this module reads. Parity with react/types.ts, but Vue's model differs:
     *  - There is no per-host-node fiber; only COMPONENT instances are tree nodes.
     *  - A component instance has no `$children`; child instances are discovered by
     *    walking its rendered `subTree` VNode (see collect_child_instances).
     *  - The mount container carries `__vue_app__`; every rendered DOM node carries
     *    `__vueParentComponent` pointing at the instance that rendered it.
     */
    /** Property the Vue app sets on its mount container element. */
    const VUE_APP_KEY = '__vue_app__';
    /** Property Vue sets on every rendered DOM node → its owning instance. */
    const VUE_PARENT_COMPONENT_KEY = '__vueParentComponent';

    /**
     * Read the Vue app instance off a mount-container element (`el.__vue_app__`).
     * Returns undefined when absent or when access throws (defensive against exotic
     * element proxies). Shared base for both component-tree traversal
     * (get_root_instance) and Pinia auto-discovery (stores/pinia/discover), so the
     * `__vue_app__` access lives in exactly one place.
     */
    const getVueApp = (rootEl) => {
        try {
            const v = rootEl[VUE_APP_KEY];
            return v != null ? v : undefined;
        }
        catch {
            return undefined;
        }
    };

    /**
     * Resolve the root component instance from a Vue mount-container element
     * (`el.__vue_app__._instance`). Unlike React's HostRoot wrapper, this IS the
     * root component (e.g. App), so it is the node addressed by the first child
     * segment of a stable id. Returns undefined when absent or malformed.
     */
    const getRootInstance = (rootEl) => {
        const inst = getVueApp(rootEl)?._instance;
        return inst != null ? inst : undefined;
    };

    const isVNode = (v) => typeof v === 'object' && v !== null && 'type' in v;
    /**
     * Walk a VNode tree collecting the IMMEDIATE child component instances:
     *  - a component VNode carries `.component` → collect it and STOP descending
     *    (that child's own subTree is walked when the child is processed);
     *  - a host/fragment VNode → descend its `children` array (text/slot children
     *    that aren't VNodes are ignored).
     */
    const walkVNode = (vnode, out) => {
        if (vnode === null)
            return;
        if (vnode.component != null) {
            out.push(vnode.component);
            return;
        }
        const children = vnode.children;
        if (Array.isArray(children)) {
            for (const child of children) {
                if (isVNode(child))
                    walkVNode(child, out);
            }
        }
    };
    /**
     * Immediate child component instances of `instance`, in render order — derived
     * by walking its rendered `subTree` (Vue 3 instances have no `$children`). This
     * is the Vue analogue of fiber.child/sibling traversal; every other tree
     * operation (stable id, walk, resolve) is built on it.
     */
    const collectChildInstances = (instance) => {
        const out = [];
        walkVNode(instance.subTree, out);
        return out;
    };

    /** Strip directory + query + extension from a `__file` path → bare base name. */
    const basename = (file) => {
        const noQuery = file.split('?')[0] ?? file;
        const seg = noQuery.split(/[\\/]/).pop() ?? noQuery;
        return seg.replace(/\.\w+$/, '');
    };
    /**
     * Component display name, preferring an explicit `name` (defineOptions /
     * options API), then the <script setup> compiler-injected `__name`, then the
     * `__file` base name. 'Anonymous' when none is resolvable.
     */
    const extractDisplayName = (instance) => {
        const type = instance.type;
        if (type !== null && (typeof type === 'object' || typeof type === 'function')) {
            const o = type;
            if (typeof o.name === 'string' && o.name.length > 0)
                return o.name;
            if (typeof o.__name === 'string' && o.__name.length > 0)
                return o.__name;
            if (typeof o.__file === 'string' && o.__file.length > 0) {
                const b = basename(o.__file);
                if (b.length > 0)
                    return b;
            }
        }
        return 'Anonymous';
    };

    /**
     * The component's VNode key as a string, or undefined when unkeyed. Vue keys
     * may be string | number | symbol; numbers are stringified (so `:key="todo.id"`
     * round-trips), symbols are treated as unkeyed (not addressable by string id).
     */
    const extractKey = (instance) => {
        const key = instance.vnode?.key;
        if (key == null)
            return undefined;
        if (typeof key === 'string')
            return key.length > 0 ? key : undefined;
        if (typeof key === 'number')
            return String(key);
        return undefined;
    };

    const ROOT_SEGMENT = /^root(\d+)$/;
    const CHILD_SEGMENT = /^(.+)\[(.*)\]$/;
    const isNumericString = (s) => s.length > 0 && /^\d+$/.test(s);
    const parseSegment = (seg) => {
        const m = CHILD_SEGMENT.exec(seg);
        if (m === null)
            return undefined;
        const name = m[1];
        const disc = m[2];
        if (name === undefined || disc === undefined)
            return undefined;
        return { name, disc };
    };
    const childByKey = (parent, name, key) => collectChildInstances(parent).find((c) => extractDisplayName(c) === name && extractKey(c) === key);
    const childAtIndex = (parent, name, index) => {
        let matched = 0;
        for (const c of collectChildInstances(parent)) {
            if (extractKey(c) === undefined && extractDisplayName(c) === name) {
                if (matched === index)
                    return c;
                matched += 1;
            }
        }
        return undefined;
    };
    // A numeric discriminator is ambiguous (a numeric vnode key vs an unkeyed
    // occurrence index): try the keyed child first, then the unkeyed-occurrence
    // child — mirroring react resolve_stable_id. Keyed wins on residual ambiguity.
    const findChild = (parent, { name, disc }) => isNumericString(disc)
        ? (childByKey(parent, name, disc) ??
            childAtIndex(parent, name, Number.parseInt(disc, 10)))
        : childByKey(parent, name, disc);
    /**
     * Inverse of computeStableId: resolve a stable id back to its live instance.
     * `root{i}` selects the mount root; segment[1] addresses the root component
     * instance itself (Vue's getRootInstance IS the root component, so its name is
     * validated against current rather than searched as a child); segments[2…]
     * descend via collectChildInstances. Returns undefined on any mismatch.
     */
    const resolveStableId = (stableId, roots) => {
        const segments = stableId.split('/');
        const head = segments[0];
        if (head === undefined)
            return undefined;
        const rootMatch = ROOT_SEGMENT.exec(head);
        if (rootMatch === null || rootMatch[1] === undefined)
            return undefined;
        const rootIndex = Number.parseInt(rootMatch[1], 10);
        if (rootIndex < 0 || rootIndex >= roots.length)
            return undefined;
        const rootEl = roots[rootIndex];
        if (rootEl === undefined)
            return undefined;
        let current = getRootInstance(rootEl);
        if (current === undefined)
            return undefined;
        const rootSeg = segments[1];
        if (rootSeg !== undefined) {
            const parsed = parseSegment(rootSeg);
            if (parsed === undefined)
                return undefined;
            if (extractDisplayName(current) !== parsed.name)
                return undefined;
        }
        for (let i = 2; i < segments.length; i++) {
            const seg = segments[i];
            if (seg === undefined)
                return undefined;
            const parsed = parseSegment(seg);
            if (parsed === undefined)
                return undefined;
            const next = findChild(current, parsed);
            if (next === undefined)
                return undefined;
            current = next;
        }
        return current;
    };

    /** True when an element carries a `__vue_app__` (i.e. it is a Vue mount root). */
    const isVueRoot = (el) => {
        try {
            return el[VUE_APP_KEY] != null;
        }
        catch {
            return false;
        }
    };
    /** All Vue mount-container elements in the document, in document order. */
    const findVueRoots = (doc) => {
        const roots = [];
        const all = doc.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (el !== undefined && isVueRoot(el))
                roots.push(el);
        }
        return roots;
    };

    // stableId -> element resolution, dispatched by framework.
    //
    // react/vue stableIds address a component instance, so we resolve the instance
    // and then descend to its host DOM element. solid's "stableId" is already a
    // CSS-ish locator, so it routes through querySelector. svelte identity is a
    // component .svelte FILE (not a single element), so it cannot resolve here —
    // callers should use role/text/selector for svelte.
    const HOST_COMPONENT_TAG = 5;
    const isElement$6 = (node) => node !== null &&
        typeof node === 'object' &&
        node.nodeType === 1;
    /**
     * First descendant host-node Element of a React fiber (the fiber itself when it
     * is already a host node). Walks the committed subtree via walkFiber.
     */
    const firstReactHostElement = (fiber) => {
        if (isElement$6(fiber.stateNode))
            return fiber.stateNode;
        let found;
        walkFiber(fiber, (f) => {
            if (found !== undefined)
                return false;
            if (f.tag === HOST_COMPONENT_TAG && isElement$6(f.stateNode)) {
                found = f.stateNode;
                return false;
            }
            return;
        });
        return found;
    };
    /** Root DOM element a Vue component instance rendered, if any. */
    const vueElementOf = (inst) => {
        if (inst === undefined)
            return undefined;
        const el = inst.subTree?.el ??
            inst.vnode?.el;
        return isElement$6(el) ? el : undefined;
    };
    /** Resolve a framework stableId to 0 or 1 host element. */
    const resolveByStableId = (doc, framework, stableId) => {
        switch (framework) {
            case 'react': {
                const fiber = resolveStableId$1(stableId, findReactRoots(doc));
                const el = fiber !== undefined ? firstReactHostElement(fiber) : undefined;
                return el !== undefined ? [el] : [];
            }
            case 'vue': {
                const el = vueElementOf(resolveStableId(stableId, findVueRoots(doc)));
                return el !== undefined ? [el] : [];
            }
            case 'solid':
                // Solid stableIds are CSS-ish locators produced by the solid finders.
                return bySelector(doc, stableId);
            case 'svelte':
            case 'dom':
            default:
                return [];
        }
    };

    // resolveLocator — the single entry the action-tool handlers call to turn a
    // Locator into one element (or a typed failure) before applying a dom_actions
    // primitive. Strategy is chosen by field precedence: selector > role > text >
    // stableId.
    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /** Apply nth / requireUnique / first-with-ambiguity / not-found selection. */
    const selectMatch = (elements, locator, describedBy) => {
        const matchCount = elements.length;
        if (matchCount === 0) {
            return { ok: false, error: `no element matched (${describedBy})`, matchCount: 0 };
        }
        if (locator.nth !== undefined) {
            const el = elements[locator.nth];
            if (el === undefined) {
                return {
                    ok: false,
                    error: `nth=${locator.nth} out of range (${matchCount} matches for ${describedBy})`,
                    matchCount,
                };
            }
            return { ok: true, element: el, matchCount, describedBy: `${describedBy} [nth=${locator.nth}]` };
        }
        const first = elements[0];
        if (first === undefined) {
            return { ok: false, error: `no element matched (${describedBy})`, matchCount: 0 };
        }
        if (matchCount > 1) {
            if (locator.requireUnique) {
                return {
                    ok: false,
                    error: `ambiguous: ${matchCount} matches for ${describedBy} — pass nth or unset requireUnique`,
                    matchCount,
                };
            }
            return { ok: true, element: first, matchCount, describedBy: `${describedBy} (first of ${matchCount})` };
        }
        return { ok: true, element: first, matchCount, describedBy };
    };
    /** Resolve a Locator to a single element (or typed failure). */
    const resolveLocator = (doc, locator) => {
        if (locator.selector !== undefined) {
            return selectMatch(bySelector(doc, locator.selector), locator, `selector "${locator.selector}"`);
        }
        if (locator.role !== undefined) {
            const nameRe = locator.name !== undefined ? new RegExp(escapeRegExp(locator.name)) : undefined;
            const desc = `role "${locator.role}"${locator.name !== undefined ? ` name~"${locator.name}"` : ''}`;
            return selectMatch(byRole(doc, locator.role, nameRe), locator, desc);
        }
        if (locator.text !== undefined) {
            const esc = escapeRegExp(locator.text);
            const re = locator.exact ? new RegExp(`^${esc}$`) : new RegExp(esc);
            const desc = `text ${locator.exact ? '=' : '~'}"${locator.text}"`;
            return selectMatch(byText(doc, re), locator, desc);
        }
        if (locator.stableId !== undefined) {
            const framework = locator.framework ?? 'dom';
            if (framework === 'svelte') {
                return {
                    ok: false,
                    error: 'svelte stableId is a component file, not a single element — use role/text/selector instead',
                    matchCount: 0,
                };
            }
            return selectMatch(resolveByStableId(doc, framework, locator.stableId), locator, `${framework} stableId "${locator.stableId}"`);
        }
        return { ok: false, error: 'locator has no selector/role/text/stableId', matchCount: 0 };
    };

    // Shared native-event builders + the single dispatch seam for dom_actions.
    //
    // Builders are pure: they construct DOM events with delegated-handler-friendly
    // defaults so the events behave like genuine user input. `bubbles` lets events
    // reach React's root-level delegated listeners; `composed` lets them cross
    // shadow boundaries (retargeted to the host) so handlers inside web components
    // / shadow DOM still fire. `dispatchAll` is the only side-effecting function —
    // every primitive composes pure builders, then dispatches once at the edge.
    const BASE = { bubbles: true, cancelable: true, composed: true };
    /** MouseEvent with delegated-handler-friendly defaults merged with `init`. */
    const makeMouseEvent = (type, init = {}) => new MouseEvent(type, { ...BASE, view: window, button: 0, ...init });
    /**
     * PointerEvent with bubbles+cancelable+composed defaults. Falls back to a
     * MouseEvent of the same type when the engine lacks a PointerEvent constructor
     * (older jsdom), keeping dispatch chains robust under test.
     */
    const makePointerEvent = (type, init = {}) => {
        const merged = {
            ...BASE,
            view: window,
            isPrimary: true,
            pointerId: 1,
            pointerType: 'mouse',
            button: 0,
            ...init,
        };
        if (typeof PointerEvent === 'function')
            return new PointerEvent(type, merged);
        return new MouseEvent(type, merged);
    };
    /** KeyboardEvent with delegated-handler-friendly defaults merged with `init`. */
    const makeKeyboardEvent = (type, init = {}) => new KeyboardEvent(type, { ...BASE, view: window, ...init });
    /**
     * Plain Event with bubbles+composed defaults. Used for input/change/submit/
     * focusin/focusout where a typed constructor is unnecessary or not
     * cross-engine constructable. `cancelable` defaults true but callers may
     * override (e.g. `change` is conventionally non-cancelable).
     */
    const makeEvent = (type, init = {}) => new Event(type, { ...BASE, ...init });
    /** WheelEvent (deltaX/deltaY) for the scroll wheel-event variant; Event fallback. */
    const makeWheelEvent = (type, init = {}) => {
        const merged = { ...BASE, view: window, ...init };
        if (typeof WheelEvent === 'function')
            return new WheelEvent(type, merged);
        return new Event(type, BASE);
    };
    /** Touch object for touch-event sequences; a plain touch-like object as fallback. */
    const makeTouch = (target, x, y, identifier = 0) => {
        const init = {
            identifier,
            target,
            clientX: x,
            clientY: y,
            pageX: x,
            pageY: y,
            screenX: x,
            screenY: y,
            radiusX: 1,
            radiusY: 1,
            rotationAngle: 0,
            force: 1,
        };
        if (typeof Touch === 'function')
            return new Touch(init);
        return init;
    };
    /**
     * TouchEvent with touches/targetTouches/changedTouches. For touchstart/touchmove
     * pass the active touches; for touchend pass the REMAINING touches (often [])
     * plus the lifted touches as changedTouches. Event fallback carries the lists.
     */
    const makeTouchEvent = (type, touches, changedTouches = touches) => {
        if (typeof TouchEvent === 'function') {
            return new TouchEvent(type, {
                ...BASE,
                view: window,
                touches,
                targetTouches: touches,
                changedTouches,
            });
        }
        const ev = new Event(type, BASE);
        ev.touches = touches;
        ev.targetTouches = touches;
        ev.changedTouches = changedTouches;
        return ev;
    };
    /**
     * DragEvent carrying a DataTransfer. One DataTransfer instance is shared across
     * a drag sequence so setData/getData round-trips. MouseEvent-with-dataTransfer
     * fallback when DragEvent is unconstructable.
     */
    const makeDragEvent = (type, dataTransfer, init = {}) => {
        const merged = { ...BASE, view: window, ...init };
        if (typeof DragEvent === 'function') {
            return new DragEvent(type, { ...merged, dataTransfer });
        }
        const ev = new MouseEvent(type, merged);
        ev.dataTransfer = dataTransfer;
        return ev;
    };
    /**
     * Dispatch a pre-built sequence of events on `target` in order. Reports whether
     * any cancelable event had preventDefault() called — `dispatchEvent` returns
     * false exactly when the event was cancelable and its default was prevented.
     * The single side-effecting seam in dom_actions.
     */
    const dispatchAll = (target, events) => {
        let defaultPrevented = false;
        for (const event of events) {
            const notPrevented = target.dispatchEvent(event);
            if (!notPrevented)
                defaultPrevented = true;
        }
        return { defaultPrevented };
    };

    // dom_actions result contract — shared by every action primitive.
    // Pure value types + tiny result constructors; no DOM access here.
    /** Construct a successful ActionResult, merging optional extra fields. */
    const actionOk = (action, extra = {}) => ({ acted: true, action, ...extra });
    /** Construct a failed ActionResult with an explanation. */
    const actionFail = (action, error) => ({
        acted: false,
        action,
        error,
    });

    // Click / double-click primitives.
    //
    // A real user click is a sequence, not a single 'click' event. Frameworks and
    // many UI libraries listen on pointer/mouse phases (pointerdown to open menus,
    // mousedown to start selections), so we replay the full chain. React's onClick
    // is delegated at the root and fires from the bubbling 'click' — which the
    // composed+bubbling events from events.ts satisfy.
    const isElement$5 = (node) => node !== null &&
        typeof node === 'object' &&
        node.nodeType === 1;
    /** The ordered phases of a single pointer+mouse click on `el`. */
    const clickSequence = () => [
        makePointerEvent('pointerover'),
        makePointerEvent('pointerenter', { bubbles: false }),
        makePointerEvent('pointerdown'),
        makeMouseEvent('mousedown'),
        makePointerEvent('pointerup'),
        makeMouseEvent('mouseup'),
        makeMouseEvent('click'),
    ];
    /**
     * Dispatch a realistic click chain on a host Element (focusing it first, as a
     * real pointer interaction would), so delegated onClick handlers fire.
     */
    const clickElement = (el) => {
        if (!isElement$5(el))
            return actionFail('click', 'target is not an element');
        el.focus?.();
        const { defaultPrevented } = dispatchAll(el, clickSequence());
        return actionOk('click', { defaultPrevented });
    };
    /** Dispatch two click chains followed by a dblclick on a host Element. */
    const dblclickElement = (el) => {
        if (!isElement$5(el))
            return actionFail('dblclick', 'target is not an element');
        el.focus?.();
        dispatchAll(el, clickSequence());
        dispatchAll(el, clickSequence());
        const { defaultPrevented } = dispatchAll(el, [makeMouseEvent('dblclick')]);
        return actionOk('dblclick', { defaultPrevented });
    };

    // Fill primitive — set the value of a form control the way React expects.
    //
    // React installs its own value setter on input/textarea elements to track
    // changes; assigning `el.value = x` directly updates the DOM but leaves React's
    // internal tracker out of sync, so the subsequent change event is treated as a
    // no-op and controlled components snap back. The fix is to call the *prototype*
    // native setter (which React's descriptor shadows), then dispatch input+change.
    const PROTOS = [
        { ctor: HTMLInputElement, tag: 'input' },
        { ctor: HTMLTextAreaElement, tag: 'textarea' },
        { ctor: HTMLSelectElement, tag: 'select' },
    ];
    /** Resolve the prototype-level native `value` setter for a control, if any. */
    const nativeValueSetter = (el) => {
        for (const { ctor } of PROTOS) {
            if (typeof ctor === 'function' && el instanceof ctor) {
                const desc = Object.getOwnPropertyDescriptor(ctor.prototype, 'value');
                if (desc?.set)
                    return desc.set.bind(el);
            }
        }
        return undefined;
    };
    const isFillable = (el) => PROTOS.some(({ ctor }) => typeof ctor === 'function' && el instanceof ctor);
    /**
     * Set a control's value via the prototype native setter (bypassing React's
     * value tracker), falling back to direct assignment. Returns whether the native
     * setter was used. Shared by fillElement and keyboard.typeSequence.
     */
    const setNativeValue = (el, value) => {
        const setValue = nativeValueSetter(el);
        if (setValue) {
            setValue(value);
            return true;
        }
        el.value = value;
        return false;
    };
    /**
     * Set a form control's value via the native prototype setter (bypassing React's
     * value tracker) and dispatch input + change so controlled onChange fires.
     */
    const fillElement = (el, value) => {
        if (!isFillable(el)) {
            return actionFail('fill', 'target is not an input, textarea, or select');
        }
        setNativeValue(el, value);
        const { defaultPrevented } = dispatchAll(el, [
            makeEvent('input'),
            makeEvent('change', { cancelable: false }),
        ]);
        return actionOk('fill', { defaultPrevented, detail: { value } });
    };

    // Submit primitive — fire a real form submission.
    //
    // requestSubmit() is preferred over form.submit(): it dispatches a cancelable
    // 'submit' event (so React's onSubmit and native validation run), whereas
    // form.submit() bypasses the event entirely. When requestSubmit is missing
    // (older engines / jsdom), fall back to dispatching a submit Event directly.
    /** Resolve the form a target belongs to (itself, its .form, or nearest ancestor). */
    const resolveForm = (target) => {
        if (typeof HTMLFormElement === 'function' && target instanceof HTMLFormElement) {
            return target;
        }
        const owned = target.form;
        if (typeof HTMLFormElement === 'function' && owned instanceof HTMLFormElement) {
            return owned;
        }
        return target.closest?.('form') ?? undefined;
    };
    /**
     * Submit the form owning `target` via requestSubmit() (cancelable submit event),
     * falling back to a dispatched submit Event. Errors when no form is found.
     */
    const submitForm = (target) => {
        const form = resolveForm(target);
        if (!form)
            return actionFail('submit', 'no owning <form> found for target');
        if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
            return actionOk('submit', { detail: { via: 'requestSubmit' } });
        }
        const { defaultPrevented } = dispatchAll(form, [makeEvent('submit')]);
        return actionOk('submit', { defaultPrevented, detail: { via: 'dispatch' } });
    };

    // Hover + focus/blur primitives.
    //
    // Hover-driven UI (tooltips, dropdown menus, popovers) listens on
    // pointerover/mouseover and sometimes pointermove, so the hover sequence
    // replays those. focus/blur themselves do NOT bubble; their bubbling
    // counterparts focusin/focusout are what delegated handlers listen on, so we
    // dispatch those after calling the native focus()/blur().
    const isElement$4 = (node) => node !== null &&
        typeof node === 'object' &&
        node.nodeType === 1;
    /** Dispatch a pointer/mouse hover sequence so hover-triggered UI opens. */
    const hoverElement = (el) => {
        if (!isElement$4(el))
            return actionFail('hover', 'target is not an element');
        const { defaultPrevented } = dispatchAll(el, [
            makePointerEvent('pointerover'),
            makeMouseEvent('mouseover'),
            makePointerEvent('pointerenter', { bubbles: false }),
            makeMouseEvent('mouseenter', { bubbles: false }),
            makePointerEvent('pointermove'),
            makeMouseEvent('mousemove'),
        ]);
        return actionOk('hover', { defaultPrevented });
    };
    /**
     * Focus a host Element. The native focus() dispatches focus + bubbling focusin
     * itself (we must NOT also dispatch focusin, or delegated handlers fire twice).
     */
    const focusElement = (el) => {
        if (!isElement$4(el))
            return actionFail('focus', 'target is not an element');
        el.focus?.();
        return actionOk('focus');
    };
    /** Blur a host Element. Native blur() dispatches blur + bubbling focusout. */
    const blurElement = (el) => {
        if (!isElement$4(el))
            return actionFail('blur', 'target is not an element');
        el.blur?.();
        return actionOk('blur');
    };

    // Checkbox/radio toggle + <select> option choice.
    //
    // For checkable inputs we drive the change through the native click path rather
    // than setting `.checked` directly: clicking is what React's onChange listens
    // for, and it keeps the DOM, React state, and any radio-group siblings
    // consistent. setChecked is therefore idempotent — it only clicks when the
    // current state differs from the requested one.
    const isCheckable = (el) => typeof HTMLInputElement === 'function' &&
        el instanceof HTMLInputElement &&
        (el.type === 'checkbox' || el.type === 'radio');
    /**
     * Drive a checkbox/radio to `checked`. No-op when already in that state;
     * otherwise routes through the native click path so onChange fires.
     */
    const setChecked = (el, checked) => {
        if (!isCheckable(el)) {
            return actionFail(checked ? 'check' : 'uncheck', 'target is not a checkbox or radio input');
        }
        const kind = checked ? 'check' : 'uncheck';
        if (el.checked === checked) {
            return actionOk(kind, { detail: { changed: false, checked } });
        }
        const res = clickElement(el);
        return actionOk(kind, {
            defaultPrevented: res.defaultPrevented ?? false,
            detail: { changed: true, checked: el.checked },
        });
    };
    /**
     * Select an <option> by value or visible label, set the select's value, and
     * dispatch change. Errors when no matching option exists.
     */
    const selectOption = (el, opts) => {
        if (!(typeof HTMLSelectElement === 'function' && el instanceof HTMLSelectElement)) {
            return actionFail('selectOption', 'target is not a <select>');
        }
        const options = Array.from(el.options);
        const match = opts.value !== undefined
            ? options.find((o) => o.value === opts.value)
            : options.find((o) => o.text.trim() === opts.label?.trim());
        if (!match) {
            return actionFail('selectOption', 'no option matched the given value/label');
        }
        el.value = match.value;
        const { defaultPrevented } = dispatchAll(el, [
            makeEvent('input'),
            makeEvent('change', { cancelable: false }),
        ]);
        return actionOk('selectOption', {
            defaultPrevented,
            detail: { value: match.value, label: match.text.trim() },
        });
    };

    // Keyboard primitives — single key presses and typed strings.
    //
    // pressKey replays the keydown/keypress/keyup sequence (plus beforeinput/input
    // for printable keys on editable targets) using a named-key table so callers
    // can pass 'Enter'/'Tab'/'ArrowDown' as well as literal characters.
    // typeSequence types a string char-by-char, mutating the value via the shared
    // native setter (see fill.ts) so React controlled inputs track each keystroke.
    /** Named (non-printable) keys → DOM code + legacy keyCode. */
    const NAMED_KEYS = {
        Enter: { code: 'Enter', keyCode: 13 },
        Tab: { code: 'Tab', keyCode: 9 },
        Escape: { code: 'Escape', keyCode: 27 },
        Backspace: { code: 'Backspace', keyCode: 8 },
        Delete: { code: 'Delete', keyCode: 46 },
        ' ': { code: 'Space', keyCode: 32 },
        ArrowUp: { code: 'ArrowUp', keyCode: 38 },
        ArrowDown: { code: 'ArrowDown', keyCode: 40 },
        ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
        ArrowRight: { code: 'ArrowRight', keyCode: 39 },
        Home: { code: 'Home', keyCode: 36 },
        End: { code: 'End', keyCode: 35 },
    };
    const isElement$3 = (node) => node !== null &&
        typeof node === 'object' &&
        node.nodeType === 1;
    const isPrintable = (key) => key.length === 1 && key !== '\n';
    /** Resolve a key string to its code/keyCode (printable chars derive their own). */
    const specFor = (key) => {
        const named = NAMED_KEYS[key];
        if (named)
            return named;
        const upper = key.toUpperCase();
        return { code: /^[a-z]$/i.test(key) ? `Key${upper}` : key, keyCode: upper.charCodeAt(0) || 0 };
    };
    /**
     * Dispatch a single key's event sequence on a host Element. Printable keys on
     * editable targets also emit beforeinput/input (callers mutate value when they
     * need the character committed; typeSequence does this).
     */
    const pressKey = (el, key) => {
        if (!isElement$3(el))
            return actionFail('keyPress', 'target is not an element');
        const { code, keyCode } = specFor(key);
        const init = { key, code, keyCode, which: keyCode };
        const events = [makeKeyboardEvent('keydown', init)];
        if (isPrintable(key)) {
            events.push(makeKeyboardEvent('keypress', init));
            events.push(makeEvent('beforeinput'));
        }
        events.push(makeKeyboardEvent('keyup', init));
        const { defaultPrevented } = dispatchAll(el, events);
        return actionOk('keyPress', { defaultPrevented, detail: { key, code } });
    };
    /**
     * Type a string into an editable target char-by-char: per character replay the
     * key sequence and append the character to the value via the native setter +
     * an input event, ending with a single change event.
     */
    const typeSequence = (el, text) => {
        if (!isElement$3(el))
            return actionFail('typeSequence', 'target is not an element');
        let value = el.value ?? '';
        for (const char of text) {
            const spec = specFor(char);
            const init = { key: char, code: spec.code, keyCode: spec.keyCode, which: spec.keyCode };
            dispatchAll(el, [makeKeyboardEvent('keydown', init), makeKeyboardEvent('keypress', init)]);
            value += char;
            setNativeValue(el, value);
            dispatchAll(el, [makeEvent('input'), makeKeyboardEvent('keyup', init)]);
        }
        dispatchAll(el, [makeEvent('change', { cancelable: false })]);
        return actionOk('typeSequence', { detail: { text, value } });
    };

    // Pure geometry helpers for pointer/touch gesture paths.
    /**
     * Center point of an element via getBoundingClientRect. Falls back to {0,0}
     * when layout is unavailable (no-layout test engines return all-zero rects).
     */
    const centerOf = (el) => {
        const r = el.getBoundingClientRect?.();
        if (!r)
            return { x: 0, y: 0 };
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    /**
     * Linear interpolation from `from` to `to` over `steps` segments, returning
     * steps+1 points inclusive of both endpoints (for smooth move sequences).
     * steps<=0 yields just the endpoint.
     */
    const interpolatePoints = (from, to, steps) => {
        if (steps <= 0)
            return [to];
        const out = [];
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
        }
        return out;
    };

    // Pointer-based gestures: drag (pointer + optional HTML5 DnD) and scroll.
    const isElement$2 = (node) => node !== null &&
        typeof node === 'object' &&
        node.nodeType === 1;
    const newDataTransfer = () => typeof DataTransfer === 'function' ? new DataTransfer() : {};
    /**
     * Drag a source element to a target point or element: pointerdown at the source
     * center, interpolated pointermove steps, pointerup at the destination. With
     * html5:true also fires the native DnD sequence (dragstart/dragenter/dragover/
     * drop/dragend) sharing one DataTransfer, for libraries using the drag API.
     */
    const dragElement = (source, opts) => {
        if (!isElement$2(source))
            return actionFail('drag', 'source is not an element');
        const start = centerOf(source);
        let targetEl = null;
        let dest;
        if (opts.targetSelector !== undefined) {
            targetEl = document.querySelector(opts.targetSelector);
            if (targetEl === null) {
                return actionFail('drag', `targetSelector matched nothing: ${opts.targetSelector}`);
            }
            dest = centerOf(targetEl);
        }
        else if (opts.toX !== undefined && opts.toY !== undefined) {
            dest = { x: opts.toX, y: opts.toY };
        }
        else {
            return actionFail('drag', 'provide targetSelector or both toX and toY');
        }
        const steps = opts.steps ?? 10;
        const path = interpolatePoints(start, dest, steps);
        const at = (p) => ({ clientX: p.x, clientY: p.y });
        dispatchAll(source, [makePointerEvent('pointerdown', at(start))]);
        for (const p of path)
            dispatchAll(source, [makePointerEvent('pointermove', at(p))]);
        const upTarget = targetEl ?? source;
        const { defaultPrevented } = dispatchAll(upTarget, [makePointerEvent('pointerup', at(dest))]);
        if (opts.html5) {
            const dt = newDataTransfer();
            const dndTarget = targetEl ?? source;
            dispatchAll(source, [makeDragEvent('dragstart', dt, at(start))]);
            dispatchAll(dndTarget, [makeDragEvent('dragenter', dt, at(dest))]);
            dispatchAll(dndTarget, [makeDragEvent('dragover', dt, at(dest))]);
            dispatchAll(dndTarget, [makeDragEvent('drop', dt, at(dest))]);
            dispatchAll(source, [makeDragEvent('dragend', dt, at(dest))]);
        }
        return actionOk('drag', {
            defaultPrevented,
            detail: { from: start, to: dest, steps, html5: opts.html5 === true },
        });
    };
    /**
     * Scroll a target element: when intoView, scrollIntoView (centered); otherwise
     * dispatch a wheel event (so wheel-listening handlers fire) AND scrollBy the
     * delta. Returns the resulting scroll position.
     */
    const scrollElement = (el, opts) => {
        if (!isElement$2(el))
            return actionFail('scroll', 'target is not an element');
        if (opts.intoView) {
            el.scrollIntoView?.({ block: 'center', inline: 'center' });
            return actionOk('scroll', { detail: { intoView: true } });
        }
        const deltaX = opts.deltaX ?? 0;
        const deltaY = opts.deltaY ?? 0;
        const { defaultPrevented } = dispatchAll(el, [makeWheelEvent('wheel', { deltaX, deltaY })]);
        if (typeof el.scrollBy === 'function')
            el.scrollBy(deltaX, deltaY);
        return actionOk('scroll', {
            defaultPrevented,
            detail: { deltaX, deltaY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop },
        });
    };

    // Touch gestures: swipe, tap, double-tap, long-press (async), pinch.
    // Each replays a Touch/TouchList sequence (touchstart -> touchmove* -> touchend)
    // so touch-driven handlers fire. longPress is async because it must hold
    // between touchstart and touchend long enough for the page's long-press timer.
    const isElement$1 = (node) => node !== null &&
        typeof node === 'object' &&
        node.nodeType === 1;
    const DIRECTIONS = {
        up: { x: 0, y: -1 },
        down: { x: 0, y: 1 },
        left: { x: -1, y: 0 },
        right: { x: 1, y: 0 },
    };
    /** Swipe a touch across an element in a direction by a distance over N steps. */
    const swipeElement = (el, opts) => {
        if (!isElement$1(el))
            return actionFail('swipe', 'target is not an element');
        const dir = DIRECTIONS[opts.direction];
        if (dir === undefined)
            return actionFail('swipe', `invalid direction: ${opts.direction}`);
        const distance = opts.distance ?? 100;
        const steps = opts.steps ?? 10;
        const c = centerOf(el);
        const end = { x: c.x + dir.x * distance, y: c.y + dir.y * distance };
        dispatchAll(el, [makeTouchEvent('touchstart', [makeTouch(el, c.x, c.y)])]);
        for (const p of interpolatePoints(c, end, steps)) {
            dispatchAll(el, [makeTouchEvent('touchmove', [makeTouch(el, p.x, p.y)])]);
        }
        const { defaultPrevented } = dispatchAll(el, [
            makeTouchEvent('touchend', [], [makeTouch(el, end.x, end.y)]),
        ]);
        return actionOk('swipe', { defaultPrevented, detail: { direction: opts.direction, distance, steps } });
    };
    /** One touchstart/touchend pair at a point; returns defaultPrevented. */
    const tapOnce = (el, c) => {
        dispatchAll(el, [makeTouchEvent('touchstart', [makeTouch(el, c.x, c.y)])]);
        return dispatchAll(el, [makeTouchEvent('touchend', [], [makeTouch(el, c.x, c.y)])]).defaultPrevented;
    };
    /** Tap an element (single touchstart/touchend at its center). */
    const tapElement = (el) => {
        if (!isElement$1(el))
            return actionFail('tap', 'target is not an element');
        const defaultPrevented = tapOnce(el, centerOf(el));
        return actionOk('tap', { defaultPrevented });
    };
    /** Double-tap an element (two touchstart/touchend pairs). */
    const doubleTapElement = (el) => {
        if (!isElement$1(el))
            return actionFail('doubleTap', 'target is not an element');
        const c = centerOf(el);
        tapOnce(el, c);
        const defaultPrevented = tapOnce(el, c);
        return actionOk('doubleTap', { defaultPrevented });
    };
    /**
     * Long-press (async): touchstart, hold for `duration` ms so the page's
     * long-press timer fires, then touchend + contextmenu.
     */
    const longPressElement = async (el, opts = {}) => {
        if (!isElement$1(el))
            return actionFail('longPress', 'target is not an element');
        const c = centerOf(el);
        const duration = opts.duration ?? 500;
        dispatchAll(el, [makeTouchEvent('touchstart', [makeTouch(el, c.x, c.y)])]);
        await new Promise((resolve) => setTimeout(resolve, duration));
        dispatchAll(el, [makeTouchEvent('touchend', [], [makeTouch(el, c.x, c.y)])]);
        const { defaultPrevented } = dispatchAll(el, [
            makeMouseEvent('contextmenu', { clientX: c.x, clientY: c.y }),
        ]);
        return actionOk('longPress', { defaultPrevented, detail: { duration } });
    };
    /**
     * Pinch-zoom on an element with two touches symmetric about its center: scale>1
     * diverges (zoom in), scale<1 converges (zoom out), interpolated over N steps.
     */
    const pinchElement = (el, opts) => {
        if (!isElement$1(el))
            return actionFail('pinch', 'target is not an element');
        const steps = opts.steps ?? 10;
        const c = centerOf(el);
        const sep = 50;
        const a0 = { x: c.x - sep, y: c.y };
        const b0 = { x: c.x + sep, y: c.y };
        const a1 = { x: c.x - sep * opts.scale, y: c.y };
        const b1 = { x: c.x + sep * opts.scale, y: c.y };
        const pa = interpolatePoints(a0, a1, steps);
        const pb = interpolatePoints(b0, b1, steps);
        dispatchAll(el, [
            makeTouchEvent('touchstart', [makeTouch(el, a0.x, a0.y, 0), makeTouch(el, b0.x, b0.y, 1)]),
        ]);
        for (let i = 0; i < pa.length; i++) {
            const a = pa[i];
            const b = pb[i];
            dispatchAll(el, [
                makeTouchEvent('touchmove', [makeTouch(el, a.x, a.y, 0), makeTouch(el, b.x, b.y, 1)]),
            ]);
        }
        const { defaultPrevented } = dispatchAll(el, [
            makeTouchEvent('touchend', [], [makeTouch(el, a1.x, a1.y, 0), makeTouch(el, b1.x, b1.y, 1)]),
        ]);
        return actionOk('pinch', { defaultPrevented, detail: { scale: opts.scale, steps } });
    };

    // Page-world capstone: resolve a locator, then apply a dom_actions primitive to
    // the resolved element. The single composition point of interaction_locator +
    // dom_actions, called by the page-world tool handlers. Async because some
    // gestures (long-press) must hold across a real delay.
    const FRAMEWORKS = ['react', 'vue', 'svelte', 'solid', 'dom'];
    const LOCATOR_KEYS = new Set([
        'framework', 'selector', 'role', 'name', 'text', 'exact', 'stable_id', 'nth', 'require_unique',
    ]);
    const asFramework = (v) => typeof v === 'string' && FRAMEWORKS.includes(v)
        ? v
        : undefined;
    const num = (v) => (typeof v === 'number' ? v : undefined);
    const str$1 = (v) => (typeof v === 'string' ? v : undefined);
    /** Parse a wire payload into a Locator (snake_case->camelCase) + a params record. */
    const readActionInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const loc = {};
        const fw = asFramework(r['framework']);
        if (fw !== undefined)
            loc.framework = fw;
        if (typeof r['selector'] === 'string')
            loc.selector = r['selector'];
        if (typeof r['role'] === 'string')
            loc.role = r['role'];
        if (typeof r['name'] === 'string')
            loc.name = r['name'];
        if (typeof r['text'] === 'string')
            loc.text = r['text'];
        if (typeof r['exact'] === 'boolean')
            loc.exact = r['exact'];
        if (typeof r['stable_id'] === 'string')
            loc.stableId = r['stable_id'];
        if (typeof r['nth'] === 'number' && Number.isInteger(r['nth']) && r['nth'] >= 0)
            loc.nth = r['nth'];
        if (typeof r['require_unique'] === 'boolean')
            loc.requireUnique = r['require_unique'];
        const params = {};
        for (const [k, v] of Object.entries(r)) {
            if (!LOCATOR_KEYS.has(k) && v !== undefined)
                params[k] = v;
        }
        return { locator: Object.freeze(loc), params };
    };
    const fail = (message) => Object.freeze({ error: Object.freeze({ message }) });
    /** Resolve `locator` and apply the `action` dom_actions primitive to the match. */
    const runAction = async (doc, action, locator, params) => {
        const res = resolveLocator(doc, locator);
        if (!res.ok)
            return fail(res.error);
        const el = res.element;
        const located = Object.freeze({ describedBy: res.describedBy, matchCount: res.matchCount });
        const done = (action_result) => Object.freeze({ located, action: action_result });
        switch (action) {
            case 'click':
                return done(clickElement(el));
            case 'dblclick':
                return done(dblclickElement(el));
            case 'fill': {
                const value = str$1(params['value']);
                if (value === undefined)
                    return fail('pdl_fill requires a value');
                return done(fillElement(el, value));
            }
            case 'submit':
                return done(submitForm(el));
            case 'hover':
                return done(hoverElement(el));
            case 'focus':
                return done(focusElement(el));
            case 'blur':
                return done(blurElement(el));
            case 'check':
                return done(setChecked(el, true));
            case 'uncheck':
                return done(setChecked(el, false));
            case 'selectOption': {
                const value = str$1(params['value']);
                const label = str$1(params['label']);
                if (value === undefined && label === undefined) {
                    return fail('pdl_select_option requires a value or label');
                }
                return done(selectOption(el, {
                    ...(value !== undefined ? { value } : {}),
                    ...(label !== undefined ? { label } : {}),
                }));
            }
            case 'keyPress': {
                const key = str$1(params['key']);
                if (key === undefined)
                    return fail('pdl_key_press requires a key');
                return done(pressKey(el, key));
            }
            case 'typeSequence': {
                const value = str$1(params['value']);
                if (value === undefined)
                    return fail('pdl_type_sequence requires a value');
                return done(typeSequence(el, value));
            }
            case 'drag': {
                const toX = num(params['toX']);
                const toY = num(params['toY']);
                const targetSelector = str$1(params['targetSelector']);
                const steps = num(params['steps']);
                const html5 = params['html5'] === true;
                return done(dragElement(el, {
                    ...(toX !== undefined ? { toX } : {}),
                    ...(toY !== undefined ? { toY } : {}),
                    ...(targetSelector !== undefined ? { targetSelector } : {}),
                    ...(steps !== undefined ? { steps } : {}),
                    html5,
                }));
            }
            case 'scroll': {
                const deltaX = num(params['deltaX']);
                const deltaY = num(params['deltaY']);
                const intoView = params['intoView'] === true;
                return done(scrollElement(el, {
                    ...(deltaX !== undefined ? { deltaX } : {}),
                    ...(deltaY !== undefined ? { deltaY } : {}),
                    intoView,
                }));
            }
            case 'swipe': {
                const direction = str$1(params['direction']);
                if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
                    return fail('pdl_swipe requires direction up|down|left|right');
                }
                const distance = num(params['distance']);
                const steps = num(params['steps']);
                return done(swipeElement(el, {
                    direction,
                    ...(distance !== undefined ? { distance } : {}),
                    ...(steps !== undefined ? { steps } : {}),
                }));
            }
            case 'tap':
                return done(tapElement(el));
            case 'doubleTap':
                return done(doubleTapElement(el));
            case 'longPress': {
                const duration = num(params['duration']);
                return done(await longPressElement(el, duration !== undefined ? { duration } : {}));
            }
            case 'pinch': {
                const scale = num(params['scale']);
                if (scale === undefined)
                    return fail('pdl_pinch requires a numeric scale');
                const steps = num(params['steps']);
                return done(pinchElement(el, { scale, ...(steps !== undefined ? { steps } : {}) }));
            }
            default:
                return done(actionFail('click', `unknown action: ${action}`));
        }
    };

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

    /**
     * 0-based occurrence index of an unkeyed instance among its prior UNKEYED
     * siblings sharing the same display name — the exact inverse of
     * resolve_stable_id's childAtIndex predicate, so computeStableId's unkeyed
     * discriminator round-trips. Siblings are the parent's child instances (Vue has
     * no $children, so they are recomputed from the parent's subTree). Returns 0
     * for a root instance (parent === null) or one unreachable in the parent.
     */
    const unkeyedOccurrence = (instance) => {
        const parent = instance.parent;
        if (parent === null)
            return 0;
        const name = extractDisplayName(instance);
        let occurrence = 0;
        for (const sib of collectChildInstances(parent)) {
            if (sib === instance)
                return occurrence;
            if (extractKey(sib) === undefined && extractDisplayName(sib) === name) {
                occurrence += 1;
            }
        }
        return 0;
    };

    const segmentFor = (instance) => {
        const name = extractDisplayName(instance);
        const key = extractKey(instance);
        const discriminator = key ?? String(unkeyedOccurrence(instance));
        return `${name}[${discriminator}]`;
    };
    /**
     * Path-based stable id for a Vue component instance, resilient across
     * re-renders: `root{i}/Name[disc]/…` walking up `instance.parent` to the root
     * component. Mirrors react computeStableId, but the root component itself is
     * the first child segment (Vue has no HostRoot wrapper above it), so the root
     * App resolves to `root{i}/App[0]`.
     */
    const computeStableId = (instance, rootIndex = 0) => {
        const segments = [];
        let cursor = instance;
        while (cursor !== null) {
            segments.unshift(segmentFor(cursor));
            cursor = cursor.parent;
        }
        segments.unshift(`root${rootIndex}`);
        return segments.join('/');
    };

    /**
     * Page-world Vue component-tree serializer — parity with react/serialize_tree,
     * but over Vue's ComponentInternalInstance model: children come from
     * collectChildInstances (walking the rendered subTree) rather than React's
     * fiber.child/sibling links. Produces a depth- and node-capped nested tree of
     * stable ids + display names for the vue_tree MCP tool.
     *
     * Pure: reads the live instance tree via the M38 vue primitives; no DOM writes,
     * no chrome.*. The `doc` is only walked to find mount roots (findVueRoots).
     */
    const DEFAULT_DEPTH_LIMIT = 8;
    const DEFAULT_MAX_NODES = 200;
    /** True when v is a non-null object with at least one own enumerable key. */
    const hasEntries$1 = (v) => v !== null && typeof v === 'object' && Object.keys(v).length > 0;
    const serializeNode$1 = (instance, rootIndex, depth, depthLimit, state, maxNodes) => {
        if (state.nodesEmitted >= maxNodes) {
            state.truncated = true;
            return undefined;
        }
        state.nodesEmitted += 1;
        const childInstances = collectChildInstances(instance);
        const children = [];
        if (depth < depthLimit) {
            for (const child of childInstances) {
                const childNode = serializeNode$1(child, rootIndex, depth + 1, depthLimit, state, maxNodes);
                if (childNode === undefined)
                    break;
                children.push(childNode);
            }
        }
        else if (childInstances.length > 0) {
            state.truncated = true;
        }
        const key = extractKey(instance);
        return {
            stableId: computeStableId(instance, rootIndex),
            displayName: extractDisplayName(instance),
            ...(key !== undefined ? { key } : {}),
            hasProps: hasEntries$1(instance.props),
            hasState: hasEntries$1(instance.setupState) || hasEntries$1(instance.data),
            children,
        };
    };
    /**
     * Serialize the Vue component tree(s) on the document. Walks each Vue mount
     * root (or only options.rootIndex when given), capping depth (depthLimit) and
     * total nodes (maxNodes); `truncated` is set when either cap is hit. Returns the
     * nested roots plus the total Vue-root count for index disambiguation.
     */
    const serializeVueTree = (doc, options = {}) => {
        const rootEls = findVueRoots(doc);
        const rootCount = rootEls.length;
        const depthLimit = options.depthLimit ?? DEFAULT_DEPTH_LIMIT;
        const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
        const selectedIndices = options.rootIndex === undefined
            ? rootEls.map((_, i) => i)
            : options.rootIndex >= 0 && options.rootIndex < rootCount
                ? [options.rootIndex]
                : [];
        const state = { nodesEmitted: 0, truncated: false };
        const roots = [];
        for (const i of selectedIndices) {
            const rootEl = rootEls[i];
            if (rootEl === undefined)
                continue;
            const rootInstance = getRootInstance(rootEl);
            if (rootInstance === undefined)
                continue;
            const node = serializeNode$1(rootInstance, i, 0, depthLimit, state, maxNodes);
            if (node !== undefined)
                roots.push(node);
            if (state.nodesEmitted >= maxNodes)
                break;
        }
        return { roots, truncated: state.truncated, rootCount };
    };

    /**
     * Page-world Vue single-component serializer — parity with
     * react/serialize_component, over Vue's ComponentInternalInstance. Projects a
     * resolved instance's identity (stable id, display name, key) plus its props,
     * setup() bindings (setupState), and options-API data, each run through the
     * shared 16KB-capped serializeArgs so vue.* never duplicates serialization.
     *
     * Pure: reads instance fields only; the caller resolves the instance from a
     * stable id (resolveStableId) before handing it here.
     */
    const serializeField = (value) => {
        const r = serializeArgs$1([value]);
        return { value: r.serialized[0], truncated: r.truncated };
    };
    /** True when v is a non-null object with at least one own enumerable key. */
    const hasEntries = (v) => v !== null && typeof v === 'object' && Object.keys(v).length > 0;
    /**
     * Serialize one Vue component instance. props are included unless
     * includeProps === false; setupState + data are included unless
     * includeState === false. Empty surfaces are omitted entirely. `truncated` is
     * set when any included field hit the serializer's size cap.
     */
    const serializeVueComponent = (instance, rootIndex = 0, options = {}) => {
        const includeProps = options.includeProps !== false;
        const includeState = options.includeState !== false;
        const stableId = computeStableId(instance, rootIndex);
        const displayName = extractDisplayName(instance);
        const key = extractKey(instance);
        let props;
        let propsTruncated = false;
        if (includeProps && hasEntries(instance.props)) {
            const ser = serializeField(instance.props);
            props = ser.value;
            propsTruncated = ser.truncated;
        }
        let setupState;
        let setupTruncated = false;
        if (includeState && hasEntries(instance.setupState)) {
            const ser = serializeField(instance.setupState);
            setupState = ser.value;
            setupTruncated = ser.truncated;
        }
        let data;
        let dataTruncated = false;
        if (includeState && hasEntries(instance.data)) {
            const ser = serializeField(instance.data);
            data = ser.value;
            dataTruncated = ser.truncated;
        }
        const truncated = propsTruncated || setupTruncated || dataTruncated;
        return {
            stableId,
            displayName,
            ...(key !== undefined ? { key } : {}),
            ...(props !== undefined ? { props } : {}),
            ...(setupState !== undefined ? { setupState } : {}),
            ...(data !== undefined ? { data } : {}),
            ...(truncated ? { truncated: true } : {}),
        };
    };

    /**
     * The ComponentInternalInstance that rendered a DOM node, via Vue's
     * `el.__vueParentComponent` back-pointer (parity with react getFiberForNode).
     * Returns undefined when the node was not rendered by Vue.
     */
    const getInstanceForNode = (el) => {
        try {
            const v = el[VUE_PARENT_COMPONENT_KEY];
            return v != null ? v : undefined;
        }
        catch {
            return undefined;
        }
    };

    /**
     * Vue DOM-walk primitive shared by vue.findByText and vue.findByRole — the Vue
     * analogue of react/find.ts's walkAndFilter, but inverted to match Vue's model:
     * Vue has no per-host-node component, so instead of walking a component tree we
     * walk the rendered DOM under each Vue mount root and map each matching element
     * back to its OWNING component instance via getInstanceForNode
     * (el.__vueParentComponent). Matches are de-duped by instance (many DOM nodes
     * can belong to one component) and carry the rootIndex so callers can compute a
     * root-scoped stable id.
     *
     * Pure: DOM reads only, no mutation. The predicate is caller-supplied and
     * returns the per-match payload (or null to skip).
     */
    const DEFAULT_MAX_MATCHES$2 = 20;
    /**
     * Walk the rendered DOM under each selected Vue root. For every element the
     * predicate accepts (returns non-null), map it to its owning component instance
     * and record one match per DISTINCT instance (first wins, document order),
     * capped at maxMatches. `truncated` is set when the cap is reached while
     * candidates remain.
     */
    const walkVueDom = (doc, predicate, options = {}) => {
        const rootEls = findVueRoots(doc);
        const rootCount = rootEls.length;
        const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES$2;
        const selectedIndices = options.rootIndex === undefined
            ? rootEls.map((_, i) => i)
            : options.rootIndex >= 0 && options.rootIndex < rootCount
                ? [options.rootIndex]
                : [];
        const matches = [];
        const seen = new Set();
        let truncated = false;
        for (const i of selectedIndices) {
            if (matches.length >= maxMatches) {
                truncated = true;
                break;
            }
            const rootEl = rootEls[i];
            if (rootEl === undefined)
                continue;
            // Root element itself, then its descendants — document (preorder) order.
            const els = [rootEl, ...Array.from(rootEl.querySelectorAll('*'))];
            for (const el of els) {
                if (matches.length >= maxMatches) {
                    truncated = true;
                    break;
                }
                const extra = predicate(el);
                if (extra === null)
                    continue;
                const instance = getInstanceForNode(el);
                if (instance === undefined || seen.has(instance))
                    continue;
                seen.add(instance);
                matches.push({ instance, rootIndex: i, extra });
            }
        }
        return { matches, truncated, rootCount };
    };

    /**
     * Locate Vue components by rendered text — parity with react/find_by_text, over
     * the Vue DOM-walk primitive. Matches elements whose trimmed textContent
     * satisfies a pre-compiled regex (exact = full-text match; otherwise substring),
     * maps each to its owning component, and returns root-scoped stable ids.
     *
     * pattern is a pre-compiled RegExp (the page-world handler owns compilation +
     * regex-error shaping) so this function is pure and never throws.
     */
    const findVueByText = (doc, pattern, options = {}) => {
        const exact = options.exact === true;
        const result = walkVueDom(doc, (el) => {
            const text = (el.textContent ?? '').trim();
            if (text.length === 0)
                return null;
            const m = pattern.exec(text);
            if (m === null)
                return null;
            if (exact && m[0] !== text)
                return null;
            return exact ? text : m[0];
        }, {
            ...(options.rootIndex !== undefined ? { rootIndex: options.rootIndex } : {}),
            ...(options.maxMatches !== undefined ? { maxMatches: options.maxMatches } : {}),
        });
        const matches = result.matches.map((mm) => {
            const key = extractKey(mm.instance);
            return Object.freeze({
                stableId: computeStableId(mm.instance, mm.rootIndex),
                displayName: extractDisplayName(mm.instance),
                ...(key !== undefined ? { key } : {}),
                matchedText: mm.extra,
            });
        });
        return Object.freeze({
            matches,
            truncated: result.truncated,
            rootCount: result.rootCount,
        });
    };

    /**
     * Locate Vue components by ARIA role — parity with react/find_by_role, over the
     * Vue DOM-walk primitive. Matches elements whose role (explicit attr or the
     * dom_aria implicit mapping) equals `role`, optionally narrowed by an
     * accessible-name regex, then maps each to its owning component and returns
     * root-scoped stable ids. The role/name logic is the shared dom_aria module —
     * identical to react.findByRole.
     *
     * nameRe is a pre-compiled RegExp (the page-world handler owns compilation +
     * regex-error shaping) so this function is pure and never throws.
     */
    const findVueByRole = (doc, role, nameRe, options = {}) => {
        // Object payload so a match with NO accessible name ({}) is still non-null
        // and distinguishable from a non-match (null).
        const result = walkVueDom(doc, (el) => {
            if (implicitRoleForElement(el) !== role)
                return null;
            const accName = computeAccessibleName(el);
            if (nameRe !== undefined) {
                if (accName === undefined || !nameRe.test(accName))
                    return null;
            }
            return accName !== undefined ? { name: accName } : {};
        }, {
            ...(options.rootIndex !== undefined ? { rootIndex: options.rootIndex } : {}),
            ...(options.maxMatches !== undefined ? { maxMatches: options.maxMatches } : {}),
        });
        const matches = result.matches.map((mm) => {
            const key = extractKey(mm.instance);
            return Object.freeze({
                stableId: computeStableId(mm.instance, mm.rootIndex),
                displayName: extractDisplayName(mm.instance),
                ...(key !== undefined ? { key } : {}),
                role,
                ...(mm.extra.name !== undefined ? { name: mm.extra.name } : {}),
            });
        });
        return Object.freeze({
            matches,
            truncated: result.truncated,
            rootCount: result.rootCount,
        });
    };

    /**
     * Svelte introspection vocabulary — deliberately narrow, because Svelte's
     * compiled model exposes far less than React/Vue (see the Path 5 research note).
     * The only generically-available, feature-detectable signal in DEV builds is
     * `el.__svelte_meta`, which carries the SOURCE LOCATION of each rendered
     * element within its component's .svelte file. Svelte is one component per
     * file, so the `file` field is our component identity; there is no persistent
     * component-instance object, hence no state-read vocabulary here.
     */
    /** Property the Svelte dev compiler sets on each rendered DOM element. */
    const SVELTE_META_KEY = '__svelte_meta';
    /** Global the Svelte 5 dev runtime exposes (presence => Svelte on the page). */
    const SVELTE_GLOBAL_KEY = '__svelte';

    /**
     * Feature-detect Svelte on the page. Svelte exposes no stable production
     * introspection surface, so detection looks for: (1) the Svelte 5 dev global
     * window.__svelte, and (2) the presence of dev-only __svelte_meta on rendered
     * elements (the only thing that makes discovery possible). `dev` reports
     * whether introspection is actually viable; `present` may be true with
     * dev:false for a production build.
     */
    const hasGlobal = (scope) => {
        try {
            return scope[SVELTE_GLOBAL_KEY] != null;
        }
        catch {
            return false;
        }
    };
    /** Count rendered elements carrying __svelte_meta (dev-only signal). */
    const countMetaElements = (doc) => {
        let count = 0;
        let all;
        try {
            all = doc.querySelectorAll('*');
        }
        catch {
            return 0;
        }
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (el === undefined)
                continue;
            try {
                if (el[SVELTE_META_KEY] != null)
                    count += 1;
            }
            catch {
                // ignore exotic elements
            }
        }
        return count;
    };
    const detectSvelte = (scope, doc) => {
        const metaElementCount = countMetaElements(doc);
        const present = hasGlobal(scope) || metaElementCount > 0;
        return Object.freeze({
            present,
            dev: metaElementCount > 0,
            metaElementCount,
        });
    };

    /**
     * Defensive readers over Svelte's dev-only `el.__svelte_meta`. Every access is
     * try/guarded — these properties are dev-only and may be absent or exotic, and
     * introspection must never throw on a page that merely happens to use Svelte.
     */
    const isLoc = (v) => v !== null && typeof v === 'object' && typeof v.file === 'string';
    /** Read `el.__svelte_meta` as a SvelteMeta, or undefined when absent/malformed. */
    const getSvelteMeta = (el) => {
        try {
            const raw = el[SVELTE_META_KEY];
            if (raw === null || typeof raw !== 'object')
                return undefined;
            const loc = raw.loc;
            return isLoc(loc) ? { loc } : undefined;
        }
        catch {
            return undefined;
        }
    };
    /**
     * The .svelte source file of the component that rendered `el`: the nearest
     * self-or-ancestor element carrying __svelte_meta. Svelte tags each element
     * with its OWN component file, so the closest meta up the tree names the
     * owning component. Returns undefined when no ancestor carries meta.
     */
    const componentFileForNode = (el) => {
        let cursor = el;
        while (cursor !== null) {
            const meta = getSvelteMeta(cursor);
            if (meta !== undefined)
                return meta.loc.file;
            cursor = cursor.parentElement;
        }
        return undefined;
    };

    /**
     * Discover the Svelte components rendered on the page by grouping every
     * __svelte_meta-tagged element by its source file. Svelte is one component per
     * .svelte file, so a distinct file == a distinct component definition; the file
     * path is the component's stable identity. This is coarser than the React/Vue
     * per-instance trees (Svelte exposes no instance objects — see the Path 5
     * research note), but it is the honest extent of what dev-mode Svelte offers.
     *
     * Pure: DOM reads only, never throws (delegates to the guarded getSvelteMeta).
     */
    /**
     * Group rendered DOM by component source file. Returns one SvelteComponent per
     * distinct file in first-seen (document) order, with element counts and the
     * first element's source line/column. Empty when no __svelte_meta is present
     * (production build, or not a Svelte page).
     */
    const discoverSvelteComponents = (doc) => {
        const byFile = new Map();
        const order = [];
        let all;
        try {
            all = doc.querySelectorAll('*');
        }
        catch {
            return [];
        }
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (el === undefined)
                continue;
            const meta = getSvelteMeta(el);
            if (meta === undefined)
                continue;
            const { file, line, column } = meta.loc;
            const existing = byFile.get(file);
            if (existing === undefined) {
                order.push(file);
                byFile.set(file, {
                    count: 1,
                    ...(line !== undefined || column !== undefined
                        ? { firstLoc: { ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) } }
                        : {}),
                });
            }
            else {
                existing.count += 1;
            }
        }
        return order.map((file) => {
            const acc = byFile.get(file);
            return Object.freeze({
                stableId: file,
                file,
                ...(acc.firstLoc !== undefined ? { firstLoc: acc.firstLoc } : {}),
                elementCount: acc.count,
            });
        });
    };

    /**
     * Svelte DOM-walk primitive shared by svelte.findByText / findByRole. Like the
     * Vue walker it walks the rendered DOM and maps each accepted element to its
     * owning unit — but for Svelte that unit is the component SOURCE FILE
     * (componentFileForNode), since Svelte has no instance objects. Matches are
     * de-duped by file (one entry per component file). Svelte has no clean mount-
     * root marker, so the whole document is walked.
     *
     * Pure: DOM reads only, never throws.
     */
    const DEFAULT_MAX_MATCHES$1 = 20;
    const walkSvelteDom = (doc, predicate, options = {}) => {
        const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES$1;
        const matches = [];
        const seen = new Set();
        let truncated = false;
        let all;
        try {
            all = doc.querySelectorAll('*');
        }
        catch {
            return { matches, truncated };
        }
        for (let i = 0; i < all.length; i++) {
            if (matches.length >= maxMatches) {
                truncated = true;
                break;
            }
            const el = all[i];
            if (el === undefined)
                continue;
            const extra = predicate(el);
            if (extra === null)
                continue;
            const file = componentFileForNode(el);
            if (file === undefined || seen.has(file))
                continue;
            seen.add(file);
            matches.push({ file, extra });
        }
        return { matches, truncated };
    };

    /**
     * Locate Svelte components by rendered text (parity-in-spirit with
     * react/vue findByText, but match identity is the component .svelte file).
     * pattern is a pre-compiled RegExp (handler owns compilation); pure, never
     * throws. Matches are one-per-component-file.
     */
    const findSvelteByText = (doc, pattern, options = {}) => {
        const exact = options.exact === true;
        const result = walkSvelteDom(doc, (el) => {
            const text = (el.textContent ?? '').trim();
            if (text.length === 0)
                return null;
            const m = pattern.exec(text);
            if (m === null)
                return null;
            if (exact && m[0] !== text)
                return null;
            return exact ? text : m[0];
        }, {
            ...(options.maxMatches !== undefined ? { maxMatches: options.maxMatches } : {}),
        });
        const matches = result.matches.map((mm) => Object.freeze({ stableId: mm.file, file: mm.file, matchedText: mm.extra }));
        return Object.freeze({ matches, truncated: result.truncated });
    };

    /**
     * Locate Svelte components by ARIA role (reusing the shared dom_aria role/name
     * logic). Match identity is the component .svelte file. nameRe is a pre-compiled
     * RegExp (handler owns compilation); pure, never throws. One match per file.
     */
    const findSvelteByRole = (doc, role, nameRe, options = {}) => {
        const result = walkSvelteDom(doc, (el) => {
            if (implicitRoleForElement(el) !== role)
                return null;
            const accName = computeAccessibleName(el);
            if (nameRe !== undefined) {
                if (accName === undefined || !nameRe.test(accName))
                    return null;
            }
            return accName !== undefined ? { name: accName } : {};
        }, {
            ...(options.maxMatches !== undefined ? { maxMatches: options.maxMatches } : {}),
        });
        const matches = result.matches.map((mm) => Object.freeze({
            stableId: mm.file,
            file: mm.file,
            role,
            ...(mm.extra.name !== undefined ? { name: mm.extra.name } : {}),
        }));
        return Object.freeze({ matches, truncated: result.truncated });
    };

    /**
     * Solid introspection vocabulary — the most constrained of the four frameworks
     * (see Path 5 research note). Solid has no virtual DOM, no persisted component
     * tree, and no DOM->component back-pointer; components are functions that run
     * once. So WITHOUT the @solid-devtools plugin (window.__SOLID_DEVTOOLS__), only
     * DETECTION and DOM-level (element) matching are possible — matches cannot be
     * attributed to components, and there is no state read.
     */
    /** Global the @solid-devtools runtime installs (presence => deep tools viable). */
    const SOLID_DEVTOOLS_KEY = '__SOLID_DEVTOOLS__';
    /** Global Solid's hydration runtime sets. */
    const SOLID_HYDRATION_KEY = '_$HY';
    /** Prefix Solid uses for delegated-event expando props on DOM nodes ($$click). */
    const SOLID_DELEGATED_PREFIX = '$$';

    /**
     * Feature-detect Solid on the page. Solid exposes no stable runtime global, so
     * detection is best-effort and combines: (1) the @solid-devtools hook
     * window.__SOLID_DEVTOOLS__ (definitive, and the only path to deep data); (2)
     * the _$HY hydration global; (3) a heuristic scan for Solid's $$-prefixed
     * delegated-event expando props on DOM nodes. `present` may be true with
     * devtoolsHook:false, in which case only DOM-level matching is available.
     */
    const hasKey = (scope, key) => {
        try {
            return scope[key] != null;
        }
        catch {
            return false;
        }
    };
    /** True when an element carries any $$-prefixed delegated-event expando prop. */
    const hasDelegatedEvent = (el) => {
        try {
            for (const k of Object.keys(el)) {
                if (k.startsWith(SOLID_DELEGATED_PREFIX))
                    return true;
            }
        }
        catch {
            // exotic element — ignore
        }
        return false;
    };
    const countDelegatedEventEls = (doc) => {
        let count = 0;
        let all;
        try {
            all = doc.querySelectorAll('*');
        }
        catch {
            return 0;
        }
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (el !== undefined && hasDelegatedEvent(el))
                count += 1;
        }
        return count;
    };
    const detectSolid = (scope, doc) => {
        const devtoolsHook = hasKey(scope, SOLID_DEVTOOLS_KEY);
        const hydration = hasKey(scope, SOLID_HYDRATION_KEY);
        const delegatedEventCount = countDelegatedEventEls(doc);
        return Object.freeze({
            present: devtoolsHook || hydration || delegatedEventCount > 0,
            devtoolsHook,
            hydration,
            delegatedEventCount,
        });
    };

    /**
     * Solid DOM-walk primitive + element locator. Because Solid exposes no
     * component identity, matches are ELEMENT-level (not component-level): each
     * match carries a CSS-ish locator and tag so the caller can find the node
     * again. Pure DOM reads; never throws.
     */
    const DEFAULT_MAX_MATCHES = 20;
    /**
     * A short CSS-ish locator for an element: `tag#id` when it has an id, otherwise
     * `tag.firstClass` plus an `:nth-of-type(n)` index when it has same-tag
     * siblings. Best-effort hint, not a guaranteed-unique selector.
     */
    const elementLocator = (el) => {
        const tag = el.tagName.toLowerCase();
        if (el.id.length > 0)
            return `${tag}#${el.id}`;
        let sel = tag;
        const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0];
        if (cls !== undefined && cls.length > 0)
            sel += `.${cls}`;
        const parent = el.parentElement;
        if (parent !== null) {
            const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
            if (sameTag.length > 1) {
                sel += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
            }
        }
        return sel;
    };
    const walkSolidDom = (doc, predicate, options = {}) => {
        const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
        const matches = [];
        let truncated = false;
        let all;
        try {
            all = doc.querySelectorAll('*');
        }
        catch {
            return { matches, truncated };
        }
        for (let i = 0; i < all.length; i++) {
            if (matches.length >= maxMatches) {
                truncated = true;
                break;
            }
            const el = all[i];
            if (el === undefined)
                continue;
            const extra = predicate(el);
            if (extra === null)
                continue;
            matches.push({ locator: elementLocator(el), tag: el.tagName.toLowerCase(), extra });
        }
        return { matches, truncated };
    };

    /**
     * Locate elements by rendered text on a Solid page. ELEMENT-level (Solid has no
     * component identity — see Path 5 research note): returns each matching node's
     * locator + tag + matched text. pattern is a pre-compiled RegExp; pure.
     */
    const findSolidByText = (doc, pattern, options = {}) => {
        const exact = options.exact === true;
        const result = walkSolidDom(doc, (el) => {
            const text = (el.textContent ?? '').trim();
            if (text.length === 0)
                return null;
            const m = pattern.exec(text);
            if (m === null)
                return null;
            if (exact && m[0] !== text)
                return null;
            return exact ? text : m[0];
        }, {
            ...(options.maxMatches !== undefined ? { maxMatches: options.maxMatches } : {}),
        });
        const matches = result.matches.map((mm) => Object.freeze({ locator: mm.locator, tag: mm.tag, matchedText: mm.extra }));
        return Object.freeze({ matches, truncated: result.truncated });
    };

    /**
     * Locate elements by ARIA role on a Solid page (reusing the shared dom_aria
     * role/name logic). ELEMENT-level (Solid has no component identity): returns
     * each matching node's locator + tag + role + accessible name. nameRe is a
     * pre-compiled RegExp; pure.
     */
    const findSolidByRole = (doc, role, nameRe, options = {}) => {
        const result = walkSolidDom(doc, (el) => {
            if (implicitRoleForElement(el) !== role)
                return null;
            const accName = computeAccessibleName(el);
            if (nameRe !== undefined) {
                if (accName === undefined || !nameRe.test(accName))
                    return null;
            }
            return accName !== undefined ? { name: accName } : {};
        }, {
            ...(options.maxMatches !== undefined ? { maxMatches: options.maxMatches } : {}),
        });
        const matches = result.matches.map((mm) => Object.freeze({
            locator: mm.locator,
            tag: mm.tag,
            role,
            ...(mm.extra.name !== undefined ? { name: mm.extra.name } : {}),
        }));
        return Object.freeze({ matches, truncated: result.truncated });
    };

    /**
     * Page-world Redux store detection.
     *
     * Resolution order (the caller composes both via the injected getStores seam):
     *  1. window.__pwaDebug_redux — explicit handoff (manual smoke, and stores that
     *     fiber discovery can't reach, e.g. vanilla non-React Redux).
     *  2. getStores()[first redux-shaped] — PASSIVE react-redux discovery off the
     *     React fiber tree (M46; see ./discover). This replaced the removed
     *     __REDUX_DEVTOOLS_EXTENSION__ impersonation shim, which broke RTK apps by
     *     sitting in their store-creation path. Discovery is read-only and never
     *     participates in store creation.
     *
     * Pure: no DOM access, no chrome.* — the caller passes the candidate scope
     * (window in production, mock in tests) and the getStores provider. Duck-typed
     * validation only; we never call methods on the candidate at detection time.
     */
    /** Duck-type guard for the minimal Redux store surface. Shared with ./discover. */
    const isReduxLike = (v) => {
        if (v === null || typeof v !== 'object')
            return false;
        const r = v;
        return (typeof r['getState'] === 'function' &&
            typeof r['subscribe'] === 'function' &&
            typeof r['dispatch'] === 'function');
    };
    /**
     * Find the active Redux store. Resolution order:
     *  1. scope.__pwaDebug_redux (explicit handoff — wins when present).
     *  2. getStores()[first redux-shaped] (passive fiber-context discovery).
     * Returns null when neither yields a valid Redux-shaped store.
     */
    const detectReduxStore = (scope, getStores) => {
        const candidate = scope.__pwaDebug_redux;
        if (candidate !== undefined && isReduxLike(candidate))
            return candidate;
        if (getStores !== undefined) {
            for (const s of getStores()) {
                if (isReduxLike(s))
                    return s;
            }
        }
        return null;
    };

    const detectRedux = (scope, ctx) => {
        // ReduxStoreHandle (required dispatch) is structurally a StoreHandle; the
        // discovery genuinely yields Redux stores, so the getter cast is sound.
        const getStores = ctx?.reduxGetStores;
        return detectReduxStore(scope, getStores);
    };
    const reduxAdapter = Object.freeze({
        framework: 'redux',
        detect: detectRedux,
    });

    /**
     * Page-world Zustand store detection — M3 explicit-handoff path
     * (window.__pwaDebug_zustand), mirroring the Redux T1 contract.
     *
     * Zustand stores are module-local (`const useStore = create(...)`), never on a
     * global by default, so there is no ambient way to find them. M3 supports the
     * explicit fixture/app handoff only. The Zustand devtools-middleware
     * auto-capture path is deferred: that middleware drives
     * __REDUX_DEVTOOLS_EXTENSION__.connect(), NOT the enhancer-over-createStore
     * pattern the Redux shim intercepts, so it needs its own shim (with breakage
     * risk) — a future milestone. The optional shimGetStores parameter is reserved
     * for that path but unused today.
     *
     * Disambiguation from Redux: a Zustand vanilla store exposes setState; a Redux
     * store does not. Requiring setState here (and dispatch in the Redux guard)
     * keeps the two adapters from claiming each other's stores.
     *
     * Pure: no DOM, no chrome.* — duck-typed reads only, never invoked at detect.
     */
    const isZustandLike = (v) => {
        if (v === null || typeof v !== 'object')
            return false;
        const r = v;
        return (typeof r['getState'] === 'function' &&
            typeof r['setState'] === 'function' &&
            typeof r['subscribe'] === 'function');
    };
    /**
     * Find the active Zustand store. Resolution order:
     *  1. scope.__pwaDebug_zustand (explicit handoff — the only M3 path).
     *  2. shimGetStores()[0] (reserved for a future devtools path; unused now).
     * Returns null when neither yields a Zustand-shaped store.
     */
    const detectZustandStore = (scope, shimGetStores) => {
        const candidate = scope.__pwaDebug_zustand;
        if (candidate !== undefined && isZustandLike(candidate))
            return candidate;
        if (shimGetStores !== undefined) {
            const stores = shimGetStores();
            const first = stores[0];
            if (first !== undefined && isZustandLike(first))
                return first;
        }
        return null;
    };

    const toHandle$2 = (store) => ({
        getState: () => store.getState(),
        subscribe: (listener) => store.subscribe(() => listener()),
        dispatch: (action) => {
            const { type, payload } = action;
            if (type === 'setState') {
                store.setState(payload);
                return undefined;
            }
            const state = store.getState();
            const fn = state !== null && typeof state === 'object'
                ? state[type]
                : undefined;
            if (typeof fn === 'function') {
                return fn(payload);
            }
            throw new Error(`zustand: no action "${type}" in store state. Use type:"setState" with a payload to merge state, or a type matching a function field in the store.`);
        },
    });
    const detectZustand = (scope, ctx) => {
        // ZustandVanillaStore (required setState) is structurally a superset of
        // StoreHandle; the shim genuinely yields Zustand stores and detectZustandStore
        // re-validates setState via isZustandLike, so the getter cast is sound.
        const shim = ctx?.zustandShimGetStores;
        const store = detectZustandStore(scope, shim);
        return store === null ? null : toHandle$2(store);
    };
    const zustandAdapter = Object.freeze({
        framework: 'zustand',
        detect: detectZustand,
    });

    /**
     * Page-world Pinia store detection — explicit-handoff path
     * (window.__pwaDebug_pinia), mirroring the Redux/Zustand contract.
     *
     * Pinia stores are Vue-app-scoped; the handoff exposes a single store instance
     * (or the most relevant one). Detection resolves the explicit handoff first,
     * then falls back to an optional `getStores` provider (M37 auto-discovery:
     * stores pulled off the live Vue app's config.globalProperties.$pinia registry
     * — see ./discover). The provider is threaded in via the framework-agnostic
     * DetectContext so this module stays DOM-free.
     *
     * Disambiguation: a Pinia store exposes the $-prefixed surface $state/$patch/
     * $subscribe — distinct from Redux (dispatch) and Zustand (setState) — and uses
     * its own handoff key, so no adapter cross-claims another's store.
     *
     * Pure: no DOM, no chrome.* — duck-typed reads only.
     */
    /** Duck-type guard for the minimal Pinia store surface ($state/$patch/$subscribe). */
    const isPiniaLike = (v) => {
        if (v === null || typeof v !== 'object')
            return false;
        const r = v;
        return ('$state' in r &&
            typeof r['$patch'] === 'function' &&
            typeof r['$subscribe'] === 'function');
    };
    /**
     * Find the active Pinia store. Resolution order:
     *  1. scope.__pwaDebug_pinia (explicit handoff — wins when present).
     *  2. getStores()[first Pinia-shaped] (M37 auto-discovery; absent provider means
     *     "no auto-discovery wired").
     * Returns null when neither yields a Pinia-shaped store.
     */
    const detectPiniaStore = (scope, getStores) => {
        const candidate = scope.__pwaDebug_pinia;
        if (candidate !== undefined && isPiniaLike(candidate))
            return candidate;
        if (getStores !== undefined) {
            for (const s of getStores()) {
                if (isPiniaLike(s))
                    return s;
            }
        }
        return null;
    };

    const toHandle$1 = (store) => ({
        getState: () => store.$state,
        subscribe: (listener) => store.$subscribe(() => listener()),
        dispatch: (action) => {
            const { type, payload } = action;
            if (type === '$patch') {
                store.$patch(payload);
                return undefined;
            }
            const fn = store[type];
            if (typeof fn === 'function') {
                return fn(payload);
            }
            throw new Error(`pinia: no action "${type}" on the store. Use type:"$patch" with a payload to merge state, or a type matching an action method.`);
        },
    });
    const detectPinia = (scope, ctx) => {
        const store = detectPiniaStore(scope, ctx?.piniaGetStores);
        return store === null ? null : toHandle$1(store);
    };
    const piniaAdapter = Object.freeze({
        framework: 'pinia',
        detect: detectPinia,
    });

    /**
     * Page-world Jotai store detection — explicit-handoff path
     * (window.__pwaDebug_jotai).
     *
     * Jotai diverges most from the path-addressable StoreHandle model: state lives
     * across opaque atom references in a store (createStore()), with no single tree
     * and no names. So the handoff is a WRAPPED shape — { store, atoms } — pairing
     * the store instance with a name->atom registry the app chooses to expose. The
     * adapter projects that into a name-keyed snapshot so the generic path_get /
     * serialize / subscribe layer works unchanged.
     *
     * A Jotai dev-store auto-discovery path (enumerate atoms via
     * store.dev4_get_mounted_atoms in dev builds) lands in M44 — see ./dev_discover
     * and ./discover; this module owns the explicit-handoff path and the shared
     * store/handoff duck-type guards.
     *
     * Pure: no DOM, no chrome.* — duck-typed reads only.
     */
    /**
     * Duck-type guard for the bare Jotai store surface ({ get, set, sub }). Shared
     * by the explicit-handoff check below and the fiber-context discoverer
     * (./discover), so the store shape is defined once. Distinct from Redux
     * (getState/dispatch), Zustand (setState) and Pinia ($state/$patch), so no
     * adapter cross-claims a Jotai store.
     */
    const isJotaiStore = (v) => {
        if (v === null || typeof v !== 'object')
            return false;
        const r = v;
        return (typeof r['get'] === 'function' &&
            typeof r['set'] === 'function' &&
            typeof r['sub'] === 'function');
    };
    const isJotaiHandoff = (v) => {
        if (v === null || typeof v !== 'object')
            return false;
        const r = v;
        const atoms = r['atoms'];
        if (atoms === null || typeof atoms !== 'object')
            return false;
        return isJotaiStore(r['store']);
    };
    /**
     * Find the Jotai handoff via scope.__pwaDebug_jotai. Returns the { store, atoms }
     * pair, or null when absent or malformed.
     */
    const detectJotaiHandoff = (scope) => {
        const candidate = scope.__pwaDebug_jotai;
        if (candidate !== undefined && isJotaiHandoff(candidate))
            return candidate;
        return null;
    };

    /**
     * Page-world Jotai dev-store atom enumeration (M44) — turns a bare Jotai
     * createStore() instance into the wrapped { store, atoms } shape the adapter
     * already expects, WITHOUT the explicit window.__pwaDebug_jotai handoff.
     *
     * A bare Jotai store ({ get, set, sub }) carries no name->atom registry, so the
     * adapter's name-keyed snapshot has nothing to project. Some Jotai versions'
     * DEV builds expose a mounted-atom iterator we can read instead:
     *   - jotai 2.6–2.11: store.dev4_get_mounted_atoms()
     *   - jotai 2.0–2.5:  store.dev_get_mounted_atoms()
     * Both yield the live atom objects. We enumerate them and key each by its
     * atom.debugLabel (set by the user or jotai's babel/swc devtools plugin), with a
     * synthesized `atom{N}` fallback for unlabeled atoms, producing exactly the
     * Record<name, atom> the existing adapter reshapes through.
     *
     * IMPORTANT — version reality (M44 live-verify, note #258): jotai >=2.12 REMOVED
     * these dev iterators; the store keeps mounted atoms in a non-iterable WeakMap
     * (INTERNAL_*Rev3 building blocks), so atoms cannot be enumerated from a bare
     * store at all. On those versions buildHandoffFromDevStore returns null and
     * detection falls back to the explicit window.__pwaDebug_jotai handoff. This is
     * by design, not a gap: pwa-debug assumes the agent has the app's SOURCE, where
     * the atom set is fully visible — so reconstructing it from a running store is a
     * non-goal. This path is a best-effort convenience for jotai 2.0–2.11; the
     * always-correct mechanism is store discovery (./discover) + the handoff.
     *
     * Pure: duck-typed reads + the store's own dev iterator only. No DOM, no chrome.*.
     */
    /**
     * Resolve the store's mounted-atom iterable across Jotai dev API versions
     * (dev4_ for >=2.6, dev_ for 2.0–2.5). Returns null when neither is present —
     * i.e. a production build with no introspection surface.
     */
    const mountedAtoms = (store) => {
        const s = store;
        if (typeof s.dev4_get_mounted_atoms === 'function') {
            return s.dev4_get_mounted_atoms();
        }
        if (typeof s.dev_get_mounted_atoms === 'function') {
            return s.dev_get_mounted_atoms();
        }
        return null;
    };
    /** The human name an atom advertises via debugLabel, or null when unlabeled. */
    const atomLabel = (atom) => {
        if (atom === null || typeof atom !== 'object')
            return null;
        const label = atom.debugLabel;
        return typeof label === 'string' && label.length > 0 ? label : null;
    };
    /**
     * Build the wrapped { store, atoms } handoff from a bare Jotai store by
     * enumerating its mounted atoms via the dev API. Atoms are keyed by debugLabel,
     * falling back to a synthesized `atom{index}` name (and the same fallback when a
     * label collides, so every atom stays addressable). Returns null when the
     * candidate is not a Jotai store or exposes no dev atom iterator (production
     * build) — leaving the caller to fall through to other detection paths.
     */
    const buildHandoffFromDevStore = (candidate) => {
        if (!isJotaiStore(candidate))
            return null;
        const iterable = mountedAtoms(candidate);
        if (iterable === null)
            return null;
        const atoms = {};
        let index = 0;
        for (const atom of iterable) {
            const label = atomLabel(atom);
            const name = label !== null && !(label in atoms) ? label : `atom${index}`;
            atoms[name] = atom;
            index += 1;
        }
        return Object.freeze({ store: candidate, atoms: Object.freeze(atoms) });
    };

    const toHandle = (handoff) => {
        const { store, atoms } = handoff;
        const entries = Object.entries(atoms);
        return {
            getState: () => {
                const snapshot = {};
                for (const [name, atom] of entries)
                    snapshot[name] = store.get(atom);
                return snapshot;
            },
            subscribe: (listener) => {
                const unsubs = entries.map(([, atom]) => store.sub(atom, () => listener()));
                return () => {
                    for (const u of unsubs)
                        u();
                };
            },
            dispatch: (action) => {
                const { type, payload } = action;
                const atom = atoms[type];
                if (atom === undefined) {
                    throw new Error(`jotai: no atom named "${type}" in the exposed registry. dispatch sets an atom by name: { type: atomName, payload }.`);
                }
                store.set(atom, payload);
                return undefined;
            },
        };
    };
    // Resolution order: explicit window.__pwaDebug_jotai handoff wins (the app
    // chose exactly which atoms to expose); otherwise fall back to M44 fiber-context
    // discovery — each discovered bare store is turned into a { store, atoms }
    // handoff by enumerating its mounted atoms via the dev API. First store that
    // yields a handoff wins. detect.ts stays DOM-free; the store candidates arrive
    // via the framework-agnostic DetectContext.jotaiGetStores seam.
    const detectJotai = (scope, ctx) => {
        const handoff = detectJotaiHandoff(scope);
        if (handoff !== null)
            return toHandle(handoff);
        const getStores = ctx?.jotaiGetStores;
        if (getStores !== undefined) {
            for (const candidate of getStores()) {
                const built = buildHandoffFromDevStore(candidate);
                if (built !== null)
                    return toHandle(built);
            }
        }
        return null;
    };
    const jotaiAdapter = Object.freeze({
        framework: 'jotai',
        detect: detectJotai,
    });

    /**
     * Registered adapters in detection priority order; callers never change.
     * Adapters never collide: each uses a distinct explicit-handoff key
     * (__pwaDebug_redux / _zustand / _pinia / _jotai) and a mutually exclusive
     * duck-type (Redux requires dispatch, Zustand requires setState, Pinia requires
     * the $-prefixed surface, Jotai requires the wrapped { store, atoms } shape).
     */
    const STORE_ADAPTERS = Object.freeze([
        reduxAdapter,
        zustandAdapter,
        piniaAdapter,
        jotaiAdapter,
    ]);
    /**
     * Try each registered adapter against the scope in priority order. Returns the
     * first { framework, handle } whose detect() yields a store, or null when no
     * registered framework's store is present.
     *
     * When `framework` is supplied, only the adapter with that framework tag is
     * consulted (explicit selection from the store_* tool's framework arg); an
     * unknown framework tag yields null.
     */
    const detectStore = (scope, ctx, framework) => {
        const candidates = framework === undefined
            ? STORE_ADAPTERS
            : STORE_ADAPTERS.filter((a) => a.framework === framework);
        for (const adapter of candidates) {
            const handle = adapter.detect(scope, ctx);
            if (handle !== null) {
                return Object.freeze({ framework: adapter.framework, handle });
            }
        }
        return null;
    };

    /**
     * Page-world Pinia auto-discovery — finds live Pinia stores WITHOUT the explicit
     * window.__pwaDebug_pinia handoff (M37).
     *
     * How: Pinia's `app.use(pinia)` install sets `app.config.globalProperties.$pinia`
     * to the active Pinia instance (Vue 3), and that instance keeps every
     * instantiated store in its `_s` registry (a Map<storeId, store>). So we walk
     * the page's Vue mount roots — reusing the vue module's findVueRoots/getVueApp
     * rather than duplicating __vue_app__ walking — read `$pinia` off each app, and
     * collect the registered store instances.
     *
     * This is the sole DOM-touching part of Pinia detection; it is injected into the
     * pinia adapter via the framework-agnostic DetectContext.piniaGetStores seam so
     * the adapter and detect.ts stay pure (duck-typed reads only).
     */
    /** Key Pinia attaches its active instance under on app.config.globalProperties. */
    const PINIA_GLOBAL_KEY = '$pinia';
    /** Pull Pinia-shaped store instances out of a Pinia instance's `_s` registry Map. */
    const storesFromPiniaInstance = (pinia) => {
        const registry = pinia?._s;
        if (!(registry instanceof Map))
            return [];
        const out = [];
        for (const store of registry.values()) {
            if (isPiniaLike(store))
                out.push(store);
        }
        return out;
    };
    /**
     * Auto-discover live Pinia stores across the document's Vue apps. Walks mount
     * roots in document order, reads each app's config.globalProperties.$pinia, and
     * collects its registered stores. Pinia instances are de-duped (one $pinia is
     * shared by all apps that called app.use(pinia)), so each registry is scanned
     * once. Returns [] when no Vue app exposes a Pinia instance.
     */
    const discoverPiniaStores = (doc) => {
        const seenInstances = new Set();
        const out = [];
        for (const el of findVueRoots(doc)) {
            const pinia = getVueApp(el)?.config?.globalProperties?.[PINIA_GLOBAL_KEY];
            if (pinia == null || seenInstances.has(pinia))
                continue;
            seenInstances.add(pinia);
            out.push(...storesFromPiniaInstance(pinia));
        }
        return out;
    };

    /**
     * React fiber-tree Context-value collector.
     *
     * Walks every React root's committed fiber tree and returns the `value` held by
     * each Context provider fiber — i.e. whatever an app passed to
     * `<SomeContext.Provider value={…}>` (React ≤18) or `<SomeContext value={…}>`
     * (React 19). This is the passive, read-only foundation for zero-config store
     * discovery: store libraries that integrate with React keep their store on a
     * context (react-redux's ReactReduxContext value carries `{ store }`; Jotai's
     * Provider context value IS the createStore() instance), so store adapters
     * duck-type these collected values rather than our extension ever sitting in
     * the app's store-creation path.
     *
     * Pure: DOM reads + fiber reads only (no chrome.*, no mutation).
     */
    // Provider identity across React majors. React ≤18 renders a Provider whose
    // `fiber.type` is the provider object ($$typeof === react.provider, with a
    // `_context` back-reference). React 19 lets `<Context>` itself be the provider,
    // so `fiber.type` carries $$typeof === react.context. Matching on these symbols
    // (plus the `_context` shape) is version-resilient where tag numbers are not.
    const PROVIDER = Symbol.for('react.provider');
    const CONTEXT = Symbol.for('react.context');
    const isContextProviderType = (type) => {
        if (type === null || typeof type !== 'object')
            return false;
        const t = type;
        return (t.$$typeof === PROVIDER ||
            t.$$typeof === CONTEXT ||
            t._context !== undefined);
    };
    // The context value lives on the provider fiber's memoizedProps.value. Only
    // object values can be a store, so non-objects are skipped at the source.
    const providerObjectValue = (fiber) => {
        if (!isContextProviderType(fiber.type))
            return null;
        const props = fiber.memoizedProps;
        if (props === null || typeof props !== 'object')
            return null;
        const value = props.value;
        return value !== null && typeof value === 'object' ? value : null;
    };
    /**
     * Collect the object-typed context `value` of every Context provider fiber
     * across all React roots in `doc`, in tree order and de-duplicated by reference.
     * Callers duck-type the results for the store shape they recognize (react-redux
     * `{ store }`, Jotai store, …). Returns [] when no React roots or providers are
     * present.
     */
    const collectContextValues = (doc) => {
        const seen = new Set();
        const out = [];
        for (const rootEl of findReactRoots(doc)) {
            const root = getRootFiber(rootEl);
            if (root === undefined)
                continue;
            walkFiber(root, (fiber) => {
                const value = providerObjectValue(fiber);
                if (value !== null && !seen.has(value)) {
                    seen.add(value);
                    out.push(value);
                }
            });
        }
        return out;
    };

    /**
     * Page-world Redux auto-discovery — finds live react-redux stores WITHOUT the
     * explicit window.__pwaDebug_redux handoff, by reading them PASSIVELY from the
     * React fiber tree (M46).
     *
     * How: react-redux's `<Provider store={store}>` puts the store on
     * ReactReduxContext; the context value is `{ store, subscription, … }`. We
     * collect every React context value (react/collect_context_values) and duck-type
     * for a Redux store — either `value.store` (react-redux's shape) or `value`
     * itself (defensive, for setups that put a store-shaped object on a context).
     *
     * Read-only: this NEVER participates in the app's store-creation path (unlike
     * the removed __REDUX_DEVTOOLS_EXTENSION__ shim), so it cannot break the host
     * app. Injected into the redux adapter via DetectContext.reduxGetStores so
     * detect.ts stays DOM-free.
     */
    const reduxStoreFromContextValue = (value) => {
        const store = value.store;
        if (isReduxLike(store))
            return store;
        if (isReduxLike(value))
            return value;
        return null;
    };
    /**
     * Auto-discover live react-redux stores across the document's React roots.
     * Walks every Context provider value and extracts the redux store from the
     * react-redux context shape. De-duped by reference; [] when none found.
     */
    const discoverReduxStores = (doc) => {
        const seen = new Set();
        const out = [];
        for (const value of collectContextValues(doc)) {
            const store = reduxStoreFromContextValue(value);
            if (store !== null && !seen.has(store)) {
                seen.add(store);
                out.push(store);
            }
        }
        return out;
    };

    /**
     * Page-world Jotai auto-discovery — finds live Jotai stores WITHOUT the explicit
     * window.__pwaDebug_jotai handoff (M44), by reading them PASSIVELY from the
     * React fiber tree.
     *
     * How: Jotai's `<Provider store={store}>` puts the createStore() instance ON the
     * Provider's React context — and the context value IS that store ({ get, set,
     * sub }), unlike react-redux which wraps it as `{ store }`. So we collect every
     * React context value (react/collect_context_values, shared with the redux
     * discoverer) and duck-type each for the bare Jotai store surface.
     *
     * Limitation: a Jotai app that uses the module-internal DEFAULT store (no
     * <Provider store>) keeps no store on any context, so the fiber walk cannot find
     * it — those apps still need the explicit handoff. Atom ENUMERATION off a found
     * store is handled separately by ./dev_discover.
     *
     * Read-only: never participates in the app's store-creation path. Injected into
     * the jotai adapter via DetectContext.jotaiGetStores so the adapter and detect.ts
     * stay DOM-free.
     */
    /**
     * Auto-discover live Jotai stores across the document's React roots. Walks every
     * Context provider value and keeps those matching the bare Jotai store surface.
     * De-duped by reference; [] when no React roots or no Jotai-shaped context value
     * is present.
     */
    const discoverJotaiStores = (doc) => {
        const seen = new Set();
        const out = [];
        for (const value of collectContextValues(doc)) {
            if (isJotaiStore(value) && !seen.has(value)) {
                seen.add(value);
                out.push(value);
            }
        }
        return out;
    };

    /**
     * JSONPath-lite getter: walk a value by a dot+bracket path with deterministic
     * error reporting. Used by `redux.get_state` (and forthcoming `redux.subscribe`)
     * to let AI clients drill into a single slice instead of dumping the whole
     * store tree.
     *
     * Grammar:
     *   path        := token ('.' token | bracket)*
     *   token       := /[A-Za-z_$][A-Za-z0-9_$]+/
     *   bracket     := '[' (integer | quotedString) ']'
     *   quotedString:= "'" any-but-quote* "'" | '"' any-but-quote* '"'
     *
     * Semantics:
     *   - undefined or empty path => identity (returns root unchanged).
     *   - bracket-integer = numeric index (non-negative); out-of-range => ok:true
     *     with value=undefined (mirrors JS access).
     *   - bracket-string = property name; allows symbols not legal as bare tokens.
     *   - descent into a primitive (string/number/bool/null/undefined) at any
     *     intermediate step => ok:false with informative error.
     *
     * Pure. No regex over the input on every getValueAtPath call past the
     * single tokenize pass.
     */
    const NAME_CHAR = /^[A-Za-z0-9_$]$/;
    const NAME_START = /^[A-Za-z_$]$/;
    const tokenize = (path) => {
        const steps = [];
        const len = path.length;
        let i = 0;
        let expectingName = true;
        while (i < len) {
            const c = path.charAt(i);
            if (c === '.') {
                if (expectingName) {
                    return { ok: false, error: `unexpected '.' at position ${i}` };
                }
                expectingName = true;
                i++;
                continue;
            }
            if (c === '[') {
                const end = path.indexOf(']', i + 1);
                if (end === -1) {
                    return { ok: false, error: `unclosed '[' at position ${i}` };
                }
                const inner = path.slice(i + 1, end);
                if (inner.length === 0) {
                    return { ok: false, error: `empty bracket at position ${i}` };
                }
                if ((inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2) ||
                    (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2)) {
                    steps.push({ kind: 'name', key: inner.slice(1, -1) });
                }
                else if (/^\d+$/.test(inner)) {
                    steps.push({ kind: 'index', idx: Number.parseInt(inner, 10) });
                }
                else {
                    return {
                        ok: false,
                        error: `invalid bracket content "${inner}" at position ${i}`,
                    };
                }
                expectingName = false;
                i = end + 1;
                continue;
            }
            if (expectingName) {
                if (!NAME_START.test(c)) {
                    return {
                        ok: false,
                        error: `unexpected '${c}' at position ${i}; expected name start`,
                    };
                }
                let j = i + 1;
                while (j < len && NAME_CHAR.test(path.charAt(j)))
                    j++;
                steps.push({ kind: 'name', key: path.slice(i, j) });
                expectingName = false;
                i = j;
                continue;
            }
            return { ok: false, error: `unexpected '${c}' at position ${i}` };
        }
        if (expectingName && steps.length === 0) {
            return { ok: true, steps: [] };
        }
        if (expectingName) {
            return { ok: false, error: `path ends with trailing '.'` };
        }
        return { ok: true, steps };
    };
    const isContainer = (v) => v !== null && (typeof v === 'object' || typeof v === 'function');
    const getValueAtPath = (root, path) => {
        if (path === undefined || path.length === 0) {
            return { ok: true, value: root };
        }
        const tok = tokenize(path);
        if (!tok.ok)
            return { ok: false, error: tok.error };
        let cur = root;
        for (let i = 0; i < tok.steps.length; i++) {
            const step = tok.steps[i];
            if (!isContainer(cur)) {
                return {
                    ok: false,
                    error: `cannot descend into ${typeof cur === 'object' ? 'null' : typeof cur} at step ${i}`,
                };
            }
            if (step.kind === 'index') {
                cur = cur[step.idx];
            }
            else {
                cur = cur[step.key];
            }
        }
        return { ok: true, value: cur };
    };

    /**
     * Thin adapter that wraps captures/serialize's array-shaped serializeArgs for
     * single-value Redux state slices. Reuses the same 16KB cap, cycle protection,
     * DOM/Error/function tagging, so redux.* tools never duplicate serialization
     * logic that already lives in captures.
     */
    const serializeStoreValue = (value) => {
        const r = serializeArgs$1([value]);
        return { value: r.serialized[0], truncated: r.truncated };
    };

    // Single source of truth for opaque correlation-id generation.
    //
    // crypto.randomUUID() is unavailable on insecure origins (e.g.
    // http://<LAN-IP> debug targets) and old runtimes — a real pwa-debug use
    // case. Every id generator must therefore guard the call; this collapses
    // the four hand-rolled guards (capture_fetch/xhr/websocket defaultIdGen +
    // frame_meta cross-origin fallback) and the one UNGUARDED site
    // (cs_dispatcher's default generateRequestId, which threw on such origins).
    const cryptoRandomUUID = () => {
        const c = globalThis.crypto;
        return typeof c?.randomUUID === 'function' ? c.randomUUID() : undefined;
    };
    const fallback = (prefix) => `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    // crypto.randomUUID() when available, else `${fallbackPrefix}<ts36>_<rand36>`.
    // fallbackPrefix namespaces ONLY the fallback path, exactly preserving the
    // prior per-producer f_/x_/w_ discriminators.
    const safeRandomId = (fallbackPrefix = '') => cryptoRandomUUID() ?? fallback(fallbackPrefix);
    // No-prefix convenience: the crypto-absent-safe replacement for a bare
    // `crypto.randomUUID()` call.
    const safeUuid = () => safeRandomId();

    const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    /**
     * Pure shallow diff at the top level of two values. Returns undefined when
     * the values are === or when both are non-objects of the same value. Otherwise
     * names the top-level keys that were added/changed/removed between prev and
     * next. For non-object values, the diff treats the whole thing as a single
     * 'value' field that's either changed or unchanged.
     */
    const computeShallowDiff = (prev, next) => {
        if (prev === next)
            return undefined;
        if (!isPlainObject(prev) || !isPlainObject(next)) {
            return { added: [], changed: ['value'], removed: [] };
        }
        const added = [];
        const changed = [];
        const removed = [];
        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(next);
        const prevSet = new Set(prevKeys);
        const nextSet = new Set(nextKeys);
        for (const k of nextKeys) {
            if (!prevSet.has(k)) {
                added.push(k);
            }
            else if (prev[k] !== next[k]) {
                changed.push(k);
            }
        }
        for (const k of prevKeys) {
            if (!nextSet.has(k))
                removed.push(k);
        }
        if (added.length === 0 && changed.length === 0 && removed.length === 0) {
            return undefined;
        }
        return { added, changed, removed };
    };
    /**
     * Install a store.subscribe handler. Returns a Disposer that tears it down.
     * Each store update reads the current state, narrows by `path` (if provided),
     * diffs against the previous narrowed snapshot, and emits a
     * StoreChangeCapturedEvent when the diff is non-empty.
     */
    const installStoreSubscription = (opts) => {
        const now = opts.now ?? Date.now;
        const storeId = opts.storeId ?? safeRandomId();
        // Seed prev with the initial state so the first real change emits a diff.
        let prev;
        const initialPath = getValueAtPath(opts.store.getState(), opts.path);
        prev = initialPath.ok ? initialPath.value : undefined;
        const listener = () => {
            const state = opts.store.getState();
            const picked = getValueAtPath(state, opts.path);
            if (!picked.ok)
                return; // path went malformed; drop silently (settings.set should reject)
            const next = picked.value;
            const diff = computeShallowDiff(prev, next);
            if (diff === undefined)
                return;
            const serialized = serializeStoreValue(next);
            const event = {
                kind: 'store_change',
                ts: now(),
                frameUrl: opts.frame.frameUrl,
                frameKey: opts.frame.frameKey,
                storeId,
                diff,
                snapshot: serialized.value,
                ...(opts.framework !== undefined ? { framework: opts.framework } : {}),
                ...(opts.path !== undefined ? { path: opts.path } : {}),
                ...(serialized.truncated ? { truncated: true } : {}),
            };
            opts.emit(event);
            prev = next;
        };
        const unsubscribe = opts.store.subscribe(listener);
        return () => {
            unsubscribe();
        };
    };

    /**
     * Locate the source-map URL for a script. Scans the tail of the script text
     * for canonical //# sourceMappingURL=... (or deprecated //@) comments and
     * resolves the URL against the script's own URL. Data URLs are returned as-is
     * (a future step would base64-decode them; out of scope for M13 T1).
     *
     * Pure.
     */
    const TAIL_BYTES = 4096;
    // Matches //# sourceMappingURL=<url>  or //@ sourceMappingURL=<url>
    const MAPPING_URL_RE = /\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*$/im;
    const discoverSourceMapUrl = (scriptUrl, scriptText) => {
        const tail = scriptText.length > TAIL_BYTES
            ? scriptText.slice(scriptText.length - TAIL_BYTES)
            : scriptText;
        const match = MAPPING_URL_RE.exec(tail);
        if (match === null)
            return null;
        const raw = match[1];
        if (raw === undefined || raw.length === 0)
            return null;
        if (raw.startsWith('data:'))
            return raw;
        try {
            return new URL(raw, scriptUrl).toString();
        }
        catch {
            return null;
        }
    };

    const findSegment = (segs, col) => {
        if (segs.length === 0)
            return undefined;
        let lo = 0;
        let hi = segs.length - 1;
        let best;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const seg = segs[mid];
            if (seg.genCol <= col) {
                best = seg;
                lo = mid + 1;
            }
            else {
                hi = mid - 1;
            }
        }
        return best;
    };
    const resolveLocation = (map, line, column) => {
        if (!Number.isInteger(line) || line < 1)
            return null;
        if (!Number.isInteger(column) || column < 0)
            return null;
        const lineIdx = line - 1;
        if (lineIdx >= map.lines.length)
            return null;
        const segs = map.lines[lineIdx];
        if (segs === undefined)
            return null;
        const seg = findSegment(segs, column);
        if (seg === undefined)
            return null;
        if (seg.sourceIdx === undefined ||
            seg.origLine === undefined ||
            seg.origCol === undefined) {
            return null;
        }
        const source = map.sources[seg.sourceIdx];
        if (source === undefined)
            return null;
        const out = {
            source,
            line: seg.origLine + 1, // sourcemaps are 0-based original lines
            column: seg.origCol,
        };
        if (seg.nameIdx !== undefined) {
            const name = map.names[seg.nameIdx];
            if (name !== undefined)
                out.name = name;
        }
        return Object.freeze(out);
    };

    /**
     * Base64 VLQ (variable-length quantity) decoder used by Source Map v3.
     *
     * Each character encodes 6 bits. The lowest bit of the FIRST 6-bit group is
     * the sign bit; every subsequent 6-bit group's high bit is the continuation
     * flag. Values are little-endian within the encoded form.
     *
     * Pure: no I/O, no mutation past the local accumulators.
     */
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const CHAR_TO_VAL = (() => {
        const m = {};
        for (let i = 0; i < ALPHABET.length; i++) {
            m[ALPHABET.charAt(i)] = i;
        }
        return m;
    })();
    const CONTINUATION_BIT = 1 << 5; // 0b100000
    const VALUE_MASK = (1 << 5) - 1; // 0b011111
    const decodeVlqList = (s) => {
        const out = [];
        let value = 0;
        let shift = 0;
        for (let i = 0; i < s.length; i++) {
            const ch = s.charAt(i);
            const digit = CHAR_TO_VAL[ch];
            if (digit === undefined) {
                return { ok: false, error: `invalid base64 char '${ch}' at ${i}` };
            }
            const continuation = (digit & CONTINUATION_BIT) !== 0;
            const payload = digit & VALUE_MASK;
            value |= payload << shift;
            if (continuation) {
                shift += 5;
                continue;
            }
            const negative = (value & 1) === 1;
            const magnitude = value >>> 1;
            out.push(negative ? -magnitude : magnitude);
            value = 0;
            shift = 0;
        }
        if (shift !== 0) {
            return { ok: false, error: 'truncated VLQ — last value missing terminator' };
        }
        return { ok: true, values: out };
    };

    /**
     * Source Map v3 parser. Validates root structure, pre-decodes the mappings
     * string into per-generated-line sorted segments so resolveLocation only
     * needs a binary search.
     *
     * Pure: input is a JSON-parsed unknown; output is the pre-computed structure
     * (or null on validation failure). No fetch, no fs.
     */
    const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
    const parseSourceMap = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        if (r['version'] !== 3)
            return null;
        if (!isStringArray(r['sources']))
            return null;
        if (typeof r['mappings'] !== 'string')
            return null;
        const names = isStringArray(r['names']) ? r['names'] : [];
        const sources = r['sources'];
        const mappings = r['mappings'];
        const lines = [];
        // Delta accumulators across the whole map for source/origLine/origCol/name;
        // reset across lines is NOT done for genCol — genCol resets per line.
        let prevSourceIdx = 0;
        let prevOrigLine = 0;
        let prevOrigCol = 0;
        let prevNameIdx = 0;
        for (const lineStr of mappings.split(';')) {
            const segments = [];
            let prevGenCol = 0;
            if (lineStr.length > 0) {
                for (const segStr of lineStr.split(',')) {
                    if (segStr.length === 0)
                        continue;
                    const decoded = decodeVlqList(segStr);
                    if (!decoded.ok)
                        return null;
                    const v = decoded.values;
                    if (v.length === 0)
                        continue;
                    const genCol = prevGenCol + (v[0] ?? 0);
                    prevGenCol = genCol;
                    if (v.length === 1) {
                        segments.push({ genCol });
                        continue;
                    }
                    if (v.length < 4)
                        return null; // segments are 1, 4, or 5 fields
                    const sourceIdx = prevSourceIdx + (v[1] ?? 0);
                    const origLine = prevOrigLine + (v[2] ?? 0);
                    const origCol = prevOrigCol + (v[3] ?? 0);
                    prevSourceIdx = sourceIdx;
                    prevOrigLine = origLine;
                    prevOrigCol = origCol;
                    if (v.length === 5) {
                        const nameIdx = prevNameIdx + (v[4] ?? 0);
                        prevNameIdx = nameIdx;
                        segments.push({ genCol, sourceIdx, origLine, origCol, nameIdx });
                    }
                    else {
                        segments.push({ genCol, sourceIdx, origLine, origCol });
                    }
                }
            }
            lines.push(segments);
        }
        return Object.freeze({
            version: 3,
            sources: Object.freeze([...sources]),
            names: Object.freeze([...names]),
            lines: Object.freeze(lines.map((l) => Object.freeze(l))),
        });
    };

    /**
     * LRU cache + fetcher for parsed source maps.
     *
     * - Cache key is the absolute map URL (or data: URL).
     * - On miss: fetches via the injected fetcher (defaults to globalThis.fetch),
     *   JSON-parses, validates via parseSourceMap.
     * - Parse/fetch failures are cached as `null` so repeated lookups don't re-fetch.
     *   This is intentional within a single page session; a future invalidation
     *   mechanism (ETag-aware) can replace this when we add capture-time annotation.
     *
     * Closure-based — no module state, factory returns the public surface.
     */
    const DEFAULT_CAPACITY = 64;
    const createSourcemapCache = (opts = {}) => {
        const capacity = opts.capacity ?? DEFAULT_CAPACITY;
        const fetcher = opts.fetcher ??
            ((url) => globalThis.fetch(url));
        // Map preserves insertion order; we delete + re-set on get to bump to MRU.
        const cache = new Map();
        const touch = (url, value) => {
            cache.delete(url);
            cache.set(url, value);
            while (cache.size > capacity) {
                const oldest = cache.keys().next().value;
                if (oldest === undefined)
                    break;
                cache.delete(oldest);
            }
        };
        const get = async (url) => {
            if (cache.has(url)) {
                const cached = cache.get(url) ?? null;
                // Bump to MRU even on null hits.
                touch(url, cached);
                return cached;
            }
            let parsed = null;
            try {
                const res = await fetcher(url);
                if (res.ok) {
                    const json = (await res.json());
                    parsed = parseSourceMap(json);
                }
            }
            catch {
                parsed = null;
            }
            touch(url, parsed);
            return parsed;
        };
        return Object.freeze({
            get,
            clear: () => cache.clear(),
            size: () => cache.size,
        });
    };

    var NodeType;
    (function (NodeType) {
        NodeType[NodeType["Document"] = 0] = "Document";
        NodeType[NodeType["DocumentType"] = 1] = "DocumentType";
        NodeType[NodeType["Element"] = 2] = "Element";
        NodeType[NodeType["Text"] = 3] = "Text";
        NodeType[NodeType["CDATA"] = 4] = "CDATA";
        NodeType[NodeType["Comment"] = 5] = "Comment";
    })(NodeType || (NodeType = {}));

    function isElement(n) {
        return n.nodeType === n.ELEMENT_NODE;
    }
    function isShadowRoot(n) {
        var host = n === null || n === void 0 ? void 0 : n.host;
        return Boolean((host === null || host === void 0 ? void 0 : host.shadowRoot) === n);
    }
    function isNativeShadowDom(shadowRoot) {
        return Object.prototype.toString.call(shadowRoot) === '[object ShadowRoot]';
    }
    function fixBrowserCompatibilityIssuesInCSS(cssText) {
        if (cssText.includes(' background-clip: text;') &&
            !cssText.includes(' -webkit-background-clip: text;')) {
            cssText = cssText.replace(' background-clip: text;', ' -webkit-background-clip: text; background-clip: text;');
        }
        return cssText;
    }
    function getCssRulesString(s) {
        try {
            var rules = s.rules || s.cssRules;
            return rules
                ? fixBrowserCompatibilityIssuesInCSS(Array.from(rules).map(getCssRuleString).join(''))
                : null;
        }
        catch (error) {
            return null;
        }
    }
    function getCssRuleString(rule) {
        var cssStringified = rule.cssText;
        if (isCSSImportRule(rule)) {
            try {
                cssStringified = getCssRulesString(rule.styleSheet) || cssStringified;
            }
            catch (_a) {
            }
        }
        return cssStringified;
    }
    function isCSSImportRule(rule) {
        return 'styleSheet' in rule;
    }
    var Mirror = (function () {
        function Mirror() {
            this.idNodeMap = new Map();
            this.nodeMetaMap = new WeakMap();
        }
        Mirror.prototype.getId = function (n) {
            var _a;
            if (!n)
                return -1;
            var id = (_a = this.getMeta(n)) === null || _a === void 0 ? void 0 : _a.id;
            return id !== null && id !== void 0 ? id : -1;
        };
        Mirror.prototype.getNode = function (id) {
            return this.idNodeMap.get(id) || null;
        };
        Mirror.prototype.getIds = function () {
            return Array.from(this.idNodeMap.keys());
        };
        Mirror.prototype.getMeta = function (n) {
            return this.nodeMetaMap.get(n) || null;
        };
        Mirror.prototype.removeNodeFromMap = function (n) {
            var _this = this;
            var id = this.getId(n);
            this.idNodeMap["delete"](id);
            if (n.childNodes) {
                n.childNodes.forEach(function (childNode) {
                    return _this.removeNodeFromMap(childNode);
                });
            }
        };
        Mirror.prototype.has = function (id) {
            return this.idNodeMap.has(id);
        };
        Mirror.prototype.hasNode = function (node) {
            return this.nodeMetaMap.has(node);
        };
        Mirror.prototype.add = function (n, meta) {
            var id = meta.id;
            this.idNodeMap.set(id, n);
            this.nodeMetaMap.set(n, meta);
        };
        Mirror.prototype.replace = function (id, n) {
            var oldNode = this.getNode(id);
            if (oldNode) {
                var meta = this.nodeMetaMap.get(oldNode);
                if (meta)
                    this.nodeMetaMap.set(n, meta);
            }
            this.idNodeMap.set(id, n);
        };
        Mirror.prototype.reset = function () {
            this.idNodeMap = new Map();
            this.nodeMetaMap = new WeakMap();
        };
        return Mirror;
    }());
    function createMirror() {
        return new Mirror();
    }
    function maskInputValue(_a) {
        var maskInputOptions = _a.maskInputOptions, tagName = _a.tagName, type = _a.type, value = _a.value, maskInputFn = _a.maskInputFn;
        var text = value || '';
        if (maskInputOptions[tagName.toLowerCase()] ||
            maskInputOptions[type]) {
            if (maskInputFn) {
                text = maskInputFn(text);
            }
            else {
                text = '*'.repeat(text.length);
            }
        }
        return text;
    }
    var ORIGINAL_ATTRIBUTE_NAME = '__rrweb_original__';
    function is2DCanvasBlank(canvas) {
        var ctx = canvas.getContext('2d');
        if (!ctx)
            return true;
        var chunkSize = 50;
        for (var x = 0; x < canvas.width; x += chunkSize) {
            for (var y = 0; y < canvas.height; y += chunkSize) {
                var getImageData = ctx.getImageData;
                var originalGetImageData = ORIGINAL_ATTRIBUTE_NAME in getImageData
                    ? getImageData[ORIGINAL_ATTRIBUTE_NAME]
                    : getImageData;
                var pixelBuffer = new Uint32Array(originalGetImageData.call(ctx, x, y, Math.min(chunkSize, canvas.width - x), Math.min(chunkSize, canvas.height - y)).data.buffer);
                if (pixelBuffer.some(function (pixel) { return pixel !== 0; }))
                    return false;
            }
        }
        return true;
    }

    var _id = 1;
    var tagNameRegex = new RegExp('[^a-z0-9-_:]');
    var IGNORED_NODE = -2;
    function genId() {
        return _id++;
    }
    function getValidTagName(element) {
        if (element instanceof HTMLFormElement) {
            return 'form';
        }
        var processedTagName = element.tagName.toLowerCase().trim();
        if (tagNameRegex.test(processedTagName)) {
            return 'div';
        }
        return processedTagName;
    }
    function stringifyStyleSheet(sheet) {
        return sheet.cssRules
            ? Array.from(sheet.cssRules)
                .map(function (rule) { return rule.cssText || ''; })
                .join('')
            : '';
    }
    function extractOrigin(url) {
        var origin = '';
        if (url.indexOf('//') > -1) {
            origin = url.split('/').slice(0, 3).join('/');
        }
        else {
            origin = url.split('/')[0];
        }
        origin = origin.split('?')[0];
        return origin;
    }
    var canvasService;
    var canvasCtx;
    var URL_IN_CSS_REF = /url\((?:(')([^']*)'|(")(.*?)"|([^)]*))\)/gm;
    var RELATIVE_PATH = /^(?!www\.|(?:http|ftp)s?:\/\/|[A-Za-z]:\\|\/\/|#).*/;
    var DATA_URI = /^(data:)([^,]*),(.*)/i;
    function absoluteToStylesheet(cssText, href) {
        return (cssText || '').replace(URL_IN_CSS_REF, function (origin, quote1, path1, quote2, path2, path3) {
            var filePath = path1 || path2 || path3;
            var maybeQuote = quote1 || quote2 || '';
            if (!filePath) {
                return origin;
            }
            if (!RELATIVE_PATH.test(filePath)) {
                return "url(".concat(maybeQuote).concat(filePath).concat(maybeQuote, ")");
            }
            if (DATA_URI.test(filePath)) {
                return "url(".concat(maybeQuote).concat(filePath).concat(maybeQuote, ")");
            }
            if (filePath[0] === '/') {
                return "url(".concat(maybeQuote).concat(extractOrigin(href) + filePath).concat(maybeQuote, ")");
            }
            var stack = href.split('/');
            var parts = filePath.split('/');
            stack.pop();
            for (var _i = 0, parts_1 = parts; _i < parts_1.length; _i++) {
                var part = parts_1[_i];
                if (part === '.') {
                    continue;
                }
                else if (part === '..') {
                    stack.pop();
                }
                else {
                    stack.push(part);
                }
            }
            return "url(".concat(maybeQuote).concat(stack.join('/')).concat(maybeQuote, ")");
        });
    }
    var SRCSET_NOT_SPACES = /^[^ \t\n\r\u000c]+/;
    var SRCSET_COMMAS_OR_SPACES = /^[, \t\n\r\u000c]+/;
    function getAbsoluteSrcsetString(doc, attributeValue) {
        if (attributeValue.trim() === '') {
            return attributeValue;
        }
        var pos = 0;
        function collectCharacters(regEx) {
            var chars;
            var match = regEx.exec(attributeValue.substring(pos));
            if (match) {
                chars = match[0];
                pos += chars.length;
                return chars;
            }
            return '';
        }
        var output = [];
        while (true) {
            collectCharacters(SRCSET_COMMAS_OR_SPACES);
            if (pos >= attributeValue.length) {
                break;
            }
            var url = collectCharacters(SRCSET_NOT_SPACES);
            if (url.slice(-1) === ',') {
                url = absoluteToDoc(doc, url.substring(0, url.length - 1));
                output.push(url);
            }
            else {
                var descriptorsStr = '';
                url = absoluteToDoc(doc, url);
                var inParens = false;
                while (true) {
                    var c = attributeValue.charAt(pos);
                    if (c === '') {
                        output.push((url + descriptorsStr).trim());
                        break;
                    }
                    else if (!inParens) {
                        if (c === ',') {
                            pos += 1;
                            output.push((url + descriptorsStr).trim());
                            break;
                        }
                        else if (c === '(') {
                            inParens = true;
                        }
                    }
                    else {
                        if (c === ')') {
                            inParens = false;
                        }
                    }
                    descriptorsStr += c;
                    pos += 1;
                }
            }
        }
        return output.join(', ');
    }
    function absoluteToDoc(doc, attributeValue) {
        if (!attributeValue || attributeValue.trim() === '') {
            return attributeValue;
        }
        var a = doc.createElement('a');
        a.href = attributeValue;
        return a.href;
    }
    function isSVGElement(el) {
        return Boolean(el.tagName === 'svg' || el.ownerSVGElement);
    }
    function getHref() {
        var a = document.createElement('a');
        a.href = '';
        return a.href;
    }
    function transformAttribute(doc, tagName, name, value) {
        if (name === 'src' ||
            (name === 'href' && value && !(tagName === 'use' && value[0] === '#'))) {
            return absoluteToDoc(doc, value);
        }
        else if (name === 'xlink:href' && value && value[0] !== '#') {
            return absoluteToDoc(doc, value);
        }
        else if (name === 'background' &&
            value &&
            (tagName === 'table' || tagName === 'td' || tagName === 'th')) {
            return absoluteToDoc(doc, value);
        }
        else if (name === 'srcset' && value) {
            return getAbsoluteSrcsetString(doc, value);
        }
        else if (name === 'style' && value) {
            return absoluteToStylesheet(value, getHref());
        }
        else if (tagName === 'object' && name === 'data' && value) {
            return absoluteToDoc(doc, value);
        }
        else {
            return value;
        }
    }
    function _isBlockedElement(element, blockClass, blockSelector) {
        if (typeof blockClass === 'string') {
            if (element.classList.contains(blockClass)) {
                return true;
            }
        }
        else {
            for (var eIndex = element.classList.length; eIndex--;) {
                var className = element.classList[eIndex];
                if (blockClass.test(className)) {
                    return true;
                }
            }
        }
        if (blockSelector) {
            return element.matches(blockSelector);
        }
        return false;
    }
    function classMatchesRegex(node, regex, checkAncestors) {
        if (!node)
            return false;
        if (node.nodeType !== node.ELEMENT_NODE) {
            if (!checkAncestors)
                return false;
            return classMatchesRegex(node.parentNode, regex, checkAncestors);
        }
        for (var eIndex = node.classList.length; eIndex--;) {
            var className = node.classList[eIndex];
            if (regex.test(className)) {
                return true;
            }
        }
        if (!checkAncestors)
            return false;
        return classMatchesRegex(node.parentNode, regex, checkAncestors);
    }
    function needMaskingText(node, maskTextClass, maskTextSelector) {
        var el = node.nodeType === node.ELEMENT_NODE
            ? node
            : node.parentElement;
        if (el === null)
            return false;
        if (typeof maskTextClass === 'string') {
            if (el.classList.contains(maskTextClass))
                return true;
            if (el.closest(".".concat(maskTextClass)))
                return true;
        }
        else {
            if (classMatchesRegex(el, maskTextClass, true))
                return true;
        }
        if (maskTextSelector) {
            if (el.matches(maskTextSelector))
                return true;
            if (el.closest(maskTextSelector))
                return true;
        }
        return false;
    }
    function onceIframeLoaded(iframeEl, listener, iframeLoadTimeout) {
        var win = iframeEl.contentWindow;
        if (!win) {
            return;
        }
        var fired = false;
        var readyState;
        try {
            readyState = win.document.readyState;
        }
        catch (error) {
            return;
        }
        if (readyState !== 'complete') {
            var timer_1 = setTimeout(function () {
                if (!fired) {
                    listener();
                    fired = true;
                }
            }, iframeLoadTimeout);
            iframeEl.addEventListener('load', function () {
                clearTimeout(timer_1);
                fired = true;
                listener();
            });
            return;
        }
        var blankUrl = 'about:blank';
        if (win.location.href !== blankUrl ||
            iframeEl.src === blankUrl ||
            iframeEl.src === '') {
            setTimeout(listener, 0);
            return iframeEl.addEventListener('load', listener);
        }
        iframeEl.addEventListener('load', listener);
    }
    function onceStylesheetLoaded(link, listener, styleSheetLoadTimeout) {
        var fired = false;
        var styleSheetLoaded;
        try {
            styleSheetLoaded = link.sheet;
        }
        catch (error) {
            return;
        }
        if (styleSheetLoaded)
            return;
        var timer = setTimeout(function () {
            if (!fired) {
                listener();
                fired = true;
            }
        }, styleSheetLoadTimeout);
        link.addEventListener('load', function () {
            clearTimeout(timer);
            fired = true;
            listener();
        });
    }
    function serializeNode(n, options) {
        var doc = options.doc, mirror = options.mirror, blockClass = options.blockClass, blockSelector = options.blockSelector, maskTextClass = options.maskTextClass, maskTextSelector = options.maskTextSelector, inlineStylesheet = options.inlineStylesheet, _a = options.maskInputOptions, maskInputOptions = _a === void 0 ? {} : _a, maskTextFn = options.maskTextFn, maskInputFn = options.maskInputFn, _b = options.dataURLOptions, dataURLOptions = _b === void 0 ? {} : _b, inlineImages = options.inlineImages, recordCanvas = options.recordCanvas, keepIframeSrcFn = options.keepIframeSrcFn, _c = options.newlyAddedElement, newlyAddedElement = _c === void 0 ? false : _c;
        var rootId = getRootId(doc, mirror);
        switch (n.nodeType) {
            case n.DOCUMENT_NODE:
                if (n.compatMode !== 'CSS1Compat') {
                    return {
                        type: NodeType.Document,
                        childNodes: [],
                        compatMode: n.compatMode
                    };
                }
                else {
                    return {
                        type: NodeType.Document,
                        childNodes: []
                    };
                }
            case n.DOCUMENT_TYPE_NODE:
                return {
                    type: NodeType.DocumentType,
                    name: n.name,
                    publicId: n.publicId,
                    systemId: n.systemId,
                    rootId: rootId
                };
            case n.ELEMENT_NODE:
                return serializeElementNode(n, {
                    doc: doc,
                    blockClass: blockClass,
                    blockSelector: blockSelector,
                    inlineStylesheet: inlineStylesheet,
                    maskInputOptions: maskInputOptions,
                    maskInputFn: maskInputFn,
                    dataURLOptions: dataURLOptions,
                    inlineImages: inlineImages,
                    recordCanvas: recordCanvas,
                    keepIframeSrcFn: keepIframeSrcFn,
                    newlyAddedElement: newlyAddedElement,
                    rootId: rootId
                });
            case n.TEXT_NODE:
                return serializeTextNode(n, {
                    maskTextClass: maskTextClass,
                    maskTextSelector: maskTextSelector,
                    maskTextFn: maskTextFn,
                    rootId: rootId
                });
            case n.CDATA_SECTION_NODE:
                return {
                    type: NodeType.CDATA,
                    textContent: '',
                    rootId: rootId
                };
            case n.COMMENT_NODE:
                return {
                    type: NodeType.Comment,
                    textContent: n.textContent || '',
                    rootId: rootId
                };
            default:
                return false;
        }
    }
    function getRootId(doc, mirror) {
        if (!mirror.hasNode(doc))
            return undefined;
        var docId = mirror.getId(doc);
        return docId === 1 ? undefined : docId;
    }
    function serializeTextNode(n, options) {
        var _a;
        var maskTextClass = options.maskTextClass, maskTextSelector = options.maskTextSelector, maskTextFn = options.maskTextFn, rootId = options.rootId;
        var parentTagName = n.parentNode && n.parentNode.tagName;
        var textContent = n.textContent;
        var isStyle = parentTagName === 'STYLE' ? true : undefined;
        var isScript = parentTagName === 'SCRIPT' ? true : undefined;
        if (isStyle && textContent) {
            try {
                if (n.nextSibling || n.previousSibling) {
                }
                else if ((_a = n.parentNode.sheet) === null || _a === void 0 ? void 0 : _a.cssRules) {
                    textContent = stringifyStyleSheet(n.parentNode.sheet);
                }
            }
            catch (err) {
                console.warn("Cannot get CSS styles from text's parentNode. Error: ".concat(err), n);
            }
            textContent = absoluteToStylesheet(textContent, getHref());
        }
        if (isScript) {
            textContent = 'SCRIPT_PLACEHOLDER';
        }
        if (!isStyle &&
            !isScript &&
            textContent &&
            needMaskingText(n, maskTextClass, maskTextSelector)) {
            textContent = maskTextFn
                ? maskTextFn(textContent)
                : textContent.replace(/[\S]/g, '*');
        }
        return {
            type: NodeType.Text,
            textContent: textContent || '',
            isStyle: isStyle,
            rootId: rootId
        };
    }
    function serializeElementNode(n, options) {
        var doc = options.doc, blockClass = options.blockClass, blockSelector = options.blockSelector, inlineStylesheet = options.inlineStylesheet, _a = options.maskInputOptions, maskInputOptions = _a === void 0 ? {} : _a, maskInputFn = options.maskInputFn, _b = options.dataURLOptions, dataURLOptions = _b === void 0 ? {} : _b, inlineImages = options.inlineImages, recordCanvas = options.recordCanvas, keepIframeSrcFn = options.keepIframeSrcFn, _c = options.newlyAddedElement, newlyAddedElement = _c === void 0 ? false : _c, rootId = options.rootId;
        var needBlock = _isBlockedElement(n, blockClass, blockSelector);
        var tagName = getValidTagName(n);
        var attributes = {};
        var len = n.attributes.length;
        for (var i = 0; i < len; i++) {
            var attr = n.attributes[i];
            attributes[attr.name] = transformAttribute(doc, tagName, attr.name, attr.value);
        }
        if (tagName === 'link' && inlineStylesheet) {
            var stylesheet = Array.from(doc.styleSheets).find(function (s) {
                return s.href === n.href;
            });
            var cssText = null;
            if (stylesheet) {
                cssText = getCssRulesString(stylesheet);
            }
            if (cssText) {
                delete attributes.rel;
                delete attributes.href;
                attributes._cssText = absoluteToStylesheet(cssText, stylesheet.href);
            }
        }
        if (tagName === 'style' &&
            n.sheet &&
            !(n.innerText || n.textContent || '').trim().length) {
            var cssText = getCssRulesString(n.sheet);
            if (cssText) {
                attributes._cssText = absoluteToStylesheet(cssText, getHref());
            }
        }
        if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
            var value = n.value;
            var checked = n.checked;
            if (attributes.type !== 'radio' &&
                attributes.type !== 'checkbox' &&
                attributes.type !== 'submit' &&
                attributes.type !== 'button' &&
                value) {
                attributes.value = maskInputValue({
                    type: attributes.type,
                    tagName: tagName,
                    value: value,
                    maskInputOptions: maskInputOptions,
                    maskInputFn: maskInputFn
                });
            }
            else if (checked) {
                attributes.checked = checked;
            }
        }
        if (tagName === 'option') {
            if (n.selected && !maskInputOptions['select']) {
                attributes.selected = true;
            }
            else {
                delete attributes.selected;
            }
        }
        if (tagName === 'canvas' && recordCanvas) {
            if (n.__context === '2d') {
                if (!is2DCanvasBlank(n)) {
                    attributes.rr_dataURL = n.toDataURL(dataURLOptions.type, dataURLOptions.quality);
                }
            }
            else if (!('__context' in n)) {
                var canvasDataURL = n.toDataURL(dataURLOptions.type, dataURLOptions.quality);
                var blankCanvas = document.createElement('canvas');
                blankCanvas.width = n.width;
                blankCanvas.height = n.height;
                var blankCanvasDataURL = blankCanvas.toDataURL(dataURLOptions.type, dataURLOptions.quality);
                if (canvasDataURL !== blankCanvasDataURL) {
                    attributes.rr_dataURL = canvasDataURL;
                }
            }
        }
        if (tagName === 'img' && inlineImages) {
            if (!canvasService) {
                canvasService = doc.createElement('canvas');
                canvasCtx = canvasService.getContext('2d');
            }
            var image_1 = n;
            var oldValue_1 = image_1.crossOrigin;
            image_1.crossOrigin = 'anonymous';
            var recordInlineImage = function () {
                try {
                    canvasService.width = image_1.naturalWidth;
                    canvasService.height = image_1.naturalHeight;
                    canvasCtx.drawImage(image_1, 0, 0);
                    attributes.rr_dataURL = canvasService.toDataURL(dataURLOptions.type, dataURLOptions.quality);
                }
                catch (err) {
                    console.warn("Cannot inline img src=".concat(image_1.currentSrc, "! Error: ").concat(err));
                }
                oldValue_1
                    ? (attributes.crossOrigin = oldValue_1)
                    : image_1.removeAttribute('crossorigin');
            };
            if (image_1.complete && image_1.naturalWidth !== 0)
                recordInlineImage();
            else
                image_1.onload = recordInlineImage;
        }
        if (tagName === 'audio' || tagName === 'video') {
            attributes.rr_mediaState = n.paused
                ? 'paused'
                : 'played';
            attributes.rr_mediaCurrentTime = n.currentTime;
        }
        if (!newlyAddedElement) {
            if (n.scrollLeft) {
                attributes.rr_scrollLeft = n.scrollLeft;
            }
            if (n.scrollTop) {
                attributes.rr_scrollTop = n.scrollTop;
            }
        }
        if (needBlock) {
            var _d = n.getBoundingClientRect(), width = _d.width, height = _d.height;
            attributes = {
                "class": attributes["class"],
                rr_width: "".concat(width, "px"),
                rr_height: "".concat(height, "px")
            };
        }
        if (tagName === 'iframe' && !keepIframeSrcFn(attributes.src)) {
            if (!n.contentDocument) {
                attributes.rr_src = attributes.src;
            }
            delete attributes.src;
        }
        return {
            type: NodeType.Element,
            tagName: tagName,
            attributes: attributes,
            childNodes: [],
            isSVG: isSVGElement(n) || undefined,
            needBlock: needBlock,
            rootId: rootId
        };
    }
    function lowerIfExists(maybeAttr) {
        if (maybeAttr === undefined) {
            return '';
        }
        else {
            return maybeAttr.toLowerCase();
        }
    }
    function slimDOMExcluded(sn, slimDOMOptions) {
        if (slimDOMOptions.comment && sn.type === NodeType.Comment) {
            return true;
        }
        else if (sn.type === NodeType.Element) {
            if (slimDOMOptions.script &&
                (sn.tagName === 'script' ||
                    (sn.tagName === 'link' &&
                        sn.attributes.rel === 'preload' &&
                        sn.attributes.as === 'script') ||
                    (sn.tagName === 'link' &&
                        sn.attributes.rel === 'prefetch' &&
                        typeof sn.attributes.href === 'string' &&
                        sn.attributes.href.endsWith('.js')))) {
                return true;
            }
            else if (slimDOMOptions.headFavicon &&
                ((sn.tagName === 'link' && sn.attributes.rel === 'shortcut icon') ||
                    (sn.tagName === 'meta' &&
                        (lowerIfExists(sn.attributes.name).match(/^msapplication-tile(image|color)$/) ||
                            lowerIfExists(sn.attributes.name) === 'application-name' ||
                            lowerIfExists(sn.attributes.rel) === 'icon' ||
                            lowerIfExists(sn.attributes.rel) === 'apple-touch-icon' ||
                            lowerIfExists(sn.attributes.rel) === 'shortcut icon')))) {
                return true;
            }
            else if (sn.tagName === 'meta') {
                if (slimDOMOptions.headMetaDescKeywords &&
                    lowerIfExists(sn.attributes.name).match(/^description|keywords$/)) {
                    return true;
                }
                else if (slimDOMOptions.headMetaSocial &&
                    (lowerIfExists(sn.attributes.property).match(/^(og|twitter|fb):/) ||
                        lowerIfExists(sn.attributes.name).match(/^(og|twitter):/) ||
                        lowerIfExists(sn.attributes.name) === 'pinterest')) {
                    return true;
                }
                else if (slimDOMOptions.headMetaRobots &&
                    (lowerIfExists(sn.attributes.name) === 'robots' ||
                        lowerIfExists(sn.attributes.name) === 'googlebot' ||
                        lowerIfExists(sn.attributes.name) === 'bingbot')) {
                    return true;
                }
                else if (slimDOMOptions.headMetaHttpEquiv &&
                    sn.attributes['http-equiv'] !== undefined) {
                    return true;
                }
                else if (slimDOMOptions.headMetaAuthorship &&
                    (lowerIfExists(sn.attributes.name) === 'author' ||
                        lowerIfExists(sn.attributes.name) === 'generator' ||
                        lowerIfExists(sn.attributes.name) === 'framework' ||
                        lowerIfExists(sn.attributes.name) === 'publisher' ||
                        lowerIfExists(sn.attributes.name) === 'progid' ||
                        lowerIfExists(sn.attributes.property).match(/^article:/) ||
                        lowerIfExists(sn.attributes.property).match(/^product:/))) {
                    return true;
                }
                else if (slimDOMOptions.headMetaVerification &&
                    (lowerIfExists(sn.attributes.name) === 'google-site-verification' ||
                        lowerIfExists(sn.attributes.name) === 'yandex-verification' ||
                        lowerIfExists(sn.attributes.name) === 'csrf-token' ||
                        lowerIfExists(sn.attributes.name) === 'p:domain_verify' ||
                        lowerIfExists(sn.attributes.name) === 'verify-v1' ||
                        lowerIfExists(sn.attributes.name) === 'verification' ||
                        lowerIfExists(sn.attributes.name) === 'shopify-checkout-api-token')) {
                    return true;
                }
            }
        }
        return false;
    }
    function serializeNodeWithId(n, options) {
        var doc = options.doc, mirror = options.mirror, blockClass = options.blockClass, blockSelector = options.blockSelector, maskTextClass = options.maskTextClass, maskTextSelector = options.maskTextSelector, _a = options.skipChild, skipChild = _a === void 0 ? false : _a, _b = options.inlineStylesheet, inlineStylesheet = _b === void 0 ? true : _b, _c = options.maskInputOptions, maskInputOptions = _c === void 0 ? {} : _c, maskTextFn = options.maskTextFn, maskInputFn = options.maskInputFn, slimDOMOptions = options.slimDOMOptions, _d = options.dataURLOptions, dataURLOptions = _d === void 0 ? {} : _d, _e = options.inlineImages, inlineImages = _e === void 0 ? false : _e, _f = options.recordCanvas, recordCanvas = _f === void 0 ? false : _f, onSerialize = options.onSerialize, onIframeLoad = options.onIframeLoad, _g = options.iframeLoadTimeout, iframeLoadTimeout = _g === void 0 ? 5000 : _g, onStylesheetLoad = options.onStylesheetLoad, _h = options.stylesheetLoadTimeout, stylesheetLoadTimeout = _h === void 0 ? 5000 : _h, _j = options.keepIframeSrcFn, keepIframeSrcFn = _j === void 0 ? function () { return false; } : _j, _k = options.newlyAddedElement, newlyAddedElement = _k === void 0 ? false : _k;
        var _l = options.preserveWhiteSpace, preserveWhiteSpace = _l === void 0 ? true : _l;
        var _serializedNode = serializeNode(n, {
            doc: doc,
            mirror: mirror,
            blockClass: blockClass,
            blockSelector: blockSelector,
            maskTextClass: maskTextClass,
            maskTextSelector: maskTextSelector,
            inlineStylesheet: inlineStylesheet,
            maskInputOptions: maskInputOptions,
            maskTextFn: maskTextFn,
            maskInputFn: maskInputFn,
            dataURLOptions: dataURLOptions,
            inlineImages: inlineImages,
            recordCanvas: recordCanvas,
            keepIframeSrcFn: keepIframeSrcFn,
            newlyAddedElement: newlyAddedElement
        });
        if (!_serializedNode) {
            console.warn(n, 'not serialized');
            return null;
        }
        var id;
        if (mirror.hasNode(n)) {
            id = mirror.getId(n);
        }
        else if (slimDOMExcluded(_serializedNode, slimDOMOptions) ||
            (!preserveWhiteSpace &&
                _serializedNode.type === NodeType.Text &&
                !_serializedNode.isStyle &&
                !_serializedNode.textContent.replace(/^\s+|\s+$/gm, '').length)) {
            id = IGNORED_NODE;
        }
        else {
            id = genId();
        }
        var serializedNode = Object.assign(_serializedNode, { id: id });
        mirror.add(n, serializedNode);
        if (id === IGNORED_NODE) {
            return null;
        }
        if (onSerialize) {
            onSerialize(n);
        }
        var recordChild = !skipChild;
        if (serializedNode.type === NodeType.Element) {
            recordChild = recordChild && !serializedNode.needBlock;
            delete serializedNode.needBlock;
            var shadowRoot = n.shadowRoot;
            if (shadowRoot && isNativeShadowDom(shadowRoot))
                serializedNode.isShadowHost = true;
        }
        if ((serializedNode.type === NodeType.Document ||
            serializedNode.type === NodeType.Element) &&
            recordChild) {
            if (slimDOMOptions.headWhitespace &&
                serializedNode.type === NodeType.Element &&
                serializedNode.tagName === 'head') {
                preserveWhiteSpace = false;
            }
            var bypassOptions = {
                doc: doc,
                mirror: mirror,
                blockClass: blockClass,
                blockSelector: blockSelector,
                maskTextClass: maskTextClass,
                maskTextSelector: maskTextSelector,
                skipChild: skipChild,
                inlineStylesheet: inlineStylesheet,
                maskInputOptions: maskInputOptions,
                maskTextFn: maskTextFn,
                maskInputFn: maskInputFn,
                slimDOMOptions: slimDOMOptions,
                dataURLOptions: dataURLOptions,
                inlineImages: inlineImages,
                recordCanvas: recordCanvas,
                preserveWhiteSpace: preserveWhiteSpace,
                onSerialize: onSerialize,
                onIframeLoad: onIframeLoad,
                iframeLoadTimeout: iframeLoadTimeout,
                onStylesheetLoad: onStylesheetLoad,
                stylesheetLoadTimeout: stylesheetLoadTimeout,
                keepIframeSrcFn: keepIframeSrcFn
            };
            for (var _i = 0, _m = Array.from(n.childNodes); _i < _m.length; _i++) {
                var childN = _m[_i];
                var serializedChildNode = serializeNodeWithId(childN, bypassOptions);
                if (serializedChildNode) {
                    serializedNode.childNodes.push(serializedChildNode);
                }
            }
            if (isElement(n) && n.shadowRoot) {
                for (var _o = 0, _p = Array.from(n.shadowRoot.childNodes); _o < _p.length; _o++) {
                    var childN = _p[_o];
                    var serializedChildNode = serializeNodeWithId(childN, bypassOptions);
                    if (serializedChildNode) {
                        isNativeShadowDom(n.shadowRoot) &&
                            (serializedChildNode.isShadow = true);
                        serializedNode.childNodes.push(serializedChildNode);
                    }
                }
            }
        }
        if (n.parentNode &&
            isShadowRoot(n.parentNode) &&
            isNativeShadowDom(n.parentNode)) {
            serializedNode.isShadow = true;
        }
        if (serializedNode.type === NodeType.Element &&
            serializedNode.tagName === 'iframe') {
            onceIframeLoaded(n, function () {
                var iframeDoc = n.contentDocument;
                if (iframeDoc && onIframeLoad) {
                    var serializedIframeNode = serializeNodeWithId(iframeDoc, {
                        doc: iframeDoc,
                        mirror: mirror,
                        blockClass: blockClass,
                        blockSelector: blockSelector,
                        maskTextClass: maskTextClass,
                        maskTextSelector: maskTextSelector,
                        skipChild: false,
                        inlineStylesheet: inlineStylesheet,
                        maskInputOptions: maskInputOptions,
                        maskTextFn: maskTextFn,
                        maskInputFn: maskInputFn,
                        slimDOMOptions: slimDOMOptions,
                        dataURLOptions: dataURLOptions,
                        inlineImages: inlineImages,
                        recordCanvas: recordCanvas,
                        preserveWhiteSpace: preserveWhiteSpace,
                        onSerialize: onSerialize,
                        onIframeLoad: onIframeLoad,
                        iframeLoadTimeout: iframeLoadTimeout,
                        onStylesheetLoad: onStylesheetLoad,
                        stylesheetLoadTimeout: stylesheetLoadTimeout,
                        keepIframeSrcFn: keepIframeSrcFn
                    });
                    if (serializedIframeNode) {
                        onIframeLoad(n, serializedIframeNode);
                    }
                }
            }, iframeLoadTimeout);
        }
        if (serializedNode.type === NodeType.Element &&
            serializedNode.tagName === 'link' &&
            serializedNode.attributes.rel === 'stylesheet') {
            onceStylesheetLoaded(n, function () {
                if (onStylesheetLoad) {
                    var serializedLinkNode = serializeNodeWithId(n, {
                        doc: doc,
                        mirror: mirror,
                        blockClass: blockClass,
                        blockSelector: blockSelector,
                        maskTextClass: maskTextClass,
                        maskTextSelector: maskTextSelector,
                        skipChild: false,
                        inlineStylesheet: inlineStylesheet,
                        maskInputOptions: maskInputOptions,
                        maskTextFn: maskTextFn,
                        maskInputFn: maskInputFn,
                        slimDOMOptions: slimDOMOptions,
                        dataURLOptions: dataURLOptions,
                        inlineImages: inlineImages,
                        recordCanvas: recordCanvas,
                        preserveWhiteSpace: preserveWhiteSpace,
                        onSerialize: onSerialize,
                        onIframeLoad: onIframeLoad,
                        iframeLoadTimeout: iframeLoadTimeout,
                        onStylesheetLoad: onStylesheetLoad,
                        stylesheetLoadTimeout: stylesheetLoadTimeout,
                        keepIframeSrcFn: keepIframeSrcFn
                    });
                    if (serializedLinkNode) {
                        onStylesheetLoad(n, serializedLinkNode);
                    }
                }
            }, stylesheetLoadTimeout);
        }
        return serializedNode;
    }
    function snapshot(n, options) {
        var _a = options || {}, _b = _a.mirror, mirror = _b === void 0 ? new Mirror() : _b, _c = _a.blockClass, blockClass = _c === void 0 ? 'rr-block' : _c, _d = _a.blockSelector, blockSelector = _d === void 0 ? null : _d, _e = _a.maskTextClass, maskTextClass = _e === void 0 ? 'rr-mask' : _e, _f = _a.maskTextSelector, maskTextSelector = _f === void 0 ? null : _f, _g = _a.inlineStylesheet, inlineStylesheet = _g === void 0 ? true : _g, _h = _a.inlineImages, inlineImages = _h === void 0 ? false : _h, _j = _a.recordCanvas, recordCanvas = _j === void 0 ? false : _j, _k = _a.maskAllInputs, maskAllInputs = _k === void 0 ? false : _k, maskTextFn = _a.maskTextFn, maskInputFn = _a.maskInputFn, _l = _a.slimDOM, slimDOM = _l === void 0 ? false : _l, dataURLOptions = _a.dataURLOptions, preserveWhiteSpace = _a.preserveWhiteSpace, onSerialize = _a.onSerialize, onIframeLoad = _a.onIframeLoad, iframeLoadTimeout = _a.iframeLoadTimeout, onStylesheetLoad = _a.onStylesheetLoad, stylesheetLoadTimeout = _a.stylesheetLoadTimeout, _m = _a.keepIframeSrcFn, keepIframeSrcFn = _m === void 0 ? function () { return false; } : _m;
        var maskInputOptions = maskAllInputs === true
            ? {
                color: true,
                date: true,
                'datetime-local': true,
                email: true,
                month: true,
                number: true,
                range: true,
                search: true,
                tel: true,
                text: true,
                time: true,
                url: true,
                week: true,
                textarea: true,
                select: true,
                password: true
            }
            : maskAllInputs === false
                ? {
                    password: true
                }
                : maskAllInputs;
        var slimDOMOptions = slimDOM === true || slimDOM === 'all'
            ?
                {
                    script: true,
                    comment: true,
                    headFavicon: true,
                    headWhitespace: true,
                    headMetaDescKeywords: slimDOM === 'all',
                    headMetaSocial: true,
                    headMetaRobots: true,
                    headMetaHttpEquiv: true,
                    headMetaAuthorship: true,
                    headMetaVerification: true
                }
            : slimDOM === false
                ? {}
                : slimDOM;
        return serializeNodeWithId(n, {
            doc: n,
            mirror: mirror,
            blockClass: blockClass,
            blockSelector: blockSelector,
            maskTextClass: maskTextClass,
            maskTextSelector: maskTextSelector,
            skipChild: false,
            inlineStylesheet: inlineStylesheet,
            maskInputOptions: maskInputOptions,
            maskTextFn: maskTextFn,
            maskInputFn: maskInputFn,
            slimDOMOptions: slimDOMOptions,
            dataURLOptions: dataURLOptions,
            inlineImages: inlineImages,
            recordCanvas: recordCanvas,
            preserveWhiteSpace: preserveWhiteSpace,
            onSerialize: onSerialize,
            onIframeLoad: onIframeLoad,
            iframeLoadTimeout: iframeLoadTimeout,
            onStylesheetLoad: onStylesheetLoad,
            stylesheetLoadTimeout: stylesheetLoadTimeout,
            keepIframeSrcFn: keepIframeSrcFn,
            newlyAddedElement: false
        });
    }

    function on(type, fn, target = document) {
        const options = { capture: true, passive: true };
        target.addEventListener(type, fn, options);
        return () => target.removeEventListener(type, fn, options);
    }
    const DEPARTED_MIRROR_ACCESS_WARNING = 'Please stop import mirror directly. Instead of that,' +
        '\r\n' +
        'now you can use replayer.getMirror() to access the mirror instance of a replayer,' +
        '\r\n' +
        'or you can use record.mirror to access the mirror instance during recording.';
    let _mirror = {
        map: {},
        getId() {
            console.error(DEPARTED_MIRROR_ACCESS_WARNING);
            return -1;
        },
        getNode() {
            console.error(DEPARTED_MIRROR_ACCESS_WARNING);
            return null;
        },
        removeNodeFromMap() {
            console.error(DEPARTED_MIRROR_ACCESS_WARNING);
        },
        has() {
            console.error(DEPARTED_MIRROR_ACCESS_WARNING);
            return false;
        },
        reset() {
            console.error(DEPARTED_MIRROR_ACCESS_WARNING);
        },
    };
    if (typeof window !== 'undefined' && window.Proxy && window.Reflect) {
        _mirror = new Proxy(_mirror, {
            get(target, prop, receiver) {
                if (prop === 'map') {
                    console.error(DEPARTED_MIRROR_ACCESS_WARNING);
                }
                return Reflect.get(target, prop, receiver);
            },
        });
    }
    function throttle(func, wait, options = {}) {
        let timeout = null;
        let previous = 0;
        return function (...args) {
            const now = Date.now();
            if (!previous && options.leading === false) {
                previous = now;
            }
            const remaining = wait - (now - previous);
            const context = this;
            if (remaining <= 0 || remaining > wait) {
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                }
                previous = now;
                func.apply(context, args);
            }
            else if (!timeout && options.trailing !== false) {
                timeout = setTimeout(() => {
                    previous = options.leading === false ? 0 : Date.now();
                    timeout = null;
                    func.apply(context, args);
                }, remaining);
            }
        };
    }
    function hookSetter(target, key, d, isRevoked, win = window) {
        const original = win.Object.getOwnPropertyDescriptor(target, key);
        win.Object.defineProperty(target, key, isRevoked
            ? d
            : {
                set(value) {
                    setTimeout(() => {
                        d.set.call(this, value);
                    }, 0);
                    if (original && original.set) {
                        original.set.call(this, value);
                    }
                },
            });
        return () => hookSetter(target, key, original || {}, true);
    }
    function patch(source, name, replacement) {
        try {
            if (!(name in source)) {
                return () => {
                };
            }
            const original = source[name];
            const wrapped = replacement(original);
            if (typeof wrapped === 'function') {
                wrapped.prototype = wrapped.prototype || {};
                Object.defineProperties(wrapped, {
                    __rrweb_original__: {
                        enumerable: false,
                        value: original,
                    },
                });
            }
            source[name] = wrapped;
            return () => {
                source[name] = original;
            };
        }
        catch (_a) {
            return () => {
            };
        }
    }
    function getWindowHeight() {
        return (window.innerHeight ||
            (document.documentElement && document.documentElement.clientHeight) ||
            (document.body && document.body.clientHeight));
    }
    function getWindowWidth() {
        return (window.innerWidth ||
            (document.documentElement && document.documentElement.clientWidth) ||
            (document.body && document.body.clientWidth));
    }
    function isBlocked(node, blockClass, blockSelector, checkAncestors) {
        if (!node) {
            return false;
        }
        const el = node.nodeType === node.ELEMENT_NODE
            ? node
            : node.parentElement;
        if (!el)
            return false;
        if (typeof blockClass === 'string') {
            if (el.classList.contains(blockClass))
                return true;
            if (checkAncestors && el.closest('.' + blockClass) !== null)
                return true;
        }
        else {
            if (classMatchesRegex(el, blockClass, checkAncestors))
                return true;
        }
        if (blockSelector) {
            if (node.matches(blockSelector))
                return true;
            if (checkAncestors && el.closest(blockSelector) !== null)
                return true;
        }
        return false;
    }
    function isSerialized(n, mirror) {
        return mirror.getId(n) !== -1;
    }
    function isIgnored(n, mirror) {
        return mirror.getId(n) === IGNORED_NODE;
    }
    function isAncestorRemoved(target, mirror) {
        if (isShadowRoot(target)) {
            return false;
        }
        const id = mirror.getId(target);
        if (!mirror.has(id)) {
            return true;
        }
        if (target.parentNode &&
            target.parentNode.nodeType === target.DOCUMENT_NODE) {
            return false;
        }
        if (!target.parentNode) {
            return true;
        }
        return isAncestorRemoved(target.parentNode, mirror);
    }
    function isTouchEvent(event) {
        return Boolean(event.changedTouches);
    }
    function polyfill(win = window) {
        if ('NodeList' in win && !win.NodeList.prototype.forEach) {
            win.NodeList.prototype.forEach = Array.prototype
                .forEach;
        }
        if ('DOMTokenList' in win && !win.DOMTokenList.prototype.forEach) {
            win.DOMTokenList.prototype.forEach = Array.prototype
                .forEach;
        }
        if (!Node.prototype.contains) {
            Node.prototype.contains = (...args) => {
                let node = args[0];
                if (!(0 in args)) {
                    throw new TypeError('1 argument is required');
                }
                do {
                    if (this === node) {
                        return true;
                    }
                } while ((node = node && node.parentNode));
                return false;
            };
        }
    }
    function isSerializedIframe(n, mirror) {
        return Boolean(n.nodeName === 'IFRAME' && mirror.getMeta(n));
    }
    function isSerializedStylesheet(n, mirror) {
        return Boolean(n.nodeName === 'LINK' &&
            n.nodeType === n.ELEMENT_NODE &&
            n.getAttribute &&
            n.getAttribute('rel') === 'stylesheet' &&
            mirror.getMeta(n));
    }
    function hasShadowRoot(n) {
        return Boolean(n === null || n === void 0 ? void 0 : n.shadowRoot);
    }
    class StyleSheetMirror {
        constructor() {
            this.id = 1;
            this.styleIDMap = new WeakMap();
            this.idStyleMap = new Map();
        }
        getId(stylesheet) {
            var _a;
            return (_a = this.styleIDMap.get(stylesheet)) !== null && _a !== void 0 ? _a : -1;
        }
        has(stylesheet) {
            return this.styleIDMap.has(stylesheet);
        }
        add(stylesheet, id) {
            if (this.has(stylesheet))
                return this.getId(stylesheet);
            let newId;
            if (id === undefined) {
                newId = this.id++;
            }
            else
                newId = id;
            this.styleIDMap.set(stylesheet, newId);
            this.idStyleMap.set(newId, stylesheet);
            return newId;
        }
        getStyle(id) {
            return this.idStyleMap.get(id) || null;
        }
        reset() {
            this.styleIDMap = new WeakMap();
            this.idStyleMap = new Map();
            this.id = 1;
        }
        generateId() {
            return this.id++;
        }
    }

    var EventType = /* @__PURE__ */ ((EventType2) => {
      EventType2[EventType2["DomContentLoaded"] = 0] = "DomContentLoaded";
      EventType2[EventType2["Load"] = 1] = "Load";
      EventType2[EventType2["FullSnapshot"] = 2] = "FullSnapshot";
      EventType2[EventType2["IncrementalSnapshot"] = 3] = "IncrementalSnapshot";
      EventType2[EventType2["Meta"] = 4] = "Meta";
      EventType2[EventType2["Custom"] = 5] = "Custom";
      EventType2[EventType2["Plugin"] = 6] = "Plugin";
      return EventType2;
    })(EventType || {});
    var IncrementalSource = /* @__PURE__ */ ((IncrementalSource2) => {
      IncrementalSource2[IncrementalSource2["Mutation"] = 0] = "Mutation";
      IncrementalSource2[IncrementalSource2["MouseMove"] = 1] = "MouseMove";
      IncrementalSource2[IncrementalSource2["MouseInteraction"] = 2] = "MouseInteraction";
      IncrementalSource2[IncrementalSource2["Scroll"] = 3] = "Scroll";
      IncrementalSource2[IncrementalSource2["ViewportResize"] = 4] = "ViewportResize";
      IncrementalSource2[IncrementalSource2["Input"] = 5] = "Input";
      IncrementalSource2[IncrementalSource2["TouchMove"] = 6] = "TouchMove";
      IncrementalSource2[IncrementalSource2["MediaInteraction"] = 7] = "MediaInteraction";
      IncrementalSource2[IncrementalSource2["StyleSheetRule"] = 8] = "StyleSheetRule";
      IncrementalSource2[IncrementalSource2["CanvasMutation"] = 9] = "CanvasMutation";
      IncrementalSource2[IncrementalSource2["Font"] = 10] = "Font";
      IncrementalSource2[IncrementalSource2["Log"] = 11] = "Log";
      IncrementalSource2[IncrementalSource2["Drag"] = 12] = "Drag";
      IncrementalSource2[IncrementalSource2["StyleDeclaration"] = 13] = "StyleDeclaration";
      IncrementalSource2[IncrementalSource2["Selection"] = 14] = "Selection";
      IncrementalSource2[IncrementalSource2["AdoptedStyleSheet"] = 15] = "AdoptedStyleSheet";
      return IncrementalSource2;
    })(IncrementalSource || {});
    var MouseInteractions = /* @__PURE__ */ ((MouseInteractions2) => {
      MouseInteractions2[MouseInteractions2["MouseUp"] = 0] = "MouseUp";
      MouseInteractions2[MouseInteractions2["MouseDown"] = 1] = "MouseDown";
      MouseInteractions2[MouseInteractions2["Click"] = 2] = "Click";
      MouseInteractions2[MouseInteractions2["ContextMenu"] = 3] = "ContextMenu";
      MouseInteractions2[MouseInteractions2["DblClick"] = 4] = "DblClick";
      MouseInteractions2[MouseInteractions2["Focus"] = 5] = "Focus";
      MouseInteractions2[MouseInteractions2["Blur"] = 6] = "Blur";
      MouseInteractions2[MouseInteractions2["TouchStart"] = 7] = "TouchStart";
      MouseInteractions2[MouseInteractions2["TouchMove_Departed"] = 8] = "TouchMove_Departed";
      MouseInteractions2[MouseInteractions2["TouchEnd"] = 9] = "TouchEnd";
      MouseInteractions2[MouseInteractions2["TouchCancel"] = 10] = "TouchCancel";
      return MouseInteractions2;
    })(MouseInteractions || {});
    var CanvasContext = /* @__PURE__ */ ((CanvasContext2) => {
      CanvasContext2[CanvasContext2["2D"] = 0] = "2D";
      CanvasContext2[CanvasContext2["WebGL"] = 1] = "WebGL";
      CanvasContext2[CanvasContext2["WebGL2"] = 2] = "WebGL2";
      return CanvasContext2;
    })(CanvasContext || {});

    function isNodeInLinkedList(n) {
        return '__ln' in n;
    }
    class DoubleLinkedList {
        constructor() {
            this.length = 0;
            this.head = null;
        }
        get(position) {
            if (position >= this.length) {
                throw new Error('Position outside of list range');
            }
            let current = this.head;
            for (let index = 0; index < position; index++) {
                current = (current === null || current === void 0 ? void 0 : current.next) || null;
            }
            return current;
        }
        addNode(n) {
            const node = {
                value: n,
                previous: null,
                next: null,
            };
            n.__ln = node;
            if (n.previousSibling && isNodeInLinkedList(n.previousSibling)) {
                const current = n.previousSibling.__ln.next;
                node.next = current;
                node.previous = n.previousSibling.__ln;
                n.previousSibling.__ln.next = node;
                if (current) {
                    current.previous = node;
                }
            }
            else if (n.nextSibling &&
                isNodeInLinkedList(n.nextSibling) &&
                n.nextSibling.__ln.previous) {
                const current = n.nextSibling.__ln.previous;
                node.previous = current;
                node.next = n.nextSibling.__ln;
                n.nextSibling.__ln.previous = node;
                if (current) {
                    current.next = node;
                }
            }
            else {
                if (this.head) {
                    this.head.previous = node;
                }
                node.next = this.head;
                this.head = node;
            }
            this.length++;
        }
        removeNode(n) {
            const current = n.__ln;
            if (!this.head) {
                return;
            }
            if (!current.previous) {
                this.head = current.next;
                if (this.head) {
                    this.head.previous = null;
                }
            }
            else {
                current.previous.next = current.next;
                if (current.next) {
                    current.next.previous = current.previous;
                }
            }
            if (n.__ln) {
                delete n.__ln;
            }
            this.length--;
        }
    }
    const moveKey = (id, parentId) => `${id}@${parentId}`;
    class MutationBuffer {
        constructor() {
            this.frozen = false;
            this.locked = false;
            this.texts = [];
            this.attributes = [];
            this.removes = [];
            this.mapRemoves = [];
            this.movedMap = {};
            this.addedSet = new Set();
            this.movedSet = new Set();
            this.droppedSet = new Set();
            this.processMutations = (mutations) => {
                mutations.forEach(this.processMutation);
                this.emit();
            };
            this.emit = () => {
                if (this.frozen || this.locked) {
                    return;
                }
                const adds = [];
                const addList = new DoubleLinkedList();
                const getNextId = (n) => {
                    let ns = n;
                    let nextId = IGNORED_NODE;
                    while (nextId === IGNORED_NODE) {
                        ns = ns && ns.nextSibling;
                        nextId = ns && this.mirror.getId(ns);
                    }
                    return nextId;
                };
                const pushAdd = (n) => {
                    var _a, _b, _c, _d;
                    let shadowHost = null;
                    if (((_b = (_a = n.getRootNode) === null || _a === void 0 ? void 0 : _a.call(n)) === null || _b === void 0 ? void 0 : _b.nodeType) === Node.DOCUMENT_FRAGMENT_NODE &&
                        n.getRootNode().host)
                        shadowHost = n.getRootNode().host;
                    let rootShadowHost = shadowHost;
                    while (((_d = (_c = rootShadowHost === null || rootShadowHost === void 0 ? void 0 : rootShadowHost.getRootNode) === null || _c === void 0 ? void 0 : _c.call(rootShadowHost)) === null || _d === void 0 ? void 0 : _d.nodeType) ===
                        Node.DOCUMENT_FRAGMENT_NODE &&
                        rootShadowHost.getRootNode().host)
                        rootShadowHost = rootShadowHost.getRootNode().host;
                    const notInDoc = !this.doc.contains(n) &&
                        (!rootShadowHost || !this.doc.contains(rootShadowHost));
                    if (!n.parentNode || notInDoc) {
                        return;
                    }
                    const parentId = isShadowRoot(n.parentNode)
                        ? this.mirror.getId(shadowHost)
                        : this.mirror.getId(n.parentNode);
                    const nextId = getNextId(n);
                    if (parentId === -1 || nextId === -1) {
                        return addList.addNode(n);
                    }
                    const sn = serializeNodeWithId(n, {
                        doc: this.doc,
                        mirror: this.mirror,
                        blockClass: this.blockClass,
                        blockSelector: this.blockSelector,
                        maskTextClass: this.maskTextClass,
                        maskTextSelector: this.maskTextSelector,
                        skipChild: true,
                        newlyAddedElement: true,
                        inlineStylesheet: this.inlineStylesheet,
                        maskInputOptions: this.maskInputOptions,
                        maskTextFn: this.maskTextFn,
                        maskInputFn: this.maskInputFn,
                        slimDOMOptions: this.slimDOMOptions,
                        dataURLOptions: this.dataURLOptions,
                        recordCanvas: this.recordCanvas,
                        inlineImages: this.inlineImages,
                        onSerialize: (currentN) => {
                            if (isSerializedIframe(currentN, this.mirror)) {
                                this.iframeManager.addIframe(currentN);
                            }
                            if (isSerializedStylesheet(currentN, this.mirror)) {
                                this.stylesheetManager.trackLinkElement(currentN);
                            }
                            if (hasShadowRoot(n)) {
                                this.shadowDomManager.addShadowRoot(n.shadowRoot, this.doc);
                            }
                        },
                        onIframeLoad: (iframe, childSn) => {
                            this.iframeManager.attachIframe(iframe, childSn);
                            this.shadowDomManager.observeAttachShadow(iframe);
                        },
                        onStylesheetLoad: (link, childSn) => {
                            this.stylesheetManager.attachLinkElement(link, childSn);
                        },
                    });
                    if (sn) {
                        adds.push({
                            parentId,
                            nextId,
                            node: sn,
                        });
                    }
                };
                while (this.mapRemoves.length) {
                    this.mirror.removeNodeFromMap(this.mapRemoves.shift());
                }
                for (const n of Array.from(this.movedSet.values())) {
                    if (isParentRemoved(this.removes, n, this.mirror) &&
                        !this.movedSet.has(n.parentNode)) {
                        continue;
                    }
                    pushAdd(n);
                }
                for (const n of Array.from(this.addedSet.values())) {
                    if (!isAncestorInSet(this.droppedSet, n) &&
                        !isParentRemoved(this.removes, n, this.mirror)) {
                        pushAdd(n);
                    }
                    else if (isAncestorInSet(this.movedSet, n)) {
                        pushAdd(n);
                    }
                    else {
                        this.droppedSet.add(n);
                    }
                }
                let candidate = null;
                while (addList.length) {
                    let node = null;
                    if (candidate) {
                        const parentId = this.mirror.getId(candidate.value.parentNode);
                        const nextId = getNextId(candidate.value);
                        if (parentId !== -1 && nextId !== -1) {
                            node = candidate;
                        }
                    }
                    if (!node) {
                        for (let index = addList.length - 1; index >= 0; index--) {
                            const _node = addList.get(index);
                            if (_node) {
                                const parentId = this.mirror.getId(_node.value.parentNode);
                                const nextId = getNextId(_node.value);
                                if (nextId === -1)
                                    continue;
                                else if (parentId !== -1) {
                                    node = _node;
                                    break;
                                }
                                else {
                                    const unhandledNode = _node.value;
                                    if (unhandledNode.parentNode &&
                                        unhandledNode.parentNode.nodeType ===
                                            Node.DOCUMENT_FRAGMENT_NODE) {
                                        const shadowHost = unhandledNode.parentNode
                                            .host;
                                        const parentId = this.mirror.getId(shadowHost);
                                        if (parentId !== -1) {
                                            node = _node;
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if (!node) {
                        while (addList.head) {
                            addList.removeNode(addList.head.value);
                        }
                        break;
                    }
                    candidate = node.previous;
                    addList.removeNode(node.value);
                    pushAdd(node.value);
                }
                const payload = {
                    texts: this.texts
                        .map((text) => ({
                        id: this.mirror.getId(text.node),
                        value: text.value,
                    }))
                        .filter((text) => this.mirror.has(text.id)),
                    attributes: this.attributes
                        .map((attribute) => ({
                        id: this.mirror.getId(attribute.node),
                        attributes: attribute.attributes,
                    }))
                        .filter((attribute) => this.mirror.has(attribute.id)),
                    removes: this.removes,
                    adds,
                };
                if (!payload.texts.length &&
                    !payload.attributes.length &&
                    !payload.removes.length &&
                    !payload.adds.length) {
                    return;
                }
                this.texts = [];
                this.attributes = [];
                this.removes = [];
                this.addedSet = new Set();
                this.movedSet = new Set();
                this.droppedSet = new Set();
                this.movedMap = {};
                this.mutationCb(payload);
            };
            this.processMutation = (m) => {
                if (isIgnored(m.target, this.mirror)) {
                    return;
                }
                switch (m.type) {
                    case 'characterData': {
                        const value = m.target.textContent;
                        if (!isBlocked(m.target, this.blockClass, this.blockSelector, false) &&
                            value !== m.oldValue) {
                            this.texts.push({
                                value: needMaskingText(m.target, this.maskTextClass, this.maskTextSelector) && value
                                    ? this.maskTextFn
                                        ? this.maskTextFn(value)
                                        : value.replace(/[\S]/g, '*')
                                    : value,
                                node: m.target,
                            });
                        }
                        break;
                    }
                    case 'attributes': {
                        const target = m.target;
                        let value = m.target.getAttribute(m.attributeName);
                        if (m.attributeName === 'value') {
                            value = maskInputValue({
                                maskInputOptions: this.maskInputOptions,
                                tagName: m.target.tagName,
                                type: m.target.getAttribute('type'),
                                value,
                                maskInputFn: this.maskInputFn,
                            });
                        }
                        if (isBlocked(m.target, this.blockClass, this.blockSelector, false) ||
                            value === m.oldValue) {
                            return;
                        }
                        let item = this.attributes.find((a) => a.node === m.target);
                        if (target.tagName === 'IFRAME' &&
                            m.attributeName === 'src' &&
                            !this.keepIframeSrcFn(value)) {
                            if (!target.contentDocument) {
                                m.attributeName = 'rr_src';
                            }
                            else {
                                return;
                            }
                        }
                        if (!item) {
                            item = {
                                node: m.target,
                                attributes: {},
                            };
                            this.attributes.push(item);
                        }
                        if (m.attributeName === 'style') {
                            const old = this.doc.createElement('span');
                            if (m.oldValue) {
                                old.setAttribute('style', m.oldValue);
                            }
                            if (item.attributes.style === undefined ||
                                item.attributes.style === null) {
                                item.attributes.style = {};
                            }
                            const styleObj = item.attributes.style;
                            for (const pname of Array.from(target.style)) {
                                const newValue = target.style.getPropertyValue(pname);
                                const newPriority = target.style.getPropertyPriority(pname);
                                if (newValue !== old.style.getPropertyValue(pname) ||
                                    newPriority !== old.style.getPropertyPriority(pname)) {
                                    if (newPriority === '') {
                                        styleObj[pname] = newValue;
                                    }
                                    else {
                                        styleObj[pname] = [newValue, newPriority];
                                    }
                                }
                            }
                            for (const pname of Array.from(old.style)) {
                                if (target.style.getPropertyValue(pname) === '') {
                                    styleObj[pname] = false;
                                }
                            }
                        }
                        else {
                            item.attributes[m.attributeName] = transformAttribute(this.doc, target.tagName, m.attributeName, value);
                        }
                        break;
                    }
                    case 'childList': {
                        if (isBlocked(m.target, this.blockClass, this.blockSelector, true))
                            return;
                        m.addedNodes.forEach((n) => this.genAdds(n, m.target));
                        m.removedNodes.forEach((n) => {
                            const nodeId = this.mirror.getId(n);
                            const parentId = isShadowRoot(m.target)
                                ? this.mirror.getId(m.target.host)
                                : this.mirror.getId(m.target);
                            if (isBlocked(m.target, this.blockClass, this.blockSelector, false) ||
                                isIgnored(n, this.mirror) ||
                                !isSerialized(n, this.mirror)) {
                                return;
                            }
                            if (this.addedSet.has(n)) {
                                deepDelete(this.addedSet, n);
                                this.droppedSet.add(n);
                            }
                            else if (this.addedSet.has(m.target) && nodeId === -1) ;
                            else if (isAncestorRemoved(m.target, this.mirror)) ;
                            else if (this.movedSet.has(n) &&
                                this.movedMap[moveKey(nodeId, parentId)]) {
                                deepDelete(this.movedSet, n);
                            }
                            else {
                                this.removes.push({
                                    parentId,
                                    id: nodeId,
                                    isShadow: isShadowRoot(m.target) && isNativeShadowDom(m.target)
                                        ? true
                                        : undefined,
                                });
                            }
                            this.mapRemoves.push(n);
                        });
                        break;
                    }
                }
            };
            this.genAdds = (n, target) => {
                if (this.mirror.hasNode(n)) {
                    if (isIgnored(n, this.mirror)) {
                        return;
                    }
                    this.movedSet.add(n);
                    let targetId = null;
                    if (target && this.mirror.hasNode(target)) {
                        targetId = this.mirror.getId(target);
                    }
                    if (targetId && targetId !== -1) {
                        this.movedMap[moveKey(this.mirror.getId(n), targetId)] = true;
                    }
                }
                else {
                    this.addedSet.add(n);
                    this.droppedSet.delete(n);
                }
                if (!isBlocked(n, this.blockClass, this.blockSelector, false))
                    n.childNodes.forEach((childN) => this.genAdds(childN));
            };
        }
        init(options) {
            [
                'mutationCb',
                'blockClass',
                'blockSelector',
                'maskTextClass',
                'maskTextSelector',
                'inlineStylesheet',
                'maskInputOptions',
                'maskTextFn',
                'maskInputFn',
                'keepIframeSrcFn',
                'recordCanvas',
                'inlineImages',
                'slimDOMOptions',
                'dataURLOptions',
                'doc',
                'mirror',
                'iframeManager',
                'stylesheetManager',
                'shadowDomManager',
                'canvasManager',
            ].forEach((key) => {
                this[key] = options[key];
            });
        }
        freeze() {
            this.frozen = true;
            this.canvasManager.freeze();
        }
        unfreeze() {
            this.frozen = false;
            this.canvasManager.unfreeze();
            this.emit();
        }
        isFrozen() {
            return this.frozen;
        }
        lock() {
            this.locked = true;
            this.canvasManager.lock();
        }
        unlock() {
            this.locked = false;
            this.canvasManager.unlock();
            this.emit();
        }
        reset() {
            this.shadowDomManager.reset();
            this.canvasManager.reset();
        }
    }
    function deepDelete(addsSet, n) {
        addsSet.delete(n);
        n.childNodes.forEach((childN) => deepDelete(addsSet, childN));
    }
    function isParentRemoved(removes, n, mirror) {
        if (removes.length === 0)
            return false;
        return _isParentRemoved(removes, n, mirror);
    }
    function _isParentRemoved(removes, n, mirror) {
        const { parentNode } = n;
        if (!parentNode) {
            return false;
        }
        const parentId = mirror.getId(parentNode);
        if (removes.some((r) => r.id === parentId)) {
            return true;
        }
        return _isParentRemoved(removes, parentNode, mirror);
    }
    function isAncestorInSet(set, n) {
        if (set.size === 0)
            return false;
        return _isAncestorInSet(set, n);
    }
    function _isAncestorInSet(set, n) {
        const { parentNode } = n;
        if (!parentNode) {
            return false;
        }
        if (set.has(parentNode)) {
            return true;
        }
        return _isAncestorInSet(set, parentNode);
    }

    const mutationBuffers = [];
    const isCSSGroupingRuleSupported = typeof CSSGroupingRule !== 'undefined';
    const isCSSMediaRuleSupported = typeof CSSMediaRule !== 'undefined';
    const isCSSSupportsRuleSupported = typeof CSSSupportsRule !== 'undefined';
    const isCSSConditionRuleSupported = typeof CSSConditionRule !== 'undefined';
    function getEventTarget(event) {
        try {
            if ('composedPath' in event) {
                const path = event.composedPath();
                if (path.length) {
                    return path[0];
                }
            }
            else if ('path' in event && event.path.length) {
                return event.path[0];
            }
            return event.target;
        }
        catch (_a) {
            return event.target;
        }
    }
    function initMutationObserver(options, rootEl) {
        var _a, _b;
        const mutationBuffer = new MutationBuffer();
        mutationBuffers.push(mutationBuffer);
        mutationBuffer.init(options);
        let mutationObserverCtor = window.MutationObserver ||
            window.__rrMutationObserver;
        const angularZoneSymbol = (_b = (_a = window === null || window === void 0 ? void 0 : window.Zone) === null || _a === void 0 ? void 0 : _a.__symbol__) === null || _b === void 0 ? void 0 : _b.call(_a, 'MutationObserver');
        if (angularZoneSymbol &&
            window[angularZoneSymbol]) {
            mutationObserverCtor = window[angularZoneSymbol];
        }
        const observer = new mutationObserverCtor(mutationBuffer.processMutations.bind(mutationBuffer));
        observer.observe(rootEl, {
            attributes: true,
            attributeOldValue: true,
            characterData: true,
            characterDataOldValue: true,
            childList: true,
            subtree: true,
        });
        return observer;
    }
    function initMoveObserver({ mousemoveCb, sampling, doc, mirror, }) {
        if (sampling.mousemove === false) {
            return () => {
            };
        }
        const threshold = typeof sampling.mousemove === 'number' ? sampling.mousemove : 50;
        const callbackThreshold = typeof sampling.mousemoveCallback === 'number'
            ? sampling.mousemoveCallback
            : 500;
        let positions = [];
        let timeBaseline;
        const wrappedCb = throttle((source) => {
            const totalOffset = Date.now() - timeBaseline;
            mousemoveCb(positions.map((p) => {
                p.timeOffset -= totalOffset;
                return p;
            }), source);
            positions = [];
            timeBaseline = null;
        }, callbackThreshold);
        const updatePosition = throttle((evt) => {
            const target = getEventTarget(evt);
            const { clientX, clientY } = isTouchEvent(evt)
                ? evt.changedTouches[0]
                : evt;
            if (!timeBaseline) {
                timeBaseline = Date.now();
            }
            positions.push({
                x: clientX,
                y: clientY,
                id: mirror.getId(target),
                timeOffset: Date.now() - timeBaseline,
            });
            wrappedCb(typeof DragEvent !== 'undefined' && evt instanceof DragEvent
                ? IncrementalSource.Drag
                : evt instanceof MouseEvent
                    ? IncrementalSource.MouseMove
                    : IncrementalSource.TouchMove);
        }, threshold, {
            trailing: false,
        });
        const handlers = [
            on('mousemove', updatePosition, doc),
            on('touchmove', updatePosition, doc),
            on('drag', updatePosition, doc),
        ];
        return () => {
            handlers.forEach((h) => h());
        };
    }
    function initMouseInteractionObserver({ mouseInteractionCb, doc, mirror, blockClass, blockSelector, sampling, }) {
        if (sampling.mouseInteraction === false) {
            return () => {
            };
        }
        const disableMap = sampling.mouseInteraction === true ||
            sampling.mouseInteraction === undefined
            ? {}
            : sampling.mouseInteraction;
        const handlers = [];
        const getHandler = (eventKey) => {
            return (event) => {
                const target = getEventTarget(event);
                if (isBlocked(target, blockClass, blockSelector, true)) {
                    return;
                }
                const e = isTouchEvent(event) ? event.changedTouches[0] : event;
                if (!e) {
                    return;
                }
                const id = mirror.getId(target);
                const { clientX, clientY } = e;
                mouseInteractionCb({
                    type: MouseInteractions[eventKey],
                    id,
                    x: clientX,
                    y: clientY,
                });
            };
        };
        Object.keys(MouseInteractions)
            .filter((key) => Number.isNaN(Number(key)) &&
            !key.endsWith('_Departed') &&
            disableMap[key] !== false)
            .forEach((eventKey) => {
            const eventName = eventKey.toLowerCase();
            const handler = getHandler(eventKey);
            handlers.push(on(eventName, handler, doc));
        });
        return () => {
            handlers.forEach((h) => h());
        };
    }
    function initScrollObserver({ scrollCb, doc, mirror, blockClass, blockSelector, sampling, }) {
        const updatePosition = throttle((evt) => {
            const target = getEventTarget(evt);
            if (!target || isBlocked(target, blockClass, blockSelector, true)) {
                return;
            }
            const id = mirror.getId(target);
            if (target === doc) {
                const scrollEl = (doc.scrollingElement || doc.documentElement);
                scrollCb({
                    id,
                    x: scrollEl.scrollLeft,
                    y: scrollEl.scrollTop,
                });
            }
            else {
                scrollCb({
                    id,
                    x: target.scrollLeft,
                    y: target.scrollTop,
                });
            }
        }, sampling.scroll || 100);
        return on('scroll', updatePosition, doc);
    }
    function initViewportResizeObserver({ viewportResizeCb, }) {
        let lastH = -1;
        let lastW = -1;
        const updateDimension = throttle(() => {
            const height = getWindowHeight();
            const width = getWindowWidth();
            if (lastH !== height || lastW !== width) {
                viewportResizeCb({
                    width: Number(width),
                    height: Number(height),
                });
                lastH = height;
                lastW = width;
            }
        }, 200);
        return on('resize', updateDimension, window);
    }
    function wrapEventWithUserTriggeredFlag(v, enable) {
        const value = Object.assign({}, v);
        if (!enable)
            delete value.userTriggered;
        return value;
    }
    const INPUT_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];
    const lastInputValueMap = new WeakMap();
    function initInputObserver({ inputCb, doc, mirror, blockClass, blockSelector, ignoreClass, maskInputOptions, maskInputFn, sampling, userTriggeredOnInput, }) {
        function eventHandler(event) {
            let target = getEventTarget(event);
            const userTriggered = event.isTrusted;
            if (target && target.tagName === 'OPTION')
                target = target.parentElement;
            if (!target ||
                !target.tagName ||
                INPUT_TAGS.indexOf(target.tagName) < 0 ||
                isBlocked(target, blockClass, blockSelector, true)) {
                return;
            }
            const type = target.type;
            if (target.classList.contains(ignoreClass)) {
                return;
            }
            let text = target.value;
            let isChecked = false;
            if (type === 'radio' || type === 'checkbox') {
                isChecked = target.checked;
            }
            else if (maskInputOptions[target.tagName.toLowerCase()] ||
                maskInputOptions[type]) {
                text = maskInputValue({
                    maskInputOptions,
                    tagName: target.tagName,
                    type,
                    value: text,
                    maskInputFn,
                });
            }
            cbWithDedup(target, wrapEventWithUserTriggeredFlag({ text, isChecked, userTriggered }, userTriggeredOnInput));
            const name = target.name;
            if (type === 'radio' && name && isChecked) {
                doc
                    .querySelectorAll(`input[type="radio"][name="${name}"]`)
                    .forEach((el) => {
                    if (el !== target) {
                        cbWithDedup(el, wrapEventWithUserTriggeredFlag({
                            text: el.value,
                            isChecked: !isChecked,
                            userTriggered: false,
                        }, userTriggeredOnInput));
                    }
                });
            }
        }
        function cbWithDedup(target, v) {
            const lastInputValue = lastInputValueMap.get(target);
            if (!lastInputValue ||
                lastInputValue.text !== v.text ||
                lastInputValue.isChecked !== v.isChecked) {
                lastInputValueMap.set(target, v);
                const id = mirror.getId(target);
                inputCb(Object.assign(Object.assign({}, v), { id }));
            }
        }
        const events = sampling.input === 'last' ? ['change'] : ['input', 'change'];
        const handlers = events.map((eventName) => on(eventName, eventHandler, doc));
        const currentWindow = doc.defaultView;
        if (!currentWindow) {
            return () => {
                handlers.forEach((h) => h());
            };
        }
        const propertyDescriptor = currentWindow.Object.getOwnPropertyDescriptor(currentWindow.HTMLInputElement.prototype, 'value');
        const hookProperties = [
            [currentWindow.HTMLInputElement.prototype, 'value'],
            [currentWindow.HTMLInputElement.prototype, 'checked'],
            [currentWindow.HTMLSelectElement.prototype, 'value'],
            [currentWindow.HTMLTextAreaElement.prototype, 'value'],
            [currentWindow.HTMLSelectElement.prototype, 'selectedIndex'],
            [currentWindow.HTMLOptionElement.prototype, 'selected'],
        ];
        if (propertyDescriptor && propertyDescriptor.set) {
            handlers.push(...hookProperties.map((p) => hookSetter(p[0], p[1], {
                set() {
                    eventHandler({ target: this });
                },
            }, false, currentWindow)));
        }
        return () => {
            handlers.forEach((h) => h());
        };
    }
    function getNestedCSSRulePositions(rule) {
        const positions = [];
        function recurse(childRule, pos) {
            if ((isCSSGroupingRuleSupported &&
                childRule.parentRule instanceof CSSGroupingRule) ||
                (isCSSMediaRuleSupported &&
                    childRule.parentRule instanceof CSSMediaRule) ||
                (isCSSSupportsRuleSupported &&
                    childRule.parentRule instanceof CSSSupportsRule) ||
                (isCSSConditionRuleSupported &&
                    childRule.parentRule instanceof CSSConditionRule)) {
                const rules = Array.from(childRule.parentRule.cssRules);
                const index = rules.indexOf(childRule);
                pos.unshift(index);
            }
            else if (childRule.parentStyleSheet) {
                const rules = Array.from(childRule.parentStyleSheet.cssRules);
                const index = rules.indexOf(childRule);
                pos.unshift(index);
            }
            return pos;
        }
        return recurse(rule, positions);
    }
    function getIdAndStyleId(sheet, mirror, styleMirror) {
        let id, styleId;
        if (!sheet)
            return {};
        if (sheet.ownerNode)
            id = mirror.getId(sheet.ownerNode);
        else
            styleId = styleMirror.getId(sheet);
        return {
            styleId,
            id,
        };
    }
    function initStyleSheetObserver({ styleSheetRuleCb, mirror, stylesheetManager }, { win }) {
        const insertRule = win.CSSStyleSheet.prototype.insertRule;
        win.CSSStyleSheet.prototype.insertRule = function (rule, index) {
            const { id, styleId } = getIdAndStyleId(this, mirror, stylesheetManager.styleMirror);
            if ((id && id !== -1) || (styleId && styleId !== -1)) {
                styleSheetRuleCb({
                    id,
                    styleId,
                    adds: [{ rule, index }],
                });
            }
            return insertRule.apply(this, [rule, index]);
        };
        const deleteRule = win.CSSStyleSheet.prototype.deleteRule;
        win.CSSStyleSheet.prototype.deleteRule = function (index) {
            const { id, styleId } = getIdAndStyleId(this, mirror, stylesheetManager.styleMirror);
            if ((id && id !== -1) || (styleId && styleId !== -1)) {
                styleSheetRuleCb({
                    id,
                    styleId,
                    removes: [{ index }],
                });
            }
            return deleteRule.apply(this, [index]);
        };
        let replace;
        if (win.CSSStyleSheet.prototype.replace) {
            replace = win.CSSStyleSheet.prototype.replace;
            win.CSSStyleSheet.prototype.replace = function (text) {
                const { id, styleId } = getIdAndStyleId(this, mirror, stylesheetManager.styleMirror);
                if ((id && id !== -1) || (styleId && styleId !== -1)) {
                    styleSheetRuleCb({
                        id,
                        styleId,
                        replace: text,
                    });
                }
                return replace.apply(this, [text]);
            };
        }
        let replaceSync;
        if (win.CSSStyleSheet.prototype.replaceSync) {
            replaceSync = win.CSSStyleSheet.prototype.replaceSync;
            win.CSSStyleSheet.prototype.replaceSync = function (text) {
                const { id, styleId } = getIdAndStyleId(this, mirror, stylesheetManager.styleMirror);
                if ((id && id !== -1) || (styleId && styleId !== -1)) {
                    styleSheetRuleCb({
                        id,
                        styleId,
                        replaceSync: text,
                    });
                }
                return replaceSync.apply(this, [text]);
            };
        }
        const supportedNestedCSSRuleTypes = {};
        if (isCSSGroupingRuleSupported) {
            supportedNestedCSSRuleTypes.CSSGroupingRule = win.CSSGroupingRule;
        }
        else {
            if (isCSSMediaRuleSupported) {
                supportedNestedCSSRuleTypes.CSSMediaRule = win.CSSMediaRule;
            }
            if (isCSSConditionRuleSupported) {
                supportedNestedCSSRuleTypes.CSSConditionRule = win.CSSConditionRule;
            }
            if (isCSSSupportsRuleSupported) {
                supportedNestedCSSRuleTypes.CSSSupportsRule = win.CSSSupportsRule;
            }
        }
        const unmodifiedFunctions = {};
        Object.entries(supportedNestedCSSRuleTypes).forEach(([typeKey, type]) => {
            unmodifiedFunctions[typeKey] = {
                insertRule: type.prototype.insertRule,
                deleteRule: type.prototype.deleteRule,
            };
            type.prototype.insertRule = function (rule, index) {
                const { id, styleId } = getIdAndStyleId(this.parentStyleSheet, mirror, stylesheetManager.styleMirror);
                if ((id && id !== -1) || (styleId && styleId !== -1)) {
                    styleSheetRuleCb({
                        id,
                        styleId,
                        adds: [
                            {
                                rule,
                                index: [
                                    ...getNestedCSSRulePositions(this),
                                    index || 0,
                                ],
                            },
                        ],
                    });
                }
                return unmodifiedFunctions[typeKey].insertRule.apply(this, [rule, index]);
            };
            type.prototype.deleteRule = function (index) {
                const { id, styleId } = getIdAndStyleId(this.parentStyleSheet, mirror, stylesheetManager.styleMirror);
                if ((id && id !== -1) || (styleId && styleId !== -1)) {
                    styleSheetRuleCb({
                        id,
                        styleId,
                        removes: [
                            { index: [...getNestedCSSRulePositions(this), index] },
                        ],
                    });
                }
                return unmodifiedFunctions[typeKey].deleteRule.apply(this, [index]);
            };
        });
        return () => {
            win.CSSStyleSheet.prototype.insertRule = insertRule;
            win.CSSStyleSheet.prototype.deleteRule = deleteRule;
            replace && (win.CSSStyleSheet.prototype.replace = replace);
            replaceSync && (win.CSSStyleSheet.prototype.replaceSync = replaceSync);
            Object.entries(supportedNestedCSSRuleTypes).forEach(([typeKey, type]) => {
                type.prototype.insertRule = unmodifiedFunctions[typeKey].insertRule;
                type.prototype.deleteRule = unmodifiedFunctions[typeKey].deleteRule;
            });
        };
    }
    function initAdoptedStyleSheetObserver({ mirror, stylesheetManager, }, host) {
        var _a, _b, _c;
        let hostId = null;
        if (host.nodeName === '#document')
            hostId = mirror.getId(host);
        else
            hostId = mirror.getId(host.host);
        const patchTarget = host.nodeName === '#document'
            ? (_a = host.defaultView) === null || _a === void 0 ? void 0 : _a.Document
            : (_c = (_b = host.ownerDocument) === null || _b === void 0 ? void 0 : _b.defaultView) === null || _c === void 0 ? void 0 : _c.ShadowRoot;
        const originalPropertyDescriptor = Object.getOwnPropertyDescriptor(patchTarget === null || patchTarget === void 0 ? void 0 : patchTarget.prototype, 'adoptedStyleSheets');
        if (hostId === null ||
            hostId === -1 ||
            !patchTarget ||
            !originalPropertyDescriptor)
            return () => {
            };
        Object.defineProperty(host, 'adoptedStyleSheets', {
            configurable: originalPropertyDescriptor.configurable,
            enumerable: originalPropertyDescriptor.enumerable,
            get() {
                var _a;
                return (_a = originalPropertyDescriptor.get) === null || _a === void 0 ? void 0 : _a.call(this);
            },
            set(sheets) {
                var _a;
                const result = (_a = originalPropertyDescriptor.set) === null || _a === void 0 ? void 0 : _a.call(this, sheets);
                if (hostId !== null && hostId !== -1) {
                    try {
                        stylesheetManager.adoptStyleSheets(sheets, hostId);
                    }
                    catch (e) {
                    }
                }
                return result;
            },
        });
        return () => {
            Object.defineProperty(host, 'adoptedStyleSheets', {
                configurable: originalPropertyDescriptor.configurable,
                enumerable: originalPropertyDescriptor.enumerable,
                get: originalPropertyDescriptor.get,
                set: originalPropertyDescriptor.set,
            });
        };
    }
    function initStyleDeclarationObserver({ styleDeclarationCb, mirror, ignoreCSSAttributes, stylesheetManager, }, { win }) {
        const setProperty = win.CSSStyleDeclaration.prototype.setProperty;
        win.CSSStyleDeclaration.prototype.setProperty = function (property, value, priority) {
            var _a;
            if (ignoreCSSAttributes.has(property)) {
                return setProperty.apply(this, [property, value, priority]);
            }
            const { id, styleId } = getIdAndStyleId((_a = this.parentRule) === null || _a === void 0 ? void 0 : _a.parentStyleSheet, mirror, stylesheetManager.styleMirror);
            if ((id && id !== -1) || (styleId && styleId !== -1)) {
                styleDeclarationCb({
                    id,
                    styleId,
                    set: {
                        property,
                        value,
                        priority,
                    },
                    index: getNestedCSSRulePositions(this.parentRule),
                });
            }
            return setProperty.apply(this, [property, value, priority]);
        };
        const removeProperty = win.CSSStyleDeclaration.prototype.removeProperty;
        win.CSSStyleDeclaration.prototype.removeProperty = function (property) {
            var _a;
            if (ignoreCSSAttributes.has(property)) {
                return removeProperty.apply(this, [property]);
            }
            const { id, styleId } = getIdAndStyleId((_a = this.parentRule) === null || _a === void 0 ? void 0 : _a.parentStyleSheet, mirror, stylesheetManager.styleMirror);
            if ((id && id !== -1) || (styleId && styleId !== -1)) {
                styleDeclarationCb({
                    id,
                    styleId,
                    remove: {
                        property,
                    },
                    index: getNestedCSSRulePositions(this.parentRule),
                });
            }
            return removeProperty.apply(this, [property]);
        };
        return () => {
            win.CSSStyleDeclaration.prototype.setProperty = setProperty;
            win.CSSStyleDeclaration.prototype.removeProperty = removeProperty;
        };
    }
    function initMediaInteractionObserver({ mediaInteractionCb, blockClass, blockSelector, mirror, sampling, }) {
        const handler = (type) => throttle((event) => {
            const target = getEventTarget(event);
            if (!target ||
                isBlocked(target, blockClass, blockSelector, true)) {
                return;
            }
            const { currentTime, volume, muted, playbackRate, } = target;
            mediaInteractionCb({
                type,
                id: mirror.getId(target),
                currentTime,
                volume,
                muted,
                playbackRate,
            });
        }, sampling.media || 500);
        const handlers = [
            on('play', handler(0)),
            on('pause', handler(1)),
            on('seeked', handler(2)),
            on('volumechange', handler(3)),
            on('ratechange', handler(4)),
        ];
        return () => {
            handlers.forEach((h) => h());
        };
    }
    function initFontObserver({ fontCb, doc }) {
        const win = doc.defaultView;
        if (!win) {
            return () => {
            };
        }
        const handlers = [];
        const fontMap = new WeakMap();
        const originalFontFace = win.FontFace;
        win.FontFace = function FontFace(family, source, descriptors) {
            const fontFace = new originalFontFace(family, source, descriptors);
            fontMap.set(fontFace, {
                family,
                buffer: typeof source !== 'string',
                descriptors,
                fontSource: typeof source === 'string'
                    ? source
                    : JSON.stringify(Array.from(new Uint8Array(source))),
            });
            return fontFace;
        };
        const restoreHandler = patch(doc.fonts, 'add', function (original) {
            return function (fontFace) {
                setTimeout(() => {
                    const p = fontMap.get(fontFace);
                    if (p) {
                        fontCb(p);
                        fontMap.delete(fontFace);
                    }
                }, 0);
                return original.apply(this, [fontFace]);
            };
        });
        handlers.push(() => {
            win.FontFace = originalFontFace;
        });
        handlers.push(restoreHandler);
        return () => {
            handlers.forEach((h) => h());
        };
    }
    function initSelectionObserver(param) {
        const { doc, mirror, blockClass, blockSelector, selectionCb } = param;
        let collapsed = true;
        const updateSelection = () => {
            const selection = doc.getSelection();
            if (!selection || (collapsed && (selection === null || selection === void 0 ? void 0 : selection.isCollapsed)))
                return;
            collapsed = selection.isCollapsed || false;
            const ranges = [];
            const count = selection.rangeCount || 0;
            for (let i = 0; i < count; i++) {
                const range = selection.getRangeAt(i);
                const { startContainer, startOffset, endContainer, endOffset } = range;
                const blocked = isBlocked(startContainer, blockClass, blockSelector, true) ||
                    isBlocked(endContainer, blockClass, blockSelector, true);
                if (blocked)
                    continue;
                ranges.push({
                    start: mirror.getId(startContainer),
                    startOffset,
                    end: mirror.getId(endContainer),
                    endOffset,
                });
            }
            selectionCb({ ranges });
        };
        updateSelection();
        return on('selectionchange', updateSelection);
    }
    function mergeHooks(o, hooks) {
        const { mutationCb, mousemoveCb, mouseInteractionCb, scrollCb, viewportResizeCb, inputCb, mediaInteractionCb, styleSheetRuleCb, styleDeclarationCb, canvasMutationCb, fontCb, selectionCb, } = o;
        o.mutationCb = (...p) => {
            if (hooks.mutation) {
                hooks.mutation(...p);
            }
            mutationCb(...p);
        };
        o.mousemoveCb = (...p) => {
            if (hooks.mousemove) {
                hooks.mousemove(...p);
            }
            mousemoveCb(...p);
        };
        o.mouseInteractionCb = (...p) => {
            if (hooks.mouseInteraction) {
                hooks.mouseInteraction(...p);
            }
            mouseInteractionCb(...p);
        };
        o.scrollCb = (...p) => {
            if (hooks.scroll) {
                hooks.scroll(...p);
            }
            scrollCb(...p);
        };
        o.viewportResizeCb = (...p) => {
            if (hooks.viewportResize) {
                hooks.viewportResize(...p);
            }
            viewportResizeCb(...p);
        };
        o.inputCb = (...p) => {
            if (hooks.input) {
                hooks.input(...p);
            }
            inputCb(...p);
        };
        o.mediaInteractionCb = (...p) => {
            if (hooks.mediaInteaction) {
                hooks.mediaInteaction(...p);
            }
            mediaInteractionCb(...p);
        };
        o.styleSheetRuleCb = (...p) => {
            if (hooks.styleSheetRule) {
                hooks.styleSheetRule(...p);
            }
            styleSheetRuleCb(...p);
        };
        o.styleDeclarationCb = (...p) => {
            if (hooks.styleDeclaration) {
                hooks.styleDeclaration(...p);
            }
            styleDeclarationCb(...p);
        };
        o.canvasMutationCb = (...p) => {
            if (hooks.canvasMutation) {
                hooks.canvasMutation(...p);
            }
            canvasMutationCb(...p);
        };
        o.fontCb = (...p) => {
            if (hooks.font) {
                hooks.font(...p);
            }
            fontCb(...p);
        };
        o.selectionCb = (...p) => {
            if (hooks.selection) {
                hooks.selection(...p);
            }
            selectionCb(...p);
        };
    }
    function initObservers(o, hooks = {}) {
        const currentWindow = o.doc.defaultView;
        if (!currentWindow) {
            return () => {
            };
        }
        mergeHooks(o, hooks);
        const mutationObserver = initMutationObserver(o, o.doc);
        const mousemoveHandler = initMoveObserver(o);
        const mouseInteractionHandler = initMouseInteractionObserver(o);
        const scrollHandler = initScrollObserver(o);
        const viewportResizeHandler = initViewportResizeObserver(o);
        const inputHandler = initInputObserver(o);
        const mediaInteractionHandler = initMediaInteractionObserver(o);
        const styleSheetObserver = initStyleSheetObserver(o, { win: currentWindow });
        const adoptedStyleSheetObserver = initAdoptedStyleSheetObserver(o, o.doc);
        const styleDeclarationObserver = initStyleDeclarationObserver(o, {
            win: currentWindow,
        });
        const fontObserver = o.collectFonts
            ? initFontObserver(o)
            : () => {
            };
        const selectionObserver = initSelectionObserver(o);
        const pluginHandlers = [];
        for (const plugin of o.plugins) {
            pluginHandlers.push(plugin.observer(plugin.callback, currentWindow, plugin.options));
        }
        return () => {
            mutationBuffers.forEach((b) => b.reset());
            mutationObserver.disconnect();
            mousemoveHandler();
            mouseInteractionHandler();
            scrollHandler();
            viewportResizeHandler();
            inputHandler();
            mediaInteractionHandler();
            styleSheetObserver();
            adoptedStyleSheetObserver();
            styleDeclarationObserver();
            fontObserver();
            selectionObserver();
            pluginHandlers.forEach((h) => h());
        };
    }

    class CrossOriginIframeMirror {
        constructor(generateIdFn) {
            this.generateIdFn = generateIdFn;
            this.iframeIdToRemoteIdMap = new WeakMap();
            this.iframeRemoteIdToIdMap = new WeakMap();
        }
        getId(iframe, remoteId, idToRemoteMap, remoteToIdMap) {
            const idToRemoteIdMap = idToRemoteMap || this.getIdToRemoteIdMap(iframe);
            const remoteIdToIdMap = remoteToIdMap || this.getRemoteIdToIdMap(iframe);
            let id = idToRemoteIdMap.get(remoteId);
            if (!id) {
                id = this.generateIdFn();
                idToRemoteIdMap.set(remoteId, id);
                remoteIdToIdMap.set(id, remoteId);
            }
            return id;
        }
        getIds(iframe, remoteId) {
            const idToRemoteIdMap = this.getIdToRemoteIdMap(iframe);
            const remoteIdToIdMap = this.getRemoteIdToIdMap(iframe);
            return remoteId.map((id) => this.getId(iframe, id, idToRemoteIdMap, remoteIdToIdMap));
        }
        getRemoteId(iframe, id, map) {
            const remoteIdToIdMap = map || this.getRemoteIdToIdMap(iframe);
            if (typeof id !== 'number')
                return id;
            const remoteId = remoteIdToIdMap.get(id);
            if (!remoteId)
                return -1;
            return remoteId;
        }
        getRemoteIds(iframe, ids) {
            const remoteIdToIdMap = this.getRemoteIdToIdMap(iframe);
            return ids.map((id) => this.getRemoteId(iframe, id, remoteIdToIdMap));
        }
        reset(iframe) {
            if (!iframe) {
                this.iframeIdToRemoteIdMap = new WeakMap();
                this.iframeRemoteIdToIdMap = new WeakMap();
                return;
            }
            this.iframeIdToRemoteIdMap.delete(iframe);
            this.iframeRemoteIdToIdMap.delete(iframe);
        }
        getIdToRemoteIdMap(iframe) {
            let idToRemoteIdMap = this.iframeIdToRemoteIdMap.get(iframe);
            if (!idToRemoteIdMap) {
                idToRemoteIdMap = new Map();
                this.iframeIdToRemoteIdMap.set(iframe, idToRemoteIdMap);
            }
            return idToRemoteIdMap;
        }
        getRemoteIdToIdMap(iframe) {
            let remoteIdToIdMap = this.iframeRemoteIdToIdMap.get(iframe);
            if (!remoteIdToIdMap) {
                remoteIdToIdMap = new Map();
                this.iframeRemoteIdToIdMap.set(iframe, remoteIdToIdMap);
            }
            return remoteIdToIdMap;
        }
    }

    class IframeManager {
        constructor(options) {
            this.iframes = new WeakMap();
            this.crossOriginIframeMap = new WeakMap();
            this.crossOriginIframeMirror = new CrossOriginIframeMirror(genId);
            this.mutationCb = options.mutationCb;
            this.wrappedEmit = options.wrappedEmit;
            this.stylesheetManager = options.stylesheetManager;
            this.recordCrossOriginIframes = options.recordCrossOriginIframes;
            this.crossOriginIframeStyleMirror = new CrossOriginIframeMirror(this.stylesheetManager.styleMirror.generateId.bind(this.stylesheetManager.styleMirror));
            this.mirror = options.mirror;
            if (this.recordCrossOriginIframes) {
                window.addEventListener('message', this.handleMessage.bind(this));
            }
        }
        addIframe(iframeEl) {
            this.iframes.set(iframeEl, true);
            if (iframeEl.contentWindow)
                this.crossOriginIframeMap.set(iframeEl.contentWindow, iframeEl);
        }
        addLoadListener(cb) {
            this.loadListener = cb;
        }
        attachIframe(iframeEl, childSn) {
            var _a;
            this.mutationCb({
                adds: [
                    {
                        parentId: this.mirror.getId(iframeEl),
                        nextId: null,
                        node: childSn,
                    },
                ],
                removes: [],
                texts: [],
                attributes: [],
                isAttachIframe: true,
            });
            (_a = this.loadListener) === null || _a === void 0 ? void 0 : _a.call(this, iframeEl);
            if (iframeEl.contentDocument &&
                iframeEl.contentDocument.adoptedStyleSheets &&
                iframeEl.contentDocument.adoptedStyleSheets.length > 0)
                this.stylesheetManager.adoptStyleSheets(iframeEl.contentDocument.adoptedStyleSheets, this.mirror.getId(iframeEl.contentDocument));
        }
        handleMessage(message) {
            if (message.data.type === 'rrweb') {
                const iframeSourceWindow = message.source;
                if (!iframeSourceWindow)
                    return;
                const iframeEl = this.crossOriginIframeMap.get(message.source);
                if (!iframeEl)
                    return;
                const transformedEvent = this.transformCrossOriginEvent(iframeEl, message.data.event);
                if (transformedEvent)
                    this.wrappedEmit(transformedEvent, message.data.isCheckout);
            }
        }
        transformCrossOriginEvent(iframeEl, e) {
            var _a;
            switch (e.type) {
                case EventType.FullSnapshot: {
                    this.crossOriginIframeMirror.reset(iframeEl);
                    this.crossOriginIframeStyleMirror.reset(iframeEl);
                    this.replaceIdOnNode(e.data.node, iframeEl);
                    return {
                        timestamp: e.timestamp,
                        type: EventType.IncrementalSnapshot,
                        data: {
                            source: IncrementalSource.Mutation,
                            adds: [
                                {
                                    parentId: this.mirror.getId(iframeEl),
                                    nextId: null,
                                    node: e.data.node,
                                },
                            ],
                            removes: [],
                            texts: [],
                            attributes: [],
                            isAttachIframe: true,
                        },
                    };
                }
                case EventType.Meta:
                case EventType.Load:
                case EventType.DomContentLoaded: {
                    return false;
                }
                case EventType.Plugin: {
                    return e;
                }
                case EventType.Custom: {
                    this.replaceIds(e.data.payload, iframeEl, ['id', 'parentId', 'previousId', 'nextId']);
                    return e;
                }
                case EventType.IncrementalSnapshot: {
                    switch (e.data.source) {
                        case IncrementalSource.Mutation: {
                            e.data.adds.forEach((n) => {
                                this.replaceIds(n, iframeEl, [
                                    'parentId',
                                    'nextId',
                                    'previousId',
                                ]);
                                this.replaceIdOnNode(n.node, iframeEl);
                            });
                            e.data.removes.forEach((n) => {
                                this.replaceIds(n, iframeEl, ['parentId', 'id']);
                            });
                            e.data.attributes.forEach((n) => {
                                this.replaceIds(n, iframeEl, ['id']);
                            });
                            e.data.texts.forEach((n) => {
                                this.replaceIds(n, iframeEl, ['id']);
                            });
                            return e;
                        }
                        case IncrementalSource.Drag:
                        case IncrementalSource.TouchMove:
                        case IncrementalSource.MouseMove: {
                            e.data.positions.forEach((p) => {
                                this.replaceIds(p, iframeEl, ['id']);
                            });
                            return e;
                        }
                        case IncrementalSource.ViewportResize: {
                            return false;
                        }
                        case IncrementalSource.MediaInteraction:
                        case IncrementalSource.MouseInteraction:
                        case IncrementalSource.Scroll:
                        case IncrementalSource.CanvasMutation:
                        case IncrementalSource.Input: {
                            this.replaceIds(e.data, iframeEl, ['id']);
                            return e;
                        }
                        case IncrementalSource.StyleSheetRule:
                        case IncrementalSource.StyleDeclaration: {
                            this.replaceIds(e.data, iframeEl, ['id']);
                            this.replaceStyleIds(e.data, iframeEl, ['styleId']);
                            return e;
                        }
                        case IncrementalSource.Font: {
                            return e;
                        }
                        case IncrementalSource.Selection: {
                            e.data.ranges.forEach((range) => {
                                this.replaceIds(range, iframeEl, ['start', 'end']);
                            });
                            return e;
                        }
                        case IncrementalSource.AdoptedStyleSheet: {
                            this.replaceIds(e.data, iframeEl, ['id']);
                            this.replaceStyleIds(e.data, iframeEl, ['styleIds']);
                            (_a = e.data.styles) === null || _a === void 0 ? void 0 : _a.forEach((style) => {
                                this.replaceStyleIds(style, iframeEl, ['styleId']);
                            });
                            return e;
                        }
                    }
                }
            }
        }
        replace(iframeMirror, obj, iframeEl, keys) {
            for (const key of keys) {
                if (!Array.isArray(obj[key]) && typeof obj[key] !== 'number')
                    continue;
                if (Array.isArray(obj[key])) {
                    obj[key] = iframeMirror.getIds(iframeEl, obj[key]);
                }
                else {
                    obj[key] = iframeMirror.getId(iframeEl, obj[key]);
                }
            }
            return obj;
        }
        replaceIds(obj, iframeEl, keys) {
            return this.replace(this.crossOriginIframeMirror, obj, iframeEl, keys);
        }
        replaceStyleIds(obj, iframeEl, keys) {
            return this.replace(this.crossOriginIframeStyleMirror, obj, iframeEl, keys);
        }
        replaceIdOnNode(node, iframeEl) {
            this.replaceIds(node, iframeEl, ['id']);
            if ('childNodes' in node) {
                node.childNodes.forEach((child) => {
                    this.replaceIdOnNode(child, iframeEl);
                });
            }
        }
    }

    class ShadowDomManager {
        constructor(options) {
            this.shadowDoms = new WeakSet();
            this.restorePatches = [];
            this.mutationCb = options.mutationCb;
            this.scrollCb = options.scrollCb;
            this.bypassOptions = options.bypassOptions;
            this.mirror = options.mirror;
            const manager = this;
            this.restorePatches.push(patch(Element.prototype, 'attachShadow', function (original) {
                return function (option) {
                    const shadowRoot = original.call(this, option);
                    if (this.shadowRoot)
                        manager.addShadowRoot(this.shadowRoot, this.ownerDocument);
                    return shadowRoot;
                };
            }));
        }
        addShadowRoot(shadowRoot, doc) {
            if (!isNativeShadowDom(shadowRoot))
                return;
            if (this.shadowDoms.has(shadowRoot))
                return;
            this.shadowDoms.add(shadowRoot);
            initMutationObserver(Object.assign(Object.assign({}, this.bypassOptions), { doc, mutationCb: this.mutationCb, mirror: this.mirror, shadowDomManager: this }), shadowRoot);
            initScrollObserver(Object.assign(Object.assign({}, this.bypassOptions), { scrollCb: this.scrollCb, doc: shadowRoot, mirror: this.mirror }));
            setTimeout(() => {
                if (shadowRoot.adoptedStyleSheets &&
                    shadowRoot.adoptedStyleSheets.length > 0)
                    this.bypassOptions.stylesheetManager.adoptStyleSheets(shadowRoot.adoptedStyleSheets, this.mirror.getId(shadowRoot.host));
                initAdoptedStyleSheetObserver({
                    mirror: this.mirror,
                    stylesheetManager: this.bypassOptions.stylesheetManager,
                }, shadowRoot);
            }, 0);
        }
        observeAttachShadow(iframeElement) {
            if (iframeElement.contentWindow) {
                const manager = this;
                this.restorePatches.push(patch(iframeElement.contentWindow.HTMLElement.prototype, 'attachShadow', function (original) {
                    return function (option) {
                        const shadowRoot = original.call(this, option);
                        if (this.shadowRoot)
                            manager.addShadowRoot(this.shadowRoot, iframeElement.contentDocument);
                        return shadowRoot;
                    };
                }));
            }
        }
        reset() {
            this.restorePatches.forEach((restorePatch) => restorePatch());
            this.shadowDoms = new WeakSet();
        }
    }

    /*! *****************************************************************************
    Copyright (c) Microsoft Corporation.

    Permission to use, copy, modify, and/or distribute this software for any
    purpose with or without fee is hereby granted.

    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
    REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
    AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
    INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
    LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
    OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
    PERFORMANCE OF THIS SOFTWARE.
    ***************************************************************************** */

    function __rest(s, e) {
        var t = {};
        for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
            t[p] = s[p];
        if (s != null && typeof Object.getOwnPropertySymbols === "function")
            for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
                if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                    t[p[i]] = s[p[i]];
            }
        return t;
    }

    function __awaiter(thisArg, _arguments, P, generator) {
        function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
        return new (P || (P = Promise))(function (resolve, reject) {
            function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
            function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
            function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
            step((generator = generator.apply(thisArg, [])).next());
        });
    }

    /*
     * base64-arraybuffer 1.0.1 <https://github.com/niklasvh/base64-arraybuffer>
     * Copyright (c) 2021 Niklas von Hertzen <https://hertzen.com>
     * Released under MIT License
     */
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    // Use a lookup table to find the index.
    var lookup = typeof Uint8Array === 'undefined' ? [] : new Uint8Array(256);
    for (var i = 0; i < chars.length; i++) {
        lookup[chars.charCodeAt(i)] = i;
    }
    var encode = function (arraybuffer) {
        var bytes = new Uint8Array(arraybuffer), i, len = bytes.length, base64 = '';
        for (i = 0; i < len; i += 3) {
            base64 += chars[bytes[i] >> 2];
            base64 += chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
            base64 += chars[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
            base64 += chars[bytes[i + 2] & 63];
        }
        if (len % 3 === 2) {
            base64 = base64.substring(0, base64.length - 1) + '=';
        }
        else if (len % 3 === 1) {
            base64 = base64.substring(0, base64.length - 2) + '==';
        }
        return base64;
    };

    const canvasVarMap = new Map();
    function variableListFor(ctx, ctor) {
        let contextMap = canvasVarMap.get(ctx);
        if (!contextMap) {
            contextMap = new Map();
            canvasVarMap.set(ctx, contextMap);
        }
        if (!contextMap.has(ctor)) {
            contextMap.set(ctor, []);
        }
        return contextMap.get(ctor);
    }
    const saveWebGLVar = (value, win, ctx) => {
        if (!value ||
            !(isInstanceOfWebGLObject(value, win) || typeof value === 'object'))
            return;
        const name = value.constructor.name;
        const list = variableListFor(ctx, name);
        let index = list.indexOf(value);
        if (index === -1) {
            index = list.length;
            list.push(value);
        }
        return index;
    };
    function serializeArg(value, win, ctx) {
        if (value instanceof Array) {
            return value.map((arg) => serializeArg(arg, win, ctx));
        }
        else if (value === null) {
            return value;
        }
        else if (value instanceof Float32Array ||
            value instanceof Float64Array ||
            value instanceof Int32Array ||
            value instanceof Uint32Array ||
            value instanceof Uint8Array ||
            value instanceof Uint16Array ||
            value instanceof Int16Array ||
            value instanceof Int8Array ||
            value instanceof Uint8ClampedArray) {
            const name = value.constructor.name;
            return {
                rr_type: name,
                args: [Object.values(value)],
            };
        }
        else if (value instanceof ArrayBuffer) {
            const name = value.constructor.name;
            const base64 = encode(value);
            return {
                rr_type: name,
                base64,
            };
        }
        else if (value instanceof DataView) {
            const name = value.constructor.name;
            return {
                rr_type: name,
                args: [
                    serializeArg(value.buffer, win, ctx),
                    value.byteOffset,
                    value.byteLength,
                ],
            };
        }
        else if (value instanceof HTMLImageElement) {
            const name = value.constructor.name;
            const { src } = value;
            return {
                rr_type: name,
                src,
            };
        }
        else if (value instanceof HTMLCanvasElement) {
            const name = 'HTMLImageElement';
            const src = value.toDataURL();
            return {
                rr_type: name,
                src,
            };
        }
        else if (value instanceof ImageData) {
            const name = value.constructor.name;
            return {
                rr_type: name,
                args: [serializeArg(value.data, win, ctx), value.width, value.height],
            };
        }
        else if (isInstanceOfWebGLObject(value, win) || typeof value === 'object') {
            const name = value.constructor.name;
            const index = saveWebGLVar(value, win, ctx);
            return {
                rr_type: name,
                index: index,
            };
        }
        return value;
    }
    const serializeArgs = (args, win, ctx) => {
        return [...args].map((arg) => serializeArg(arg, win, ctx));
    };
    const isInstanceOfWebGLObject = (value, win) => {
        const webGLConstructorNames = [
            'WebGLActiveInfo',
            'WebGLBuffer',
            'WebGLFramebuffer',
            'WebGLProgram',
            'WebGLRenderbuffer',
            'WebGLShader',
            'WebGLShaderPrecisionFormat',
            'WebGLTexture',
            'WebGLUniformLocation',
            'WebGLVertexArrayObject',
            'WebGLVertexArrayObjectOES',
        ];
        const supportedWebGLConstructorNames = webGLConstructorNames.filter((name) => typeof win[name] === 'function');
        return Boolean(supportedWebGLConstructorNames.find((name) => value instanceof win[name]));
    };

    function initCanvas2DMutationObserver(cb, win, blockClass, blockSelector) {
        const handlers = [];
        const props2D = Object.getOwnPropertyNames(win.CanvasRenderingContext2D.prototype);
        for (const prop of props2D) {
            try {
                if (typeof win.CanvasRenderingContext2D.prototype[prop] !== 'function') {
                    continue;
                }
                const restoreHandler = patch(win.CanvasRenderingContext2D.prototype, prop, function (original) {
                    return function (...args) {
                        if (!isBlocked(this.canvas, blockClass, blockSelector, true)) {
                            setTimeout(() => {
                                const recordArgs = serializeArgs([...args], win, this);
                                cb(this.canvas, {
                                    type: CanvasContext['2D'],
                                    property: prop,
                                    args: recordArgs,
                                });
                            }, 0);
                        }
                        return original.apply(this, args);
                    };
                });
                handlers.push(restoreHandler);
            }
            catch (_a) {
                const hookHandler = hookSetter(win.CanvasRenderingContext2D.prototype, prop, {
                    set(v) {
                        cb(this.canvas, {
                            type: CanvasContext['2D'],
                            property: prop,
                            args: [v],
                            setter: true,
                        });
                    },
                });
                handlers.push(hookHandler);
            }
        }
        return () => {
            handlers.forEach((h) => h());
        };
    }

    function initCanvasContextObserver(win, blockClass, blockSelector) {
        const handlers = [];
        try {
            const restoreHandler = patch(win.HTMLCanvasElement.prototype, 'getContext', function (original) {
                return function (contextType, ...args) {
                    if (!isBlocked(this, blockClass, blockSelector, true)) {
                        if (!('__context' in this))
                            this.__context = contextType;
                    }
                    return original.apply(this, [contextType, ...args]);
                };
            });
            handlers.push(restoreHandler);
        }
        catch (_a) {
            console.error('failed to patch HTMLCanvasElement.prototype.getContext');
        }
        return () => {
            handlers.forEach((h) => h());
        };
    }

    function patchGLPrototype(prototype, type, cb, blockClass, blockSelector, mirror, win) {
        const handlers = [];
        const props = Object.getOwnPropertyNames(prototype);
        for (const prop of props) {
            if ([
                'isContextLost',
                'canvas',
                'drawingBufferWidth',
                'drawingBufferHeight',
            ].includes(prop)) {
                continue;
            }
            try {
                if (typeof prototype[prop] !== 'function') {
                    continue;
                }
                const restoreHandler = patch(prototype, prop, function (original) {
                    return function (...args) {
                        const result = original.apply(this, args);
                        saveWebGLVar(result, win, this);
                        if (!isBlocked(this.canvas, blockClass, blockSelector, true)) {
                            const recordArgs = serializeArgs([...args], win, this);
                            const mutation = {
                                type,
                                property: prop,
                                args: recordArgs,
                            };
                            cb(this.canvas, mutation);
                        }
                        return result;
                    };
                });
                handlers.push(restoreHandler);
            }
            catch (_a) {
                const hookHandler = hookSetter(prototype, prop, {
                    set(v) {
                        cb(this.canvas, {
                            type,
                            property: prop,
                            args: [v],
                            setter: true,
                        });
                    },
                });
                handlers.push(hookHandler);
            }
        }
        return handlers;
    }
    function initCanvasWebGLMutationObserver(cb, win, blockClass, blockSelector, mirror) {
        const handlers = [];
        handlers.push(...patchGLPrototype(win.WebGLRenderingContext.prototype, CanvasContext.WebGL, cb, blockClass, blockSelector, mirror, win));
        if (typeof win.WebGL2RenderingContext !== 'undefined') {
            handlers.push(...patchGLPrototype(win.WebGL2RenderingContext.prototype, CanvasContext.WebGL2, cb, blockClass, blockSelector, mirror, win));
        }
        return () => {
            handlers.forEach((h) => h());
        };
    }

    var WorkerClass = null;

    try {
        var WorkerThreads =
            typeof module !== 'undefined' && typeof module.require === 'function' && module.require('worker_threads') ||
            typeof __non_webpack_require__ === 'function' && __non_webpack_require__('worker_threads') ||
            typeof require === 'function' && require('worker_threads');
        WorkerClass = WorkerThreads.Worker;
    } catch(e) {} // eslint-disable-line

    function decodeBase64$1(base64, enableUnicode) {
        return Buffer.from(base64, 'base64').toString('utf8');
    }

    function createBase64WorkerFactory$2(base64, sourcemapArg, enableUnicodeArg) {
        var source = decodeBase64$1(base64);
        var start = source.indexOf('\n', 10) + 1;
        var body = source.substring(start) + ('');
        return function WorkerFactory(options) {
            return new WorkerClass(body, Object.assign({}, options, { eval: true }));
        };
    }

    function decodeBase64(base64, enableUnicode) {
        var binaryString = atob(base64);
        return binaryString;
    }

    function createURL(base64, sourcemapArg, enableUnicodeArg) {
        var source = decodeBase64(base64);
        var start = source.indexOf('\n', 10) + 1;
        var body = source.substring(start) + ('');
        var blob = new Blob([body], { type: 'application/javascript' });
        return URL.createObjectURL(blob);
    }

    function createBase64WorkerFactory$1(base64, sourcemapArg, enableUnicodeArg) {
        var url;
        return function WorkerFactory(options) {
            url = url || createURL(base64);
            return new Worker(url, options);
        };
    }

    var kIsNodeJS = Object.prototype.toString.call(typeof process !== 'undefined' ? process : 0) === '[object process]';

    function isNodeJS() {
        return kIsNodeJS;
    }

    function createBase64WorkerFactory(base64, sourcemapArg, enableUnicodeArg) {
        if (isNodeJS()) {
            return createBase64WorkerFactory$2(base64);
        }
        return createBase64WorkerFactory$1(base64);
    }

    var WorkerFactory = createBase64WorkerFactory('Lyogcm9sbHVwLXBsdWdpbi13ZWItd29ya2VyLWxvYWRlciAqLwooZnVuY3Rpb24gKCkgewogICAgJ3VzZSBzdHJpY3QnOwoKICAgIC8qISAqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKg0KICAgIENvcHlyaWdodCAoYykgTWljcm9zb2Z0IENvcnBvcmF0aW9uLg0KDQogICAgUGVybWlzc2lvbiB0byB1c2UsIGNvcHksIG1vZGlmeSwgYW5kL29yIGRpc3RyaWJ1dGUgdGhpcyBzb2Z0d2FyZSBmb3IgYW55DQogICAgcHVycG9zZSB3aXRoIG9yIHdpdGhvdXQgZmVlIGlzIGhlcmVieSBncmFudGVkLg0KDQogICAgVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEICJBUyBJUyIgQU5EIFRIRSBBVVRIT1IgRElTQ0xBSU1TIEFMTCBXQVJSQU5USUVTIFdJVEgNCiAgICBSRUdBUkQgVE8gVEhJUyBTT0ZUV0FSRSBJTkNMVURJTkcgQUxMIElNUExJRUQgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFkNCiAgICBBTkQgRklUTkVTUy4gSU4gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUiBCRSBMSUFCTEUgRk9SIEFOWSBTUEVDSUFMLCBESVJFQ1QsDQogICAgSU5ESVJFQ1QsIE9SIENPTlNFUVVFTlRJQUwgREFNQUdFUyBPUiBBTlkgREFNQUdFUyBXSEFUU09FVkVSIFJFU1VMVElORyBGUk9NDQogICAgTE9TUyBPRiBVU0UsIERBVEEgT1IgUFJPRklUUywgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIE5FR0xJR0VOQ0UgT1INCiAgICBPVEhFUiBUT1JUSU9VUyBBQ1RJT04sIEFSSVNJTkcgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgVVNFIE9SDQogICAgUEVSRk9STUFOQ0UgT0YgVEhJUyBTT0ZUV0FSRS4NCiAgICAqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiAqLw0KDQogICAgZnVuY3Rpb24gX19hd2FpdGVyKHRoaXNBcmcsIF9hcmd1bWVudHMsIFAsIGdlbmVyYXRvcikgew0KICAgICAgICBmdW5jdGlvbiBhZG9wdCh2YWx1ZSkgeyByZXR1cm4gdmFsdWUgaW5zdGFuY2VvZiBQID8gdmFsdWUgOiBuZXcgUChmdW5jdGlvbiAocmVzb2x2ZSkgeyByZXNvbHZlKHZhbHVlKTsgfSk7IH0NCiAgICAgICAgcmV0dXJuIG5ldyAoUCB8fCAoUCA9IFByb21pc2UpKShmdW5jdGlvbiAocmVzb2x2ZSwgcmVqZWN0KSB7DQogICAgICAgICAgICBmdW5jdGlvbiBmdWxmaWxsZWQodmFsdWUpIHsgdHJ5IHsgc3RlcChnZW5lcmF0b3IubmV4dCh2YWx1ZSkpOyB9IGNhdGNoIChlKSB7IHJlamVjdChlKTsgfSB9DQogICAgICAgICAgICBmdW5jdGlvbiByZWplY3RlZCh2YWx1ZSkgeyB0cnkgeyBzdGVwKGdlbmVyYXRvclsidGhyb3ciXSh2YWx1ZSkpOyB9IGNhdGNoIChlKSB7IHJlamVjdChlKTsgfSB9DQogICAgICAgICAgICBmdW5jdGlvbiBzdGVwKHJlc3VsdCkgeyByZXN1bHQuZG9uZSA/IHJlc29sdmUocmVzdWx0LnZhbHVlKSA6IGFkb3B0KHJlc3VsdC52YWx1ZSkudGhlbihmdWxmaWxsZWQsIHJlamVjdGVkKTsgfQ0KICAgICAgICAgICAgc3RlcCgoZ2VuZXJhdG9yID0gZ2VuZXJhdG9yLmFwcGx5KHRoaXNBcmcsIF9hcmd1bWVudHMgfHwgW10pKS5uZXh0KCkpOw0KICAgICAgICB9KTsNCiAgICB9CgogICAgLyoKICAgICAqIGJhc2U2NC1hcnJheWJ1ZmZlciAxLjAuMSA8aHR0cHM6Ly9naXRodWIuY29tL25pa2xhc3ZoL2Jhc2U2NC1hcnJheWJ1ZmZlcj4KICAgICAqIENvcHlyaWdodCAoYykgMjAyMSBOaWtsYXMgdm9uIEhlcnR6ZW4gPGh0dHBzOi8vaGVydHplbi5jb20+CiAgICAgKiBSZWxlYXNlZCB1bmRlciBNSVQgTGljZW5zZQogICAgICovCiAgICB2YXIgY2hhcnMgPSAnQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrLyc7CiAgICAvLyBVc2UgYSBsb29rdXAgdGFibGUgdG8gZmluZCB0aGUgaW5kZXguCiAgICB2YXIgbG9va3VwID0gdHlwZW9mIFVpbnQ4QXJyYXkgPT09ICd1bmRlZmluZWQnID8gW10gOiBuZXcgVWludDhBcnJheSgyNTYpOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjaGFycy5sZW5ndGg7IGkrKykgewogICAgICAgIGxvb2t1cFtjaGFycy5jaGFyQ29kZUF0KGkpXSA9IGk7CiAgICB9CiAgICB2YXIgZW5jb2RlID0gZnVuY3Rpb24gKGFycmF5YnVmZmVyKSB7CiAgICAgICAgdmFyIGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYXJyYXlidWZmZXIpLCBpLCBsZW4gPSBieXRlcy5sZW5ndGgsIGJhc2U2NCA9ICcnOwogICAgICAgIGZvciAoaSA9IDA7IGkgPCBsZW47IGkgKz0gMykgewogICAgICAgICAgICBiYXNlNjQgKz0gY2hhcnNbYnl0ZXNbaV0gPj4gMl07CiAgICAgICAgICAgIGJhc2U2NCArPSBjaGFyc1soKGJ5dGVzW2ldICYgMykgPDwgNCkgfCAoYnl0ZXNbaSArIDFdID4+IDQpXTsKICAgICAgICAgICAgYmFzZTY0ICs9IGNoYXJzWygoYnl0ZXNbaSArIDFdICYgMTUpIDw8IDIpIHwgKGJ5dGVzW2kgKyAyXSA+PiA2KV07CiAgICAgICAgICAgIGJhc2U2NCArPSBjaGFyc1tieXRlc1tpICsgMl0gJiA2M107CiAgICAgICAgfQogICAgICAgIGlmIChsZW4gJSAzID09PSAyKSB7CiAgICAgICAgICAgIGJhc2U2NCA9IGJhc2U2NC5zdWJzdHJpbmcoMCwgYmFzZTY0Lmxlbmd0aCAtIDEpICsgJz0nOwogICAgICAgIH0KICAgICAgICBlbHNlIGlmIChsZW4gJSAzID09PSAxKSB7CiAgICAgICAgICAgIGJhc2U2NCA9IGJhc2U2NC5zdWJzdHJpbmcoMCwgYmFzZTY0Lmxlbmd0aCAtIDIpICsgJz09JzsKICAgICAgICB9CiAgICAgICAgcmV0dXJuIGJhc2U2NDsKICAgIH07CgogICAgY29uc3QgbGFzdEJsb2JNYXAgPSBuZXcgTWFwKCk7DQogICAgY29uc3QgdHJhbnNwYXJlbnRCbG9iTWFwID0gbmV3IE1hcCgpOw0KICAgIGZ1bmN0aW9uIGdldFRyYW5zcGFyZW50QmxvYkZvcih3aWR0aCwgaGVpZ2h0LCBkYXRhVVJMT3B0aW9ucykgew0KICAgICAgICByZXR1cm4gX19hd2FpdGVyKHRoaXMsIHZvaWQgMCwgdm9pZCAwLCBmdW5jdGlvbiogKCkgew0KICAgICAgICAgICAgY29uc3QgaWQgPSBgJHt3aWR0aH0tJHtoZWlnaHR9YDsNCiAgICAgICAgICAgIGlmICgnT2Zmc2NyZWVuQ2FudmFzJyBpbiBnbG9iYWxUaGlzKSB7DQogICAgICAgICAgICAgICAgaWYgKHRyYW5zcGFyZW50QmxvYk1hcC5oYXMoaWQpKQ0KICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJhbnNwYXJlbnRCbG9iTWFwLmdldChpZCk7DQogICAgICAgICAgICAgICAgY29uc3Qgb2Zmc2NyZWVuID0gbmV3IE9mZnNjcmVlbkNhbnZhcyh3aWR0aCwgaGVpZ2h0KTsNCiAgICAgICAgICAgICAgICBvZmZzY3JlZW4uZ2V0Q29udGV4dCgnMmQnKTsNCiAgICAgICAgICAgICAgICBjb25zdCBibG9iID0geWllbGQgb2Zmc2NyZWVuLmNvbnZlcnRUb0Jsb2IoZGF0YVVSTE9wdGlvbnMpOw0KICAgICAgICAgICAgICAgIGNvbnN0IGFycmF5QnVmZmVyID0geWllbGQgYmxvYi5hcnJheUJ1ZmZlcigpOw0KICAgICAgICAgICAgICAgIGNvbnN0IGJhc2U2NCA9IGVuY29kZShhcnJheUJ1ZmZlcik7DQogICAgICAgICAgICAgICAgdHJhbnNwYXJlbnRCbG9iTWFwLnNldChpZCwgYmFzZTY0KTsNCiAgICAgICAgICAgICAgICByZXR1cm4gYmFzZTY0Ow0KICAgICAgICAgICAgfQ0KICAgICAgICAgICAgZWxzZSB7DQogICAgICAgICAgICAgICAgcmV0dXJuICcnOw0KICAgICAgICAgICAgfQ0KICAgICAgICB9KTsNCiAgICB9DQogICAgY29uc3Qgd29ya2VyID0gc2VsZjsNCiAgICB3b3JrZXIub25tZXNzYWdlID0gZnVuY3Rpb24gKGUpIHsNCiAgICAgICAgcmV0dXJuIF9fYXdhaXRlcih0aGlzLCB2b2lkIDAsIHZvaWQgMCwgZnVuY3Rpb24qICgpIHsNCiAgICAgICAgICAgIGlmICgnT2Zmc2NyZWVuQ2FudmFzJyBpbiBnbG9iYWxUaGlzKSB7DQogICAgICAgICAgICAgICAgY29uc3QgeyBpZCwgYml0bWFwLCB3aWR0aCwgaGVpZ2h0LCBkYXRhVVJMT3B0aW9ucyB9ID0gZS5kYXRhOw0KICAgICAgICAgICAgICAgIGNvbnN0IHRyYW5zcGFyZW50QmFzZTY0ID0gZ2V0VHJhbnNwYXJlbnRCbG9iRm9yKHdpZHRoLCBoZWlnaHQsIGRhdGFVUkxPcHRpb25zKTsNCiAgICAgICAgICAgICAgICBjb25zdCBvZmZzY3JlZW4gPSBuZXcgT2Zmc2NyZWVuQ2FudmFzKHdpZHRoLCBoZWlnaHQpOw0KICAgICAgICAgICAgICAgIGNvbnN0IGN0eCA9IG9mZnNjcmVlbi5nZXRDb250ZXh0KCcyZCcpOw0KICAgICAgICAgICAgICAgIGN0eC5kcmF3SW1hZ2UoYml0bWFwLCAwLCAwKTsNCiAgICAgICAgICAgICAgICBiaXRtYXAuY2xvc2UoKTsNCiAgICAgICAgICAgICAgICBjb25zdCBibG9iID0geWllbGQgb2Zmc2NyZWVuLmNvbnZlcnRUb0Jsb2IoZGF0YVVSTE9wdGlvbnMpOw0KICAgICAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBibG9iLnR5cGU7DQogICAgICAgICAgICAgICAgY29uc3QgYXJyYXlCdWZmZXIgPSB5aWVsZCBibG9iLmFycmF5QnVmZmVyKCk7DQogICAgICAgICAgICAgICAgY29uc3QgYmFzZTY0ID0gZW5jb2RlKGFycmF5QnVmZmVyKTsNCiAgICAgICAgICAgICAgICBpZiAoIWxhc3RCbG9iTWFwLmhhcyhpZCkgJiYgKHlpZWxkIHRyYW5zcGFyZW50QmFzZTY0KSA9PT0gYmFzZTY0KSB7DQogICAgICAgICAgICAgICAgICAgIGxhc3RCbG9iTWFwLnNldChpZCwgYmFzZTY0KTsNCiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHdvcmtlci5wb3N0TWVzc2FnZSh7IGlkIH0pOw0KICAgICAgICAgICAgICAgIH0NCiAgICAgICAgICAgICAgICBpZiAobGFzdEJsb2JNYXAuZ2V0KGlkKSA9PT0gYmFzZTY0KQ0KICAgICAgICAgICAgICAgICAgICByZXR1cm4gd29ya2VyLnBvc3RNZXNzYWdlKHsgaWQgfSk7DQogICAgICAgICAgICAgICAgd29ya2VyLnBvc3RNZXNzYWdlKHsNCiAgICAgICAgICAgICAgICAgICAgaWQsDQogICAgICAgICAgICAgICAgICAgIHR5cGUsDQogICAgICAgICAgICAgICAgICAgIGJhc2U2NCwNCiAgICAgICAgICAgICAgICAgICAgd2lkdGgsDQogICAgICAgICAgICAgICAgICAgIGhlaWdodCwNCiAgICAgICAgICAgICAgICB9KTsNCiAgICAgICAgICAgICAgICBsYXN0QmxvYk1hcC5zZXQoaWQsIGJhc2U2NCk7DQogICAgICAgICAgICB9DQogICAgICAgICAgICBlbHNlIHsNCiAgICAgICAgICAgICAgICByZXR1cm4gd29ya2VyLnBvc3RNZXNzYWdlKHsgaWQ6IGUuZGF0YS5pZCB9KTsNCiAgICAgICAgICAgIH0NCiAgICAgICAgfSk7DQogICAgfTsKCn0pKCk7Cgo=');

    class CanvasManager {
        constructor(options) {
            this.pendingCanvasMutations = new Map();
            this.rafStamps = { latestId: 0, invokeId: null };
            this.frozen = false;
            this.locked = false;
            this.processMutation = (target, mutation) => {
                const newFrame = this.rafStamps.invokeId &&
                    this.rafStamps.latestId !== this.rafStamps.invokeId;
                if (newFrame || !this.rafStamps.invokeId)
                    this.rafStamps.invokeId = this.rafStamps.latestId;
                if (!this.pendingCanvasMutations.has(target)) {
                    this.pendingCanvasMutations.set(target, []);
                }
                this.pendingCanvasMutations.get(target).push(mutation);
            };
            const { sampling = 'all', win, blockClass, blockSelector, recordCanvas, dataURLOptions, } = options;
            this.mutationCb = options.mutationCb;
            this.mirror = options.mirror;
            if (recordCanvas && sampling === 'all')
                this.initCanvasMutationObserver(win, blockClass, blockSelector);
            if (recordCanvas && typeof sampling === 'number')
                this.initCanvasFPSObserver(sampling, win, blockClass, blockSelector, {
                    dataURLOptions,
                });
        }
        reset() {
            this.pendingCanvasMutations.clear();
            this.resetObservers && this.resetObservers();
        }
        freeze() {
            this.frozen = true;
        }
        unfreeze() {
            this.frozen = false;
        }
        lock() {
            this.locked = true;
        }
        unlock() {
            this.locked = false;
        }
        initCanvasFPSObserver(fps, win, blockClass, blockSelector, options) {
            const canvasContextReset = initCanvasContextObserver(win, blockClass, blockSelector);
            const snapshotInProgressMap = new Map();
            const worker = new WorkerFactory();
            worker.onmessage = (e) => {
                const { id } = e.data;
                snapshotInProgressMap.set(id, false);
                if (!('base64' in e.data))
                    return;
                const { base64, type, width, height } = e.data;
                this.mutationCb({
                    id,
                    type: CanvasContext['2D'],
                    commands: [
                        {
                            property: 'clearRect',
                            args: [0, 0, width, height],
                        },
                        {
                            property: 'drawImage',
                            args: [
                                {
                                    rr_type: 'ImageBitmap',
                                    args: [
                                        {
                                            rr_type: 'Blob',
                                            data: [{ rr_type: 'ArrayBuffer', base64 }],
                                            type,
                                        },
                                    ],
                                },
                                0,
                                0,
                            ],
                        },
                    ],
                });
            };
            const timeBetweenSnapshots = 1000 / fps;
            let lastSnapshotTime = 0;
            let rafId;
            const getCanvas = () => {
                const matchedCanvas = [];
                win.document.querySelectorAll('canvas').forEach((canvas) => {
                    if (!isBlocked(canvas, blockClass, blockSelector, true)) {
                        matchedCanvas.push(canvas);
                    }
                });
                return matchedCanvas;
            };
            const takeCanvasSnapshots = (timestamp) => {
                if (lastSnapshotTime &&
                    timestamp - lastSnapshotTime < timeBetweenSnapshots) {
                    rafId = requestAnimationFrame(takeCanvasSnapshots);
                    return;
                }
                lastSnapshotTime = timestamp;
                getCanvas()
                    .forEach((canvas) => __awaiter(this, void 0, void 0, function* () {
                    var _a;
                    const id = this.mirror.getId(canvas);
                    if (snapshotInProgressMap.get(id))
                        return;
                    snapshotInProgressMap.set(id, true);
                    if (['webgl', 'webgl2'].includes(canvas.__context)) {
                        const context = canvas.getContext(canvas.__context);
                        if (((_a = context === null || context === void 0 ? void 0 : context.getContextAttributes()) === null || _a === void 0 ? void 0 : _a.preserveDrawingBuffer) === false) {
                            context === null || context === void 0 ? void 0 : context.clear(context.COLOR_BUFFER_BIT);
                        }
                    }
                    const bitmap = yield createImageBitmap(canvas);
                    worker.postMessage({
                        id,
                        bitmap,
                        width: canvas.width,
                        height: canvas.height,
                        dataURLOptions: options.dataURLOptions,
                    }, [bitmap]);
                }));
                rafId = requestAnimationFrame(takeCanvasSnapshots);
            };
            rafId = requestAnimationFrame(takeCanvasSnapshots);
            this.resetObservers = () => {
                canvasContextReset();
                cancelAnimationFrame(rafId);
            };
        }
        initCanvasMutationObserver(win, blockClass, blockSelector) {
            this.startRAFTimestamping();
            this.startPendingCanvasMutationFlusher();
            const canvasContextReset = initCanvasContextObserver(win, blockClass, blockSelector);
            const canvas2DReset = initCanvas2DMutationObserver(this.processMutation.bind(this), win, blockClass, blockSelector);
            const canvasWebGL1and2Reset = initCanvasWebGLMutationObserver(this.processMutation.bind(this), win, blockClass, blockSelector, this.mirror);
            this.resetObservers = () => {
                canvasContextReset();
                canvas2DReset();
                canvasWebGL1and2Reset();
            };
        }
        startPendingCanvasMutationFlusher() {
            requestAnimationFrame(() => this.flushPendingCanvasMutations());
        }
        startRAFTimestamping() {
            const setLatestRAFTimestamp = (timestamp) => {
                this.rafStamps.latestId = timestamp;
                requestAnimationFrame(setLatestRAFTimestamp);
            };
            requestAnimationFrame(setLatestRAFTimestamp);
        }
        flushPendingCanvasMutations() {
            this.pendingCanvasMutations.forEach((values, canvas) => {
                const id = this.mirror.getId(canvas);
                this.flushPendingCanvasMutationFor(canvas, id);
            });
            requestAnimationFrame(() => this.flushPendingCanvasMutations());
        }
        flushPendingCanvasMutationFor(canvas, id) {
            if (this.frozen || this.locked) {
                return;
            }
            const valuesWithType = this.pendingCanvasMutations.get(canvas);
            if (!valuesWithType || id === -1)
                return;
            const values = valuesWithType.map((value) => {
                const rest = __rest(value, ["type"]);
                return rest;
            });
            const { type } = valuesWithType[0];
            this.mutationCb({ id, type, commands: values });
            this.pendingCanvasMutations.delete(canvas);
        }
    }

    class StylesheetManager {
        constructor(options) {
            this.trackedLinkElements = new WeakSet();
            this.styleMirror = new StyleSheetMirror();
            this.mutationCb = options.mutationCb;
            this.adoptedStyleSheetCb = options.adoptedStyleSheetCb;
        }
        attachLinkElement(linkEl, childSn) {
            if ('_cssText' in childSn.attributes)
                this.mutationCb({
                    adds: [],
                    removes: [],
                    texts: [],
                    attributes: [
                        {
                            id: childSn.id,
                            attributes: childSn
                                .attributes,
                        },
                    ],
                });
            this.trackLinkElement(linkEl);
        }
        trackLinkElement(linkEl) {
            if (this.trackedLinkElements.has(linkEl))
                return;
            this.trackedLinkElements.add(linkEl);
            this.trackStylesheetInLinkElement(linkEl);
        }
        adoptStyleSheets(sheets, hostId) {
            if (sheets.length === 0)
                return;
            const adoptedStyleSheetData = {
                id: hostId,
                styleIds: [],
            };
            const styles = [];
            for (const sheet of sheets) {
                let styleId;
                if (!this.styleMirror.has(sheet)) {
                    styleId = this.styleMirror.add(sheet);
                    const rules = Array.from(sheet.rules || CSSRule);
                    styles.push({
                        styleId,
                        rules: rules.map((r, index) => {
                            return {
                                rule: getCssRuleString(r),
                                index,
                            };
                        }),
                    });
                }
                else
                    styleId = this.styleMirror.getId(sheet);
                adoptedStyleSheetData.styleIds.push(styleId);
            }
            if (styles.length > 0)
                adoptedStyleSheetData.styles = styles;
            this.adoptedStyleSheetCb(adoptedStyleSheetData);
        }
        reset() {
            this.styleMirror.reset();
            this.trackedLinkElements = new WeakSet();
        }
        trackStylesheetInLinkElement(linkEl) {
        }
    }

    function wrapEvent(e) {
        return Object.assign(Object.assign({}, e), { timestamp: Date.now() });
    }
    let wrappedEmit;
    let takeFullSnapshot;
    let canvasManager;
    let recording = false;
    const mirror = createMirror();
    function record(options = {}) {
        const { emit, checkoutEveryNms, checkoutEveryNth, blockClass = 'rr-block', blockSelector = null, ignoreClass = 'rr-ignore', maskTextClass = 'rr-mask', maskTextSelector = null, inlineStylesheet = true, maskAllInputs, maskInputOptions: _maskInputOptions, slimDOMOptions: _slimDOMOptions, maskInputFn, maskTextFn, hooks, packFn, sampling = {}, dataURLOptions = {}, mousemoveWait, recordCanvas = false, recordCrossOriginIframes = false, userTriggeredOnInput = false, collectFonts = false, inlineImages = false, plugins, keepIframeSrcFn = () => false, ignoreCSSAttributes = new Set([]), } = options;
        const inEmittingFrame = recordCrossOriginIframes
            ? window.parent === window
            : true;
        let passEmitsToParent = false;
        if (!inEmittingFrame) {
            try {
                window.parent.document;
                passEmitsToParent = false;
            }
            catch (e) {
                passEmitsToParent = true;
            }
        }
        if (inEmittingFrame && !emit) {
            throw new Error('emit function is required');
        }
        if (mousemoveWait !== undefined && sampling.mousemove === undefined) {
            sampling.mousemove = mousemoveWait;
        }
        mirror.reset();
        const maskInputOptions = maskAllInputs === true
            ? {
                color: true,
                date: true,
                'datetime-local': true,
                email: true,
                month: true,
                number: true,
                range: true,
                search: true,
                tel: true,
                text: true,
                time: true,
                url: true,
                week: true,
                textarea: true,
                select: true,
                password: true,
            }
            : _maskInputOptions !== undefined
                ? _maskInputOptions
                : { password: true };
        const slimDOMOptions = _slimDOMOptions === true || _slimDOMOptions === 'all'
            ? {
                script: true,
                comment: true,
                headFavicon: true,
                headWhitespace: true,
                headMetaSocial: true,
                headMetaRobots: true,
                headMetaHttpEquiv: true,
                headMetaVerification: true,
                headMetaAuthorship: _slimDOMOptions === 'all',
                headMetaDescKeywords: _slimDOMOptions === 'all',
            }
            : _slimDOMOptions
                ? _slimDOMOptions
                : {};
        polyfill();
        let lastFullSnapshotEvent;
        let incrementalSnapshotCount = 0;
        const eventProcessor = (e) => {
            for (const plugin of plugins || []) {
                if (plugin.eventProcessor) {
                    e = plugin.eventProcessor(e);
                }
            }
            if (packFn) {
                e = packFn(e);
            }
            return e;
        };
        wrappedEmit = (e, isCheckout) => {
            var _a;
            if (((_a = mutationBuffers[0]) === null || _a === void 0 ? void 0 : _a.isFrozen()) &&
                e.type !== EventType.FullSnapshot &&
                !(e.type === EventType.IncrementalSnapshot &&
                    e.data.source === IncrementalSource.Mutation)) {
                mutationBuffers.forEach((buf) => buf.unfreeze());
            }
            if (inEmittingFrame) {
                emit === null || emit === void 0 ? void 0 : emit(eventProcessor(e), isCheckout);
            }
            else if (passEmitsToParent) {
                const message = {
                    type: 'rrweb',
                    event: eventProcessor(e),
                    isCheckout,
                };
                window.parent.postMessage(message, '*');
            }
            if (e.type === EventType.FullSnapshot) {
                lastFullSnapshotEvent = e;
                incrementalSnapshotCount = 0;
            }
            else if (e.type === EventType.IncrementalSnapshot) {
                if (e.data.source === IncrementalSource.Mutation &&
                    e.data.isAttachIframe) {
                    return;
                }
                incrementalSnapshotCount++;
                const exceedCount = checkoutEveryNth && incrementalSnapshotCount >= checkoutEveryNth;
                const exceedTime = checkoutEveryNms &&
                    e.timestamp - lastFullSnapshotEvent.timestamp > checkoutEveryNms;
                if (exceedCount || exceedTime) {
                    takeFullSnapshot(true);
                }
            }
        };
        const wrappedMutationEmit = (m) => {
            wrappedEmit(wrapEvent({
                type: EventType.IncrementalSnapshot,
                data: Object.assign({ source: IncrementalSource.Mutation }, m),
            }));
        };
        const wrappedScrollEmit = (p) => wrappedEmit(wrapEvent({
            type: EventType.IncrementalSnapshot,
            data: Object.assign({ source: IncrementalSource.Scroll }, p),
        }));
        const wrappedCanvasMutationEmit = (p) => wrappedEmit(wrapEvent({
            type: EventType.IncrementalSnapshot,
            data: Object.assign({ source: IncrementalSource.CanvasMutation }, p),
        }));
        const wrappedAdoptedStyleSheetEmit = (a) => wrappedEmit(wrapEvent({
            type: EventType.IncrementalSnapshot,
            data: Object.assign({ source: IncrementalSource.AdoptedStyleSheet }, a),
        }));
        const stylesheetManager = new StylesheetManager({
            mutationCb: wrappedMutationEmit,
            adoptedStyleSheetCb: wrappedAdoptedStyleSheetEmit,
        });
        const iframeManager = new IframeManager({
            mirror,
            mutationCb: wrappedMutationEmit,
            stylesheetManager: stylesheetManager,
            recordCrossOriginIframes,
            wrappedEmit,
        });
        for (const plugin of plugins || []) {
            if (plugin.getMirror)
                plugin.getMirror({
                    nodeMirror: mirror,
                    crossOriginIframeMirror: iframeManager.crossOriginIframeMirror,
                    crossOriginIframeStyleMirror: iframeManager.crossOriginIframeStyleMirror,
                });
        }
        canvasManager = new CanvasManager({
            recordCanvas,
            mutationCb: wrappedCanvasMutationEmit,
            win: window,
            blockClass,
            blockSelector,
            mirror,
            sampling: sampling.canvas,
            dataURLOptions,
        });
        const shadowDomManager = new ShadowDomManager({
            mutationCb: wrappedMutationEmit,
            scrollCb: wrappedScrollEmit,
            bypassOptions: {
                blockClass,
                blockSelector,
                maskTextClass,
                maskTextSelector,
                inlineStylesheet,
                maskInputOptions,
                dataURLOptions,
                maskTextFn,
                maskInputFn,
                recordCanvas,
                inlineImages,
                sampling,
                slimDOMOptions,
                iframeManager,
                stylesheetManager,
                canvasManager,
                keepIframeSrcFn,
            },
            mirror,
        });
        takeFullSnapshot = (isCheckout = false) => {
            var _a, _b, _c, _d, _e, _f;
            wrappedEmit(wrapEvent({
                type: EventType.Meta,
                data: {
                    href: window.location.href,
                    width: getWindowWidth(),
                    height: getWindowHeight(),
                },
            }), isCheckout);
            stylesheetManager.reset();
            mutationBuffers.forEach((buf) => buf.lock());
            const node = snapshot(document, {
                mirror,
                blockClass,
                blockSelector,
                maskTextClass,
                maskTextSelector,
                inlineStylesheet,
                maskAllInputs: maskInputOptions,
                maskTextFn,
                slimDOM: slimDOMOptions,
                dataURLOptions,
                recordCanvas,
                inlineImages,
                onSerialize: (n) => {
                    if (isSerializedIframe(n, mirror)) {
                        iframeManager.addIframe(n);
                    }
                    if (isSerializedStylesheet(n, mirror)) {
                        stylesheetManager.trackLinkElement(n);
                    }
                    if (hasShadowRoot(n)) {
                        shadowDomManager.addShadowRoot(n.shadowRoot, document);
                    }
                },
                onIframeLoad: (iframe, childSn) => {
                    iframeManager.attachIframe(iframe, childSn);
                    shadowDomManager.observeAttachShadow(iframe);
                },
                onStylesheetLoad: (linkEl, childSn) => {
                    stylesheetManager.attachLinkElement(linkEl, childSn);
                },
                keepIframeSrcFn,
            });
            if (!node) {
                return console.warn('Failed to snapshot the document');
            }
            wrappedEmit(wrapEvent({
                type: EventType.FullSnapshot,
                data: {
                    node,
                    initialOffset: {
                        left: window.pageXOffset !== undefined
                            ? window.pageXOffset
                            : (document === null || document === void 0 ? void 0 : document.documentElement.scrollLeft) ||
                                ((_b = (_a = document === null || document === void 0 ? void 0 : document.body) === null || _a === void 0 ? void 0 : _a.parentElement) === null || _b === void 0 ? void 0 : _b.scrollLeft) ||
                                ((_c = document === null || document === void 0 ? void 0 : document.body) === null || _c === void 0 ? void 0 : _c.scrollLeft) ||
                                0,
                        top: window.pageYOffset !== undefined
                            ? window.pageYOffset
                            : (document === null || document === void 0 ? void 0 : document.documentElement.scrollTop) ||
                                ((_e = (_d = document === null || document === void 0 ? void 0 : document.body) === null || _d === void 0 ? void 0 : _d.parentElement) === null || _e === void 0 ? void 0 : _e.scrollTop) ||
                                ((_f = document === null || document === void 0 ? void 0 : document.body) === null || _f === void 0 ? void 0 : _f.scrollTop) ||
                                0,
                    },
                },
            }));
            mutationBuffers.forEach((buf) => buf.unlock());
            if (document.adoptedStyleSheets && document.adoptedStyleSheets.length > 0)
                stylesheetManager.adoptStyleSheets(document.adoptedStyleSheets, mirror.getId(document));
        };
        try {
            const handlers = [];
            handlers.push(on('DOMContentLoaded', () => {
                wrappedEmit(wrapEvent({
                    type: EventType.DomContentLoaded,
                    data: {},
                }));
            }));
            const observe = (doc) => {
                var _a;
                return initObservers({
                    mutationCb: wrappedMutationEmit,
                    mousemoveCb: (positions, source) => wrappedEmit(wrapEvent({
                        type: EventType.IncrementalSnapshot,
                        data: {
                            source,
                            positions,
                        },
                    })),
                    mouseInteractionCb: (d) => wrappedEmit(wrapEvent({
                        type: EventType.IncrementalSnapshot,
                        data: Object.assign({ source: IncrementalSource.MouseInteraction }, d),
                    })),
                    scrollCb: wrappedScrollEmit,
                    viewportResizeCb: (d) => wrappedEmit(wrapEvent({
                        type: EventType.IncrementalSnapshot,
                        data: Object.assign({ source: IncrementalSource.ViewportResize }, d),
                    })),
                    inputCb: (v) => wrappedEmit(wrapEvent({
                        type: EventType.IncrementalSnapshot,
                        data: Object.assign({ source: IncrementalSource.Input }, v),
                    })),
                    mediaInteractionCb: (p) => wrappedEmit(wrapEvent({
                        type: EventType.IncrementalSnapshot,
                        data: Object.assign({ source: IncrementalSource.MediaInteraction }, p),
                    })),
                    styleSheetRuleCb: (r) => wrappedEmit(wrapEvent({
                        type: EventType.IncrementalSnapshot,
                        data: Object.assign({ source: IncrementalSource.StyleSheetRule }, r),
                    })),
                    styleDeclarationCb: (r) => wrappedEmit(wrapEvent({
                        type: EventType.IncrementalSnapshot,
                        data: Object.assign({ source: IncrementalSource.StyleDeclaration }, r),
                    })),
                    canvasMutationCb: wrappedCanvasMutationEmit,
                    fontCb: (p) => wrappedEmit(wrapEvent({
                        type: EventType.IncrementalSnapshot,
                        data: Object.assign({ source: IncrementalSource.Font }, p),
                    })),
                    selectionCb: (p) => {
                        wrappedEmit(wrapEvent({
                            type: EventType.IncrementalSnapshot,
                            data: Object.assign({ source: IncrementalSource.Selection }, p),
                        }));
                    },
                    blockClass,
                    ignoreClass,
                    maskTextClass,
                    maskTextSelector,
                    maskInputOptions,
                    inlineStylesheet,
                    sampling,
                    recordCanvas,
                    inlineImages,
                    userTriggeredOnInput,
                    collectFonts,
                    doc,
                    maskInputFn,
                    maskTextFn,
                    keepIframeSrcFn,
                    blockSelector,
                    slimDOMOptions,
                    dataURLOptions,
                    mirror,
                    iframeManager,
                    stylesheetManager,
                    shadowDomManager,
                    canvasManager,
                    ignoreCSSAttributes,
                    plugins: ((_a = plugins === null || plugins === void 0 ? void 0 : plugins.filter((p) => p.observer)) === null || _a === void 0 ? void 0 : _a.map((p) => ({
                        observer: p.observer,
                        options: p.options,
                        callback: (payload) => wrappedEmit(wrapEvent({
                            type: EventType.Plugin,
                            data: {
                                plugin: p.name,
                                payload,
                            },
                        })),
                    }))) || [],
                }, hooks);
            };
            iframeManager.addLoadListener((iframeEl) => {
                handlers.push(observe(iframeEl.contentDocument));
            });
            const init = () => {
                takeFullSnapshot();
                handlers.push(observe(document));
                recording = true;
            };
            if (document.readyState === 'interactive' ||
                document.readyState === 'complete') {
                init();
            }
            else {
                handlers.push(on('load', () => {
                    wrappedEmit(wrapEvent({
                        type: EventType.Load,
                        data: {},
                    }));
                    init();
                }, window));
            }
            return () => {
                handlers.forEach((h) => h());
                recording = false;
            };
        }
        catch (error) {
            console.warn(error);
        }
    }
    record.addCustomEvent = (tag, payload) => {
        if (!recording) {
            throw new Error('please add custom event after start recording');
        }
        wrappedEmit(wrapEvent({
            type: EventType.Custom,
            data: {
                tag,
                payload,
            },
        }));
    };
    record.freezePage = () => {
        mutationBuffers.forEach((buf) => buf.freeze());
    };
    record.takeFullSnapshot = (isCheckout) => {
        if (!recording) {
            throw new Error('please take full snapshot after start recording');
        }
        takeFullSnapshot(isCheckout);
    };
    record.mirror = mirror;

    const defaultRecorder = (options) => {
        // rrweb is bundled into page-world.js by rollup. ~100KB minified — future
        // M12.5 may split it behind a web_accessible_resources lazy load.
        return record({
            emit: (e) => {
                // Narrow rrweb's event to our internal RrwebEvent shape (just the three
                // fields we propagate); rrweb's type churns across versions.
                const ev = e;
                options.emit({
                    type: ev.type,
                    data: ev.data,
                    timestamp: ev.timestamp,
                });
            },
        });
    };
    const installRrwebRecording = (opts) => {
        const recorder = opts.recorder ?? defaultRecorder;
        const setTimer = opts.setTimer ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
        const clearTimer = opts.clearTimer ?? ((id) => globalThis.clearTimeout(id));
        const stop = recorder({
            emit: (rrwebEvent) => {
                const event = {
                    kind: 'replay',
                    ts: rrwebEvent.timestamp,
                    frameUrl: opts.frame.frameUrl,
                    frameKey: opts.frame.frameKey,
                    sessionId: opts.sessionId,
                    rrwebType: rrwebEvent.type,
                    data: rrwebEvent.data,
                    timestamp: rrwebEvent.timestamp,
                };
                opts.emit(event);
            },
        });
        let timerId = null;
        let disposed = false;
        const dispose = () => {
            if (disposed)
                return;
            disposed = true;
            if (timerId !== null) {
                clearTimer(timerId);
                timerId = null;
            }
            if (typeof stop === 'function')
                stop();
        };
        if (opts.durationCapMs !== undefined && opts.durationCapMs > 0) {
            timerId = setTimer(() => {
                // Timer already fired — null out the id BEFORE dispose so dispose
                // doesn't redundantly call clearTimer on a spent handle.
                timerId = null;
                dispose();
            }, opts.durationCapMs);
        }
        return dispose;
    };

    /**
     * Module-singleton holding the active rrweb recording. One recording per
     * page-world. start() tears down any prior recording before installing a fresh
     * one (idempotent re-config). stop() tears down and clears.
     *
     * resetRecordingState() is test-only; production code never calls it.
     */
    let active = null;
    const startRecording = (opts) => {
        if (active !== null) {
            active.dispose();
            active = null;
        }
        const dispose = installRrwebRecording(opts);
        active = {
            sessionId: opts.sessionId,
            ...(opts.durationCapMs !== undefined
                ? { durationCapMs: opts.durationCapMs }
                : {}),
            dispose,
        };
        return opts.sessionId;
    };
    const stopRecording = () => {
        if (active === null)
            return null;
        const sessionId = active.sessionId;
        active.dispose();
        active = null;
        return sessionId;
    };
    const getActiveSessionId = () => active === null ? null : active.sessionId;
    const getActiveDurationCapMs = () => active === null ? undefined : active.durationCapMs;

    const TOP_KEY = 'top';
    const indexInParent = (win, parent) => {
        const len = parent.frames.length;
        for (let i = 0; i < len; i++) {
            if (parent.frames[i] === win)
                return i;
        }
        return -1;
    };
    // Always namespaced with `cross_origin/` so a cross-origin frame key can
    // never collide with a structural `top/...` key — the uuid source is the
    // shared guarded generator.
    const defaultFallback = () => `cross_origin/${safeUuid()}`;
    const deriveFrameKey = (win, fallback = defaultFallback) => {
        if (win === win.top)
            return TOP_KEY;
        const indices = [];
        let memoizedFallback;
        const cachedFallback = () => {
            if (memoizedFallback === undefined)
                memoizedFallback = fallback();
            return memoizedFallback;
        };
        let current = win;
        try {
            while (current !== current.parent) {
                const parent = current.parent;
                const idx = indexInParent(current, parent);
                if (idx < 0)
                    return cachedFallback();
                indices.push(idx);
                current = parent;
            }
        }
        catch {
            return cachedFallback();
        }
        indices.reverse();
        return `${TOP_KEY}/${indices.join('/')}`;
    };

    const detectCrossOrigin = (win) => {
        if (win === win.top)
            return false;
        try {
            void win.parent.location.href;
            return false;
        }
        catch {
            return true;
        }
    };
    const computeFrameMeta = (win = window) => ({
        frameUrl: win.location.href,
        frameKey: deriveFrameKey(win),
        isCrossOrigin: detectCrossOrigin(win),
    });

    /**
     * Pure projection of the debugged page's live service-worker registrations +
     * controller into the wire-safe `SwStatusSnapshot`. No `navigator.*` reads here
     * — the edge dispatcher (page-world `sw_status` handler) reads the live objects
     * and hands them in, so this stays pure and unit-testable with plain fakes.
     *
     * This is the DEBUGGED PWA's service worker, distinct from the extension's own
     * `sw_lifecycle` module (which captures SW-side page-navigation lifecycle).
     */
    const projectWorker = (worker) => worker === null
        ? null
        : { scriptURL: worker.scriptURL, state: worker.state };
    const projectRegistration = (reg) => {
        const active = projectWorker(reg.active);
        return {
            scope: reg.scope,
            updateViaCache: reg.updateViaCache ?? 'imports',
            installing: projectWorker(reg.installing),
            waiting: projectWorker(reg.waiting),
            active,
            activeScriptURL: active === null ? null : active.scriptURL,
            hasWaitingUpdate: reg.waiting !== null,
        };
    };
    /**
     * Project live registrations + controller into a `SwStatusSnapshot`.
     *
     * @param registrations result of `navigator.serviceWorker.getRegistrations()`
     * @param controller    `navigator.serviceWorker.controller`
     * @param supported     whether `navigator.serviceWorker` exists (default true)
     */
    const projectServiceWorkerState = (registrations, controller, supported = true) => {
        const projected = registrations.map(projectRegistration);
        return {
            supported,
            controller: projectWorker(controller),
            registrations: projected,
            hasWaitingUpdate: projected.some((reg) => reg.hasWaitingUpdate),
        };
    };

    /**
     * Pure projection of a cached request/response pair into a CacheEntryRecord.
     * No caches.* I/O — the readers (read.ts) perform the async reads and hand the
     * already-extracted fields here, keeping this unit-testable with plain fakes.
     */
    const parseContentLength = (raw) => {
        if (raw === null)
            return null;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const computeAgeSeconds = (dateHeader, now) => {
        if (dateHeader === null)
            return null;
        const parsed = Date.parse(dateHeader);
        if (Number.isNaN(parsed))
            return null;
        return Math.max(0, Math.round((now - parsed) / 1000));
    };
    const projectCacheEntry = (input, now) => {
        const headers = input.headers ?? null;
        const get = (name) => headers === null ? null : headers.get(name);
        const dateHeader = get('date');
        return {
            url: input.url,
            method: input.method,
            status: input.status ?? null,
            ...(input.statusText !== undefined && input.statusText.length > 0
                ? { statusText: input.statusText }
                : {}),
            contentType: get('content-type'),
            contentLength: parseContentLength(get('content-length')),
            dateHeader,
            ageSeconds: computeAgeSeconds(dateHeader, now),
            cacheControl: get('cache-control'),
        };
    };

    /**
     * Async CacheStorage readers — the edge that performs caches.* I/O and composes
     * projectCacheEntry. The CacheStorage is injected (defaults to the page's global
     * `caches` at the call site) so these are unit-testable with a fake store.
     *
     * Wraps the browser CacheStorage API for the cache_list / cache_inspect /
     * cache_match MCP tools; orchestrators import these, never caches.* directly.
     */
    const readCacheList = async (store) => {
        if (store === null)
            return { supported: false, caches: [] };
        const names = await store.keys();
        const caches = await Promise.all(names.map(async (name) => {
            const cache = await store.open(name);
            const keys = await cache.keys();
            return { name, entryCount: keys.length };
        }));
        return { supported: true, caches };
    };
    const readCacheInspect = async (store, name, limit, now) => {
        if (store === null) {
            return { supported: false, found: false, name, entries: [], entryCount: 0, truncated: false };
        }
        if (!(await store.has(name))) {
            return { supported: true, found: false, name, entries: [], entryCount: 0, truncated: false };
        }
        const cache = await store.open(name);
        const keys = await cache.keys();
        const entryCount = keys.length;
        const entries = await Promise.all(keys.slice(0, limit).map(async (req) => {
            const res = await cache.match(req);
            return projectCacheEntry({
                url: req.url,
                method: req.method,
                ...(res !== undefined
                    ? { status: res.status, statusText: res.statusText, headers: res.headers }
                    : {}),
            }, now);
        }));
        return { supported: true, found: true, name, entries, entryCount, truncated: entryCount > limit };
    };
    const readCacheMatch = async (store, url, now) => {
        if (store === null) {
            return { supported: false, url, matched: false, cacheName: null, entry: null };
        }
        const names = await store.keys();
        for (const name of names) {
            const cache = await store.open(name);
            const res = await cache.match(url);
            if (res !== undefined) {
                return {
                    supported: true,
                    url,
                    matched: true,
                    cacheName: name,
                    entry: projectCacheEntry({ url, method: 'GET', status: res.status, statusText: res.statusText, headers: res.headers }, now),
                };
            }
        }
        return { supported: true, url, matched: false, cacheName: null, entry: null };
    };

    /**
     * Pure PWA feature-detection: capability matrix, display mode, and permission
     * normalization. All deterministic over the supplied window/navigator-like
     * objects (no globals, no I/O) so they unit-test with plain fakes. The async
     * edge (SW controller + Permissions API) lives in read.ts.
     */
    /** `key in obj` guarded against null/non-objects. */
    const has = (obj, key) => obj !== null && typeof obj === 'object' && key in obj;
    const detectPwaCapabilities = (win, nav) => ({
        serviceWorker: has(nav, 'serviceWorker'),
        pushManager: has(win, 'PushManager'),
        backgroundSync: has(win, 'SyncManager'),
        periodicBackgroundSync: has(win, 'PeriodicSyncManager'),
        badging: has(nav, 'setAppBadge'),
        fileSystemAccess: has(win, 'showOpenFilePicker'),
        windowControlsOverlay: has(nav, 'windowControlsOverlay'),
        webShare: has(nav, 'share'),
        notifications: has(win, 'Notification'),
    });
    const INSTALLED_MODES = ['standalone', 'fullscreen', 'minimal-ui'];
    const resolveDisplayMode = (matchMedia) => {
        if (typeof matchMedia !== 'function')
            return 'unknown';
        for (const mode of INSTALLED_MODES) {
            if (matchMedia(`(display-mode: ${mode})`).matches)
                return mode;
        }
        return 'browser';
    };
    const mapPermissionState = (raw) => {
        switch (raw) {
            case 'granted':
            case 'denied':
            case 'prompt':
                return raw;
            case 'default':
                return 'prompt';
            default:
                return 'unknown';
        }
    };

    /**
     * Async edge that assembles the full PwaStatusSnapshot from injected
     * window/navigator: composes the pure detectors with the SW controller read and
     * a Permissions-API snapshot. Injected objects keep it unit-testable; the
     * page-world handler passes the real window + navigator.
     */
    const queryPermission = async (nav, name, extra) => {
        const query = nav.permissions?.query;
        if (typeof query !== 'function')
            return 'unknown';
        try {
            const status = await query({ name, ...(extra ?? {}) });
            return mapPermissionState(status.state);
        }
        catch {
            // Unknown permission name (e.g. 'push' / 'periodic-background-sync' on
            // browsers that don't support querying it) rejects — report unsupported.
            return 'unsupported';
        }
    };
    const readPwaStatus = async (win, nav) => {
        const displayMode = resolveDisplayMode(win.matchMedia);
        const installedByDisplay = displayMode === 'standalone' ||
            displayMode === 'fullscreen' ||
            displayMode === 'minimal-ui';
        const standalone = installedByDisplay || nav.standalone === true;
        const controller = nav.serviceWorker?.controller ?? null;
        const [notifications, push, periodicBackgroundSync] = await Promise.all([
            queryPermission(nav, 'notifications'),
            queryPermission(nav, 'push', { userVisibleOnly: true }),
            queryPermission(nav, 'periodic-background-sync'),
        ]);
        const permissions = {
            notifications,
            push,
            periodicBackgroundSync,
        };
        return {
            displayMode,
            standalone,
            controlledBySW: controller !== null,
            controllerScriptURL: controller?.scriptURL ?? null,
            permissions,
            capabilities: detectPwaCapabilities(win, nav),
        };
    };

    /**
     * Pure PWA installability logic: summarize a parsed manifest, then run the
     * installability rules engine. No fetch / DOM — the edge (read.ts) gathers the
     * manifest + context and hands them here, so every rule is unit-testable.
     */
    const str = (v) => typeof v === 'string' && v.length > 0 ? v : null;
    const summarizeIcon = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const src = str(r['src']);
        if (src === null)
            return null;
        return {
            src,
            sizes: str(r['sizes']),
            type: str(r['type']),
            purpose: str(r['purpose']),
        };
    };
    const summarizeManifest = (raw) => {
        const r = raw !== null && typeof raw === 'object'
            ? raw
            : {};
        const iconsRaw = Array.isArray(r['icons']) ? r['icons'] : [];
        const icons = iconsRaw
            .map(summarizeIcon)
            .filter((i) => i !== null);
        return {
            name: str(r['name']),
            shortName: str(r['short_name']),
            startUrl: str(r['start_url']),
            scope: str(r['scope']),
            display: str(r['display']),
            themeColor: str(r['theme_color']),
            backgroundColor: str(r['background_color']),
            icons,
        };
    };
    const APP_DISPLAY_MODES = ['standalone', 'fullscreen', 'minimal-ui'];
    const tokens = (raw) => raw === null ? [] : raw.trim().toLowerCase().split(/\s+/);
    const hasIconSize = (icons, target) => icons.some((i) => {
        const t = tokens(i.sizes);
        return t.includes(target) || t.includes('any');
    });
    const hasMaskableIcon = (icons) => icons.some((i) => tokens(i.purpose).includes('maskable'));
    const gap = (code, severity, message, fix) => ({ code, severity, message, fix });
    const evaluateInstallability = (input) => {
        const gaps = [];
        if (!input.secureContext) {
            gaps.push(gap('not_secure_context', 'error', 'The page is not in a secure context.', 'Serve the app over HTTPS (localhost is treated as secure for development).'));
        }
        if (!input.hasServiceWorker) {
            gaps.push(gap('no_service_worker', 'error', 'No service worker is registered for this page.', 'Register a service worker with a fetch handler via navigator.serviceWorker.register().'));
        }
        if (!input.manifestFound) {
            gaps.push(gap('no_manifest', 'error', 'No web app manifest was found.', 'Add <link rel="manifest" href="/manifest.webmanifest"> and serve a valid manifest.'));
            return { installable: false, gaps };
        }
        if (input.manifestParseError || input.manifest === null) {
            gaps.push(gap('manifest_parse_error', 'error', 'The web app manifest could not be parsed as JSON.', 'Ensure the manifest is valid JSON served with a JSON content type.'));
            return { installable: false, gaps };
        }
        const m = input.manifest;
        if (m.name === null && m.shortName === null) {
            gaps.push(gap('no_name', 'error', 'The manifest has neither "name" nor "short_name".', 'Add a "name" (and ideally a "short_name") to the manifest.'));
        }
        if (m.startUrl === null) {
            gaps.push(gap('no_start_url', 'error', 'The manifest has no "start_url".', 'Add a "start_url" (e.g. "/") to the manifest.'));
        }
        if (m.display === null || !APP_DISPLAY_MODES.includes(m.display)) {
            gaps.push(gap('display_not_app', 'error', `The manifest "display" is "${m.display ?? '(none)'}", not an app display mode.`, 'Set "display" to "standalone", "fullscreen", or "minimal-ui".'));
        }
        if (!hasIconSize(m.icons, '192x192')) {
            gaps.push(gap('no_192_icon', 'error', 'No 192x192 icon in the manifest.', 'Add an icon entry with "sizes": "192x192".'));
        }
        if (!hasIconSize(m.icons, '512x512')) {
            gaps.push(gap('no_512_icon', 'error', 'No 512x512 icon in the manifest.', 'Add an icon entry with "sizes": "512x512".'));
        }
        if (!hasMaskableIcon(m.icons)) {
            gaps.push(gap('no_maskable_icon', 'warning', 'No maskable icon in the manifest.', 'Add an icon with "purpose": "maskable" for adaptive icons (recommended, not required).'));
        }
        const installable = gaps.every((g) => g.severity !== 'error');
        return { installable, gaps };
    };

    /**
     * Async edge: discover + fetch + parse the web app manifest, then run the pure
     * installability rules. Manifest href / base URL / context / fetch are injected
     * so this is unit-testable; the page-world handler supplies the real DOM + fetch.
     */
    const resolveUrl = (href, base) => {
        try {
            return new URL(href, base).href;
        }
        catch {
            return null;
        }
    };
    const readInstallability = async (env) => {
        const finish = (manifestUrl, manifestFound, manifestParseError, manifest) => {
            const { installable, gaps } = evaluateInstallability({
                manifestFound,
                manifestParseError,
                manifest,
                secureContext: env.secureContext,
                hasServiceWorker: env.hasServiceWorker,
            });
            return {
                supported: true,
                manifestUrl,
                manifestFound,
                secureContext: env.secureContext,
                hasServiceWorker: env.hasServiceWorker,
                manifest,
                installable,
                gaps,
            };
        };
        if (env.manifestHref === null)
            return finish(null, false, false, null);
        const manifestUrl = resolveUrl(env.manifestHref, env.baseUrl);
        if (manifestUrl === null)
            return finish(null, false, false, null);
        let fetched;
        try {
            fetched = await env.fetchText(manifestUrl);
        }
        catch {
            return finish(manifestUrl, false, false, null);
        }
        if (!fetched.ok)
            return finish(manifestUrl, false, false, null);
        let parsed;
        try {
            parsed = JSON.parse(fetched.text);
        }
        catch {
            return finish(manifestUrl, true, true, null);
        }
        return finish(manifestUrl, true, false, summarizeManifest(parsed));
    };

    /**
     * Web-storage (localStorage / sessionStorage) reader for the storage_get tool.
     *
     * The Storage object is injected (the page passes window.localStorage /
     * window.sessionStorage at the call site) so this is unit-testable with a plain
     * fake. Synchronous DOM Storage API — no async. Values are length-capped and the
     * entry list is count-capped so a large store cannot blow the wire payload.
     */
    /** Per-value character cap — long blobs (JWTs, serialized state) are truncated. */
    const STORAGE_VALUE_CAP = 8192;
    const capValue = (raw) => raw.length <= STORAGE_VALUE_CAP
        ? { value: raw, truncated: false }
        : { value: raw.slice(0, STORAGE_VALUE_CAP), truncated: true };
    /**
     * Snapshot a Storage area into a capped StorageGetResult. `storage === null`
     * (area unavailable/blocked) yields supported:false. Keys are read in the
     * area's native index order; `limit` caps how many entries are returned, and
     * entryCount always reports the true total so the caller sees what was dropped.
     */
    const readWebStorage = (storage, area, limit) => {
        if (storage === null) {
            return { supported: false, area, entries: [], entryCount: 0, truncated: false };
        }
        const entryCount = storage.length;
        const take = Math.min(entryCount, Math.max(0, limit));
        const entries = [];
        for (let i = 0; i < take; i += 1) {
            const key = storage.key(i);
            if (key === null)
                continue;
            const capped = capValue(storage.getItem(key) ?? '');
            entries.push(capped.truncated
                ? { key, value: capped.value, truncated: true }
                : { key, value: capped.value });
        }
        return { supported: true, area, entries, entryCount, truncated: entryCount > take };
    };

    /**
     * Pure projections of IndexedDB structure + records into the wire shapes
     * (IdbStoreInfo / IdbIndexInfo / IdbRecord). No indexedDB.* I/O — the readers
     * (idb_read.ts) perform the async open/transaction work and hand the
     * already-extracted fields here, keeping this unit-testable with plain objects
     * (mirrors cache_storage/project.ts's projectCacheEntry).
     */
    /** keyPath is a plain string, a string[] (compound key), or null (out-of-line). */
    const normalizeKeyPath = (keyPath) => Array.isArray(keyPath) ? Object.freeze([...keyPath]) : keyPath;
    const projectIndexInfo = (idx) => Object.freeze({
        name: idx.name,
        keyPath: normalizeKeyPath(idx.keyPath),
        unique: idx.unique,
        multiEntry: idx.multiEntry,
    });
    const projectStoreInfo = (store) => Object.freeze({
        name: store.name,
        keyPath: normalizeKeyPath(store.keyPath),
        autoIncrement: store.autoIncrement,
        indexes: Object.freeze(store.indexes.map(projectIndexInfo)),
    });
    /**
     * Project one record's key + value into an IdbRecord. Both are run through the
     * shared 16KB serializer (serializeStoreValue) so a large blob, cycle, or
     * DOM/Error/function value cannot blow the wire payload; `truncated` reflects
     * the VALUE cap (keys are small structured-clone types in practice).
     */
    const projectIdbRecord = (key, value) => {
        const serializedKey = serializeStoreValue(key);
        const serializedValue = serializeStoreValue(value);
        return serializedValue.truncated
            ? Object.freeze({ key: serializedKey.value, value: serializedValue.value, truncated: true })
            : Object.freeze({ key: serializedKey.value, value: serializedValue.value });
    };

    /**
     * Async IndexedDB readers — the edge that performs indexedDB.* I/O (databases(),
     * open, read-only transactions, getAll/getAllKeys) and composes the pure
     * idb_project projections. The IDBFactory is injected (defaults to the page's
     * `indexedDB` global at the call site) so these are unit-testable with a
     * hand-rolled fake factory (mirrors cache_storage/read.ts injecting a fake
     * CacheStorage).
     *
     * Strictly read-only: a read-only transaction, no writes, and open() is only
     * ever called for a database that databases() already reported — so reading
     * never creates an empty database as a side effect.
     *
     * The OOP, event-based IDB API is wrapped behind thin structural types +
     * promisifyRequest, keeping the FP/no-OOP discipline at this seam.
     */
    // ── Helpers ──────────────────────────────────────────────────────────────────
    const listToArray = (list) => {
        const out = [];
        for (let i = 0; i < list.length; i += 1) {
            const v = list.item(i);
            if (v !== null)
                out.push(v);
        }
        return out;
    };
    const promisifyRequest = (req) => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
    const openDb = (factory, name) => promisifyRequest(factory.open(name));
    const errorMessage = (err) => err instanceof Error ? err.message : String(err);
    const indexViews = (store) => listToArray(store.indexNames).map((name) => {
        const idx = store.index(name);
        return {
            name: idx.name,
            keyPath: idx.keyPath,
            unique: idx.unique,
            multiEntry: idx.multiEntry,
        };
    });
    // ── idb_list ─────────────────────────────────────────────────────────────────
    /** Open a single database read-only and describe its object stores + indexes. */
    const describeDatabase = async (factory, name, version) => {
        let db;
        try {
            db = await openDb(factory, name);
        }
        catch (err) {
            return Object.freeze({ name, version, stores: [], error: errorMessage(err) });
        }
        try {
            const storeNames = listToArray(db.objectStoreNames);
            const resolvedVersion = typeof db.version === 'number' ? db.version : version;
            if (storeNames.length === 0) {
                db.close?.();
                return Object.freeze({ name, version: resolvedVersion, stores: [] });
            }
            const tx = db.transaction(storeNames, 'readonly');
            const stores = storeNames.map((sn) => {
                const os = tx.objectStore(sn);
                return projectStoreInfo({
                    name: os.name,
                    keyPath: os.keyPath,
                    autoIncrement: os.autoIncrement,
                    indexes: indexViews(os),
                });
            });
            db.close?.();
            return Object.freeze({ name, version: resolvedVersion, stores: Object.freeze(stores) });
        }
        catch (err) {
            db.close?.();
            return Object.freeze({ name, version, stores: [], error: errorMessage(err) });
        }
    };
    /**
     * List every IndexedDB database (name + version) and describe each one's object
     * stores. `factory === null` (insecure/unsupported context) yields
     * supported:false; a browser whose indexedDB lacks the databases() enumeration
     * API yields supported:true with an empty list (can't enumerate).
     */
    const readIdbList = async (factory) => {
        if (factory === null || typeof factory.databases !== 'function') {
            return { supported: false, databases: [] };
        }
        const listings = await factory.databases();
        const named = listings.filter((d) => typeof d.name === 'string' && d.name.length > 0);
        const databases = await Promise.all(named.map((d) => describeDatabase(factory, d.name, d.version ?? null)));
        return { supported: true, databases: Object.freeze(databases) };
    };
    // ── idb_query ────────────────────────────────────────────────────────────────
    const emptyQuery = (db, store, supported, found, error) => Object.freeze({
        supported,
        found,
        db,
        store,
        records: [],
        returned: 0,
        truncated: false,
        ...(error !== undefined ? { error } : {}),
    });
    /**
     * Read a capped, read-only slice of records (key + value) from one object store.
     * Fetches limit+1 via getAll/getAllKeys so truncation is detected without
     * counting the whole store; each value is capped by the shared 16KB serializer.
     * found:false when the db or store does not exist; never creates the database
     * (membership is confirmed via databases() before open()).
     */
    const readIdbQuery = async (factory, dbName, storeName, limit) => {
        if (factory === null)
            return emptyQuery(dbName, storeName, false, false);
        if (typeof factory.databases === 'function') {
            const listings = await factory.databases();
            if (!listings.some((d) => d.name === dbName)) {
                return emptyQuery(dbName, storeName, true, false);
            }
        }
        let db;
        try {
            db = await openDb(factory, dbName);
        }
        catch (err) {
            return emptyQuery(dbName, storeName, true, false, errorMessage(err));
        }
        if (!listToArray(db.objectStoreNames).includes(storeName)) {
            db.close?.();
            return emptyQuery(dbName, storeName, true, false);
        }
        try {
            const tx = db.transaction([storeName], 'readonly');
            const os = tx.objectStore(storeName);
            const fetchCount = Math.max(0, limit) + 1;
            const values = await promisifyRequest(os.getAll(undefined, fetchCount));
            const keys = await promisifyRequest(os.getAllKeys(undefined, fetchCount));
            db.close?.();
            const truncated = values.length > limit;
            const records = values
                .slice(0, limit)
                .map((value, i) => projectIdbRecord(keys[i], value));
            return Object.freeze({
                supported: true,
                found: true,
                db: dbName,
                store: storeName,
                records: Object.freeze(records),
                returned: records.length,
                truncated,
            });
        }
        catch (err) {
            db.close?.();
            // The store exists (confirmed above) but the read failed — found stays true.
            return Object.freeze({
                supported: true,
                found: true,
                db: dbName,
                store: storeName,
                records: [],
                returned: 0,
                truncated: false,
                error: errorMessage(err),
            });
        }
    };

    /**
     * Page-world gather for pwa_update_analyze: collects the two page-side inputs
     * the host analyzer needs — a service-worker snapshot and a capped, cross-cache
     * list of CacheStorage entries — in one pass. Pure composition over the existing
     * sw_status + cache_storage readers; the readers are injected so this is
     * unit-testable with plain fakes (no navigator/caches globals here).
     *
     * The host pulls recent network failures from its own ring buffer and runs the
     * analysis — this module adds no new capture surface.
     */
    /** Default per-cache entry cap so a huge cache cannot blow the gather payload. */
    const DEFAULT_GATHER_PER_CACHE_LIMIT$1 = 100;
    /**
     * Gather the SW snapshot + every cache's entries (each tagged with its
     * cacheName, capped per cache). caches.* unavailable ⇒ entries omitted; the SW
     * snapshot is always included so the waiting-update detection still works.
     */
    const gatherUpdateInputs = async (deps, perCacheLimit = DEFAULT_GATHER_PER_CACHE_LIMIT$1) => {
        const sw = await deps.readSw();
        const list = await deps.readCacheList();
        if (!list.supported)
            return { sw, cacheEntries: [] };
        const perCache = await Promise.all(list.caches.map(async (c) => {
            const inspected = await deps.readCacheInspect(c.name, perCacheLimit);
            return inspected.entries.map((e) => ({ ...e, cacheName: c.name }));
        }));
        return { sw, cacheEntries: perCache.flat() };
    };

    /**
     * Page-world gather for pwa_snapshot: capture ONE runtime-state record by
     * composing the existing page-world readers (service worker, store, web storage,
     * IndexedDB structure, CacheStorage names) plus page meta. Pure composition over
     * injected readers — no navigator/caches/indexedDB globals here — so it is
     * unit-testable with plain fakes. Adds no new capture surface.
     */
    /**
     * Assemble a RuntimeSnapshot. The async reads (SW, IDB, caches) run
     * concurrently; the synchronous reads (store, web storage, meta) are read
     * inline. Each sub-read already self-caps, so the composed blob stays bounded.
     */
    const gatherRuntimeSnapshot = async (deps) => {
        const meta = deps.readMeta();
        const [sw, idb, cacheNames] = await Promise.all([
            deps.readSw(),
            deps.readIdbList(),
            deps.readCacheList(),
        ]);
        return {
            url: meta.url,
            title: meta.title,
            capturedAt: meta.capturedAt,
            sw,
            store: deps.readStore(),
            webStorage: {
                local: deps.readWebStorage('local'),
                session: deps.readWebStorage('session'),
            },
            idb,
            cacheNames,
        };
    };

    // Singleton injected by page-world.ts bootstrap so resolveStore can consult the
    // Zustand devtools shim's connect-time captures as a detection path (mirrors
    // reduxShim). Module-level binding, not a global, so tests can reset it.
    let zustandShim = null;
    const setZustandShim = (shim) => {
        zustandShim = shim;
    };
    // Resolve the live store via the framework-agnostic registry. Detection seams
    // are threaded in via the DetectContext, all PASSIVE/read-only: Redux, Pinia and
    // Jotai auto-discovery walk the live document (React fiber-context value for
    // redux + jotai, Vue config.globalProperties.$pinia for pinia), and the Zustand
    // devtools-connect shim's captured stores. An optional framework selector
    // restricts detection to a single adapter (from the store_* tools' framework
    // arg); when omitted, adapters are tried in priority order. Returns
    // { framework, handle } | null.
    const resolveStore = (framework) => detectStore(window, {
        reduxGetStores: () => discoverReduxStores(document),
        ...(zustandShim !== null
            ? { zustandShimGetStores: zustandShim.getStores }
            : {}),
        piniaGetStores: () => discoverPiniaStores(document),
        jotaiGetStores: () => discoverJotaiStores(document),
    }, framework);
    const DEFAULT_EVAL_TIMEOUT_MS = 3000;
    const sessionPingHandler = () => Object.freeze({
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
    });
    const isThenable = (v) => v !== null &&
        (typeof v === 'object' || typeof v === 'function') &&
        typeof v.then === 'function';
    const errorPayload = (err) => {
        if (err instanceof Error) {
            return err.stack === undefined
                ? Object.freeze({ message: err.message })
                : Object.freeze({ message: err.message, stack: err.stack });
        }
        return Object.freeze({ message: String(err) });
    };
    const serializeOne = (value) => {
        const result = serializeArgs$1([value]);
        return { value: result.serialized[0], truncated: result.truncated };
    };
    const readEvaluateInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        if (typeof r['expression'] !== 'string' || r['expression'].length === 0) {
            return null;
        }
        return Object.freeze({
            expression: r['expression'],
            ...(typeof r['timeout_ms'] === 'number' && r['timeout_ms'] > 0
                ? { timeout_ms: r['timeout_ms'] }
                : {}),
            ...(typeof r['await_promise'] === 'boolean'
                ? { await_promise: r['await_promise'] }
                : {}),
        });
    };
    const evaluateHandler = async (env) => {
        const startedAt = performance.now();
        const input = readEvaluateInput(env.payload);
        if (input === null) {
            return Object.freeze({
                durationMs: performance.now() - startedAt,
                error: Object.freeze({
                    message: 'evaluate: payload must be { expression: non-empty string }',
                }),
            });
        }
        let compiled;
        try {
            compiled = new Function('return (' + input.expression + ')');
        }
        catch (err) {
            return Object.freeze({
                durationMs: performance.now() - startedAt,
                error: errorPayload(err),
            });
        }
        let raw;
        try {
            raw = compiled();
        }
        catch (err) {
            return Object.freeze({
                durationMs: performance.now() - startedAt,
                error: errorPayload(err),
            });
        }
        if (input.await_promise === true && isThenable(raw)) {
            const timeoutMs = input.timeout_ms ?? DEFAULT_EVAL_TIMEOUT_MS;
            let timeoutHandle;
            const timedOut = Symbol('evaluate-timeout');
            const timeoutPromise = new Promise((resolve) => {
                timeoutHandle = setTimeout(() => resolve(timedOut), timeoutMs);
            });
            try {
                const settled = await Promise.race([
                    Promise.resolve(raw),
                    timeoutPromise,
                ]);
                if (settled === timedOut) {
                    return Object.freeze({
                        durationMs: performance.now() - startedAt,
                        error: Object.freeze({
                            message: `evaluate: timeout after ${timeoutMs}ms`,
                        }),
                    });
                }
                const ser = serializeOne(settled);
                return Object.freeze({
                    value: ser.value,
                    ...(ser.truncated ? { truncated: true } : {}),
                    durationMs: performance.now() - startedAt,
                });
            }
            catch (err) {
                return Object.freeze({
                    durationMs: performance.now() - startedAt,
                    error: errorPayload(err),
                });
            }
            finally {
                if (timeoutHandle !== undefined)
                    clearTimeout(timeoutHandle);
            }
        }
        const ser = serializeOne(raw);
        return Object.freeze({
            value: ser.value,
            ...(ser.truncated ? { truncated: true } : {}),
            durationMs: performance.now() - startedAt,
        });
    };
    const readReactTreeInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return Object.freeze({});
        const r = raw;
        const out = {};
        const rootIdx = r['root_index'];
        if (typeof rootIdx === 'number' && Number.isInteger(rootIdx) && rootIdx >= 0) {
            out.rootIndex = rootIdx;
        }
        const depth = r['depth_limit'];
        if (typeof depth === 'number' && Number.isInteger(depth) && depth > 0) {
            out.depthLimit = depth;
        }
        const max = r['max_nodes'];
        if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
            out.maxNodes = max;
        }
        return Object.freeze(out);
    };
    const reactTreeHandler = (env) => {
        const options = readReactTreeInput(env.payload);
        return serializeTree(document, options);
    };
    const readReactGetStateInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const stableId = r['stable_id'];
        if (typeof stableId !== 'string' || stableId.length === 0)
            return null;
        const rootIdx = r['root_index'];
        const rootIndex = typeof rootIdx === 'number' && Number.isInteger(rootIdx) && rootIdx >= 0
            ? rootIdx
            : 0;
        const options = {};
        if (typeof r['include_props'] === 'boolean')
            options.includeProps = r['include_props'];
        if (typeof r['include_hooks'] === 'boolean')
            options.includeHooks = r['include_hooks'];
        return Object.freeze({ stableId, rootIndex, options: Object.freeze(options) });
    };
    const reactGetStateHandler = (env) => {
        const input = readReactGetStateInput(env.payload);
        if (input === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: 'react_get_state: payload must be { stable_id: non-empty string, root_index?: number, include_props?: bool, include_hooks?: bool }',
                }),
            });
        }
        const roots = findReactRoots(document);
        const fiber = resolveStableId$1(input.stableId, roots);
        if (fiber === undefined) {
            return Object.freeze({
                error: Object.freeze({
                    message: `react_get_state: stable_id "${input.stableId}" did not resolve. Re-call react.tree to refresh ids (the tree shape may have changed) or verify root_index matches the root used when the id was computed.`,
                }),
            });
        }
        return serializeComponent(fiber, input.rootIndex, input.options);
    };
    const readReactFindByTextInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const pattern = r['pattern'];
        if (typeof pattern !== 'string' || pattern.length === 0)
            return null;
        const out = { pattern, exact: r['exact'] === true };
        const rootIdx = r['root_index'];
        if (typeof rootIdx === 'number' && Number.isInteger(rootIdx) && rootIdx >= 0) {
            out.rootIndex = rootIdx;
        }
        const max = r['max_matches'];
        if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
            out.maxMatches = max;
        }
        return Object.freeze(out);
    };
    // Reuses the generic { error: { message } } shape exported as
    // ReactGetStateErrorPayload — tool-level errors are wire-successful by
    // convention (mirrors reactGetStateHandler).
    const reactFindByTextHandler = (env) => {
        const input = readReactFindByTextInput(env.payload);
        if (input === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: 'react_find_by_text: payload must be { pattern: non-empty string, exact?: bool, root_index?: number, max_matches?: number }',
                }),
            });
        }
        let regex;
        try {
            regex = new RegExp(input.pattern);
        }
        catch (err) {
            return Object.freeze({
                error: Object.freeze({
                    message: `react_find_by_text: invalid regex pattern: ${err.message}`,
                }),
            });
        }
        return findByText(document, regex, {
            exact: input.exact,
            ...(input.rootIndex !== undefined ? { rootIndex: input.rootIndex } : {}),
            ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
        });
    };
    const readReactFindByRoleInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const role = r['role'];
        if (typeof role !== 'string' || role.length === 0)
            return null;
        const out = { role };
        if (typeof r['name'] === 'string' && r['name'].length > 0) {
            out.name = r['name'];
        }
        const rootIdx = r['root_index'];
        if (typeof rootIdx === 'number' && Number.isInteger(rootIdx) && rootIdx >= 0) {
            out.rootIndex = rootIdx;
        }
        const max = r['max_matches'];
        if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
            out.maxMatches = max;
        }
        return Object.freeze(out);
    };
    // Reuses the generic { error: { message } } shape (ReactGetStateErrorPayload);
    // tool-level errors are wire-successful by convention.
    const reactFindByRoleHandler = (env) => {
        const input = readReactFindByRoleInput(env.payload);
        if (input === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: 'react_find_by_role: payload must be { role: non-empty string, name?: string, root_index?: number, max_matches?: number }',
                }),
            });
        }
        let nameRe;
        if (input.name !== undefined) {
            try {
                nameRe = new RegExp(input.name);
            }
            catch (err) {
                return Object.freeze({
                    error: Object.freeze({
                        message: `react_find_by_role: invalid name regex: ${err.message}`,
                    }),
                });
            }
        }
        return findByRole(document, input.role, nameRe, {
            ...(input.rootIndex !== undefined ? { rootIndex: input.rootIndex } : {}),
            ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
        });
    };
    // ── Vue introspection (Path 5 M39) — parity with react_tree/react_get_state ──
    const readVueTreeInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return Object.freeze({});
        const r = raw;
        const out = {};
        const rootIdx = r['root_index'];
        if (typeof rootIdx === 'number' && Number.isInteger(rootIdx) && rootIdx >= 0) {
            out.rootIndex = rootIdx;
        }
        const depth = r['depth_limit'];
        if (typeof depth === 'number' && Number.isInteger(depth) && depth > 0) {
            out.depthLimit = depth;
        }
        const max = r['max_nodes'];
        if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
            out.maxNodes = max;
        }
        return Object.freeze(out);
    };
    const vueTreeHandler = (env) => serializeVueTree(document, readVueTreeInput(env.payload));
    const readVueGetStateInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const stableId = r['stable_id'];
        if (typeof stableId !== 'string' || stableId.length === 0)
            return null;
        const options = {};
        if (typeof r['include_props'] === 'boolean')
            options.includeProps = r['include_props'];
        if (typeof r['include_state'] === 'boolean')
            options.includeState = r['include_state'];
        return Object.freeze({ stableId, options: Object.freeze(options) });
    };
    // Reuses the generic { error: { message } } shape (ReactGetStateErrorPayload);
    // tool-level errors are wire-successful by convention. The Vue stable id encodes
    // its own root segment (root{i}/…), so resolveVueStableId needs no root_index.
    const vueGetStateHandler = (env) => {
        const input = readVueGetStateInput(env.payload);
        if (input === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: 'vue_get_state: payload must be { stable_id: non-empty string, include_props?: bool, include_state?: bool }',
                }),
            });
        }
        const roots = findVueRoots(document);
        const instance = resolveStableId(input.stableId, roots);
        if (instance === undefined) {
            return Object.freeze({
                error: Object.freeze({
                    message: `vue_get_state: stable_id "${input.stableId}" did not resolve. Re-call vue_tree to refresh ids (the component tree may have changed).`,
                }),
            });
        }
        return serializeVueComponent(instance, 0, input.options);
    };
    const readVueFindByTextInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const pattern = r['pattern'];
        if (typeof pattern !== 'string' || pattern.length === 0)
            return null;
        const out = { pattern, exact: r['exact'] === true };
        const rootIdx = r['root_index'];
        if (typeof rootIdx === 'number' && Number.isInteger(rootIdx) && rootIdx >= 0) {
            out.rootIndex = rootIdx;
        }
        const max = r['max_matches'];
        if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
            out.maxMatches = max;
        }
        return Object.freeze(out);
    };
    const vueFindByTextHandler = (env) => {
        const input = readVueFindByTextInput(env.payload);
        if (input === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: 'vue_find_by_text: payload must be { pattern: non-empty string, exact?: bool, root_index?: number, max_matches?: number }',
                }),
            });
        }
        let regex;
        try {
            regex = new RegExp(input.pattern);
        }
        catch (err) {
            return Object.freeze({
                error: Object.freeze({
                    message: `vue_find_by_text: invalid regex pattern: ${err.message}`,
                }),
            });
        }
        return findVueByText(document, regex, {
            exact: input.exact,
            ...(input.rootIndex !== undefined ? { rootIndex: input.rootIndex } : {}),
            ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
        });
    };
    const readVueFindByRoleInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const role = r['role'];
        if (typeof role !== 'string' || role.length === 0)
            return null;
        const out = { role };
        if (typeof r['name'] === 'string' && r['name'].length > 0) {
            out.name = r['name'];
        }
        const rootIdx = r['root_index'];
        if (typeof rootIdx === 'number' && Number.isInteger(rootIdx) && rootIdx >= 0) {
            out.rootIndex = rootIdx;
        }
        const max = r['max_matches'];
        if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
            out.maxMatches = max;
        }
        return Object.freeze(out);
    };
    const vueFindByRoleHandler = (env) => {
        const input = readVueFindByRoleInput(env.payload);
        if (input === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: 'vue_find_by_role: payload must be { role: non-empty string, name?: string, root_index?: number, max_matches?: number }',
                }),
            });
        }
        let nameRe;
        if (input.name !== undefined) {
            try {
                nameRe = new RegExp(input.name);
            }
            catch (err) {
                return Object.freeze({
                    error: Object.freeze({
                        message: `vue_find_by_role: invalid name regex: ${err.message}`,
                    }),
                });
            }
        }
        return findVueByRole(document, input.role, nameRe, {
            ...(input.rootIndex !== undefined ? { rootIndex: input.rootIndex } : {}),
            ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
        });
    };
    const svelteComponentsHandler = () => {
        const detection = detectSvelte(window, document);
        return Object.freeze({
            present: detection.present,
            dev: detection.dev,
            metaElementCount: detection.metaElementCount,
            components: discoverSvelteComponents(document),
            scopeUrl: window.location.href,
        });
    };
    const readSvelteFindByTextInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const pattern = r['pattern'];
        if (typeof pattern !== 'string' || pattern.length === 0)
            return null;
        const out = {
            pattern,
            exact: r['exact'] === true,
        };
        const max = r['max_matches'];
        if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
            out.maxMatches = max;
        }
        return Object.freeze(out);
    };
    const svelteFindByTextHandler = (env) => {
        const input = readSvelteFindByTextInput(env.payload);
        if (input === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: 'svelte_find_by_text: payload must be { pattern: non-empty string, exact?: bool, max_matches?: number }',
                }),
            });
        }
        let regex;
        try {
            regex = new RegExp(input.pattern);
        }
        catch (err) {
            return Object.freeze({
                error: Object.freeze({
                    message: `svelte_find_by_text: invalid regex pattern: ${err.message}`,
                }),
            });
        }
        return findSvelteByText(document, regex, {
            exact: input.exact,
            ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
        });
    };
    const readSvelteFindByRoleInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const role = r['role'];
        if (typeof role !== 'string' || role.length === 0)
            return null;
        const out = { role };
        if (typeof r['name'] === 'string' && r['name'].length > 0)
            out.name = r['name'];
        const max = r['max_matches'];
        if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
            out.maxMatches = max;
        }
        return Object.freeze(out);
    };
    const svelteFindByRoleHandler = (env) => {
        const input = readSvelteFindByRoleInput(env.payload);
        if (input === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: 'svelte_find_by_role: payload must be { role: non-empty string, name?: string, max_matches?: number }',
                }),
            });
        }
        let nameRe;
        if (input.name !== undefined) {
            try {
                nameRe = new RegExp(input.name);
            }
            catch (err) {
                return Object.freeze({
                    error: Object.freeze({
                        message: `svelte_find_by_role: invalid name regex: ${err.message}`,
                    }),
                });
            }
        }
        return findSvelteByRole(document, input.role, nameRe, {
            ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
        });
    };
    const solidDetectHandler = () => {
        const detection = detectSolid(window, document);
        return Object.freeze({ ...detection, scopeUrl: window.location.href });
    };
    const readSolidFindByTextInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const pattern = r['pattern'];
        if (typeof pattern !== 'string' || pattern.length === 0)
            return null;
        const out = {
            pattern,
            exact: r['exact'] === true,
        };
        const max = r['max_matches'];
        if (typeof max === 'number' && Number.isInteger(max) && max > 0)
            out.maxMatches = max;
        return Object.freeze(out);
    };
    const solidFindByTextHandler = (env) => {
        const input = readSolidFindByTextInput(env.payload);
        if (input === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: 'solid_find_by_text: payload must be { pattern: non-empty string, exact?: bool, max_matches?: number }',
                }),
            });
        }
        let regex;
        try {
            regex = new RegExp(input.pattern);
        }
        catch (err) {
            return Object.freeze({
                error: Object.freeze({
                    message: `solid_find_by_text: invalid regex pattern: ${err.message}`,
                }),
            });
        }
        return findSolidByText(document, regex, {
            exact: input.exact,
            ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
        });
    };
    const readSolidFindByRoleInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const role = r['role'];
        if (typeof role !== 'string' || role.length === 0)
            return null;
        const out = { role };
        if (typeof r['name'] === 'string' && r['name'].length > 0)
            out.name = r['name'];
        const max = r['max_matches'];
        if (typeof max === 'number' && Number.isInteger(max) && max > 0)
            out.maxMatches = max;
        return Object.freeze(out);
    };
    const solidFindByRoleHandler = (env) => {
        const input = readSolidFindByRoleInput(env.payload);
        if (input === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: 'solid_find_by_role: payload must be { role: non-empty string, name?: string, max_matches?: number }',
                }),
            });
        }
        let nameRe;
        if (input.name !== undefined) {
            try {
                nameRe = new RegExp(input.name);
            }
            catch (err) {
                return Object.freeze({
                    error: Object.freeze({
                        message: `solid_find_by_role: invalid name regex: ${err.message}`,
                    }),
                });
            }
        }
        return findSolidByRole(document, input.role, nameRe, {
            ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
        });
    };
    const readReduxGetStateInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return {};
        const r = raw;
        const out = {};
        const path = r['path'];
        if (typeof path === 'string' && path.length > 0)
            out.path = path;
        const framework = r['framework'];
        if (typeof framework === 'string' && framework.length > 0) {
            out.framework = framework;
        }
        return Object.freeze(out);
    };
    /**
     * Actionable "no store detected" guidance, tailored per framework so a caller
     * who passed framework:'zustand' is told the real enablement path rather than a
     * Redux-centric message. Shared by every store handler's not-found branch. The
     * host MCP layer prepends the tool name, so these messages carry no prefix.
     *
     * There is no Chrome-DevTools / chrome-devtools-mcp fallback for store state —
     * CDP cannot read app-internal store state, so these tools are the only source.
     * The guidance points at the actual capture seams (auto-detect or handoff).
     */
    const noStoreMessage = (framework) => {
        switch (framework) {
            case 'zustand':
                return `no Zustand store detected. Zero-config capture requires the store to use zustand's devtools() middleware (a Zustand store has no global or React-fiber handle, so there is no passive way to find one otherwise). If it does not use devtools(), expose the vanilla store via window.__pwaDebug_zustand = store for full read/subscribe/dispatch access.`;
            case 'redux':
                return `no Redux store detected. react-redux stores are auto-discovered from the React fiber tree; otherwise expose the store via window.__pwaDebug_redux = store.`;
            case 'pinia':
                return `no Pinia store detected. Pinia stores are auto-discovered from the live Vue app; otherwise expose a store via window.__pwaDebug_pinia.`;
            case 'jotai':
                return `no Jotai store resolved. The store is auto-discovered off the React <Provider store> context, but jotai >=2.12 removed the atom-enumeration API, so atom NAMES cannot be read from a bare store — expose them via window.__pwaDebug_jotai = { store, atoms } (the atom set is visible in your source, e.g. the module that calls atom()). On jotai 2.0–2.11 the atoms auto-enumerate with no handoff.`;
            default:
                return `no store detected. Rely on auto-detection (react-redux fiber discovery, Pinia Vue-app discovery, or Zustand devtools() middleware), or expose the store via a framework handoff (window.__pwaDebug_redux / __pwaDebug_zustand / __pwaDebug_pinia / __pwaDebug_jotai).`;
        }
    };
    const reduxGetStateHandler = (env) => {
        const input = readReduxGetStateInput(env.payload);
        const detected = resolveStore(input.framework);
        if (detected === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: noStoreMessage(input.framework),
                }),
            });
        }
        const store = detected.handle;
        const state = store.getState();
        const picked = getValueAtPath(state, input.path);
        if (!picked.ok) {
            return Object.freeze({
                error: Object.freeze({
                    message: `redux_get_state: path "${input.path ?? ''}" invalid: ${picked.error}`,
                }),
            });
        }
        const serialized = serializeStoreValue(picked.value);
        const out = {
            framework: detected.framework,
            state: serialized.value,
            scopeUrl: window.location.href,
        };
        if (input.path !== undefined)
            out.path = input.path;
        if (serialized.truncated)
            out.truncated = true;
        return Object.freeze(out);
    };
    const readReduxSubscribeInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const action = r['action'];
        if (action !== 'start' && action !== 'stop')
            return null;
        const path = r['path'];
        if (path !== undefined && (typeof path !== 'string' || path.length === 0)) {
            return null;
        }
        const framework = r['framework'];
        if (framework !== undefined &&
            (typeof framework !== 'string' || framework.length === 0)) {
            return null;
        }
        const out = {
            action,
        };
        if (path !== undefined)
            out.path = path;
        if (framework !== undefined)
            out.framework = framework;
        return Object.freeze(out);
    };
    // Module-singleton: tracks the active store_change subscription's disposer.
    // The page-world bootstrap owns the captures emit path through encodeEvent +
    // window.postMessage; reduxSubscribeHandler reuses it so emits flow through
    // the normal CS → SW → host buffer pipeline.
    let subscriptionDisposer = null;
    const emitToPage = (event) => {
        window.postMessage(encodeEvent(event), window.location.origin);
    };
    const reduxSubscribeHandler = (env) => {
        const input = readReduxSubscribeInput(env.payload);
        if (input === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: "redux_subscribe: payload must be { action: 'start' | 'stop', path?: non-empty string }",
                }),
            });
        }
        if (input.action === 'stop') {
            if (subscriptionDisposer !== null) {
                subscriptionDisposer();
                subscriptionDisposer = null;
            }
            return Object.freeze({
                active: false,
                scopeUrl: window.location.href,
            });
        }
        const detected = resolveStore(input.framework);
        if (detected === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: noStoreMessage(input.framework),
                }),
            });
        }
        const store = detected.handle;
        // Validate path eagerly so misuse fails at start, not silently later.
        if (input.path !== undefined) {
            const probe = getValueAtPath(store.getState(), input.path);
            if (!probe.ok) {
                return Object.freeze({
                    error: Object.freeze({
                        message: `redux_subscribe: path "${input.path}" invalid: ${probe.error}`,
                    }),
                });
            }
        }
        // Tear down any prior subscription before installing the new one.
        if (subscriptionDisposer !== null) {
            subscriptionDisposer();
            subscriptionDisposer = null;
        }
        subscriptionDisposer = installStoreSubscription({
            store,
            emit: (e) => emitToPage(e),
            frame: computeFrameMeta(),
            framework: detected.framework,
            ...(input.path !== undefined ? { path: input.path } : {}),
        });
        const out = { active: true, framework: detected.framework, scopeUrl: window.location.href };
        if (input.path !== undefined)
            out.path = input.path;
        return Object.freeze(out);
    };
    const readReduxDispatchInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const action = r['action'];
        if (action === null || typeof action !== 'object')
            return null;
        const a = action;
        const type = a['type'];
        if (typeof type !== 'string' || type.length === 0)
            return null;
        const out = { type };
        if ('payload' in a)
            out.payload = a['payload'];
        return Object.freeze(out);
    };
    const reduxDispatchHandler = (env) => {
        const action = readReduxDispatchInput(env.payload);
        if (action === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: 'redux_dispatch: payload must be { action: { type: non-empty string; payload? } }',
                }),
            });
        }
        const rawFramework = env.payload !== null && typeof env.payload === 'object'
            ? env.payload['framework']
            : undefined;
        const framework = typeof rawFramework === 'string' && rawFramework.length > 0
            ? rawFramework
            : undefined;
        const detected = resolveStore(framework);
        if (detected === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: noStoreMessage(framework),
                }),
            });
        }
        const store = detected.handle;
        if (typeof store.dispatch !== 'function') {
            return Object.freeze({
                error: Object.freeze({
                    message: 'redux_dispatch: detected store does not expose a dispatch() method.',
                }),
            });
        }
        try {
            store.dispatch(action);
        }
        catch (err) {
            return Object.freeze({
                error: Object.freeze({
                    message: `redux_dispatch: store.dispatch threw: ${err.message}`,
                }),
            });
        }
        return Object.freeze({
            dispatched: true,
            framework: detected.framework,
            action,
            scopeUrl: window.location.href,
        });
    };
    const readSourceMapResolveInput = (raw) => {
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
        return Object.freeze({ scriptUrl, line, column });
    };
    let sourcemapCache = null;
    const getSourcemapCache = () => {
        if (sourcemapCache === null) {
            sourcemapCache = createSourcemapCache();
        }
        return sourcemapCache;
    };
    const sourceMapResolveHandler = async (env) => {
        const input = readSourceMapResolveInput(env.payload);
        if (input === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: 'source_map_resolve: payload must be { script_url: non-empty string, line: int >= 1, column: int >= 0 }',
                }),
            });
        }
        let scriptText;
        try {
            const res = await fetch(input.scriptUrl);
            if (!res.ok) {
                return Object.freeze({
                    error: Object.freeze({
                        message: `source_map_resolve: script fetch returned ${res.status}`,
                    }),
                });
            }
            scriptText = await res.text();
        }
        catch (err) {
            return Object.freeze({
                error: Object.freeze({
                    message: `source_map_resolve: script fetch failed: ${err.message}`,
                }),
            });
        }
        const mapUrl = discoverSourceMapUrl(input.scriptUrl, scriptText);
        if (mapUrl === null) {
            return Object.freeze({
                scopeUrl: window.location.href,
            });
        }
        const cache = getSourcemapCache();
        const parsed = await cache.get(mapUrl);
        if (parsed === null) {
            return Object.freeze({
                scopeUrl: window.location.href,
            });
        }
        const original = resolveLocation(parsed, input.line, input.column);
        const out = {
            scopeUrl: window.location.href,
        };
        if (original !== null)
            out.original = original;
        return Object.freeze(out);
    };
    const readSessionRecordInput = (raw) => {
        if (raw === null || typeof raw !== 'object')
            return null;
        const r = raw;
        const action = r['action'];
        if (action !== 'start' && action !== 'stop')
            return null;
        const out = {
            action,
        };
        const sid = r['session_id'];
        if (sid !== undefined) {
            if (typeof sid !== 'string' || sid.length === 0)
                return null;
            out.sessionId = sid;
        }
        const cap = r['duration_cap_ms'];
        if (cap !== undefined) {
            if (typeof cap !== 'number' || !Number.isInteger(cap) || cap <= 0)
                return null;
            out.durationCapMs = cap;
        }
        return Object.freeze(out);
    };
    const sessionRecordHandler = (env) => {
        const input = readSessionRecordInput(env.payload);
        if (input === null) {
            return Object.freeze({
                error: Object.freeze({
                    message: "session_record: payload must be { action: 'start' | 'stop', session_id?: non-empty string, duration_cap_ms?: int > 0 }",
                }),
            });
        }
        if (input.action === 'stop') {
            const sid = stopRecording();
            const out = {
                active: false,
                scopeUrl: window.location.href,
            };
            if (sid !== null)
                out.sessionId = sid;
            return Object.freeze(out);
        }
        const sessionId = input.sessionId ?? safeRandomId();
        const frame = computeFrameMeta();
        startRecording({
            emit: (e) => window.postMessage(encodeEvent(e), window.location.origin),
            frame,
            sessionId,
            ...(input.durationCapMs !== undefined ? { durationCapMs: input.durationCapMs } : {}),
        });
        const out = {
            active: true,
            sessionId: getActiveSessionId() ?? sessionId,
            scopeUrl: window.location.href,
        };
        const dur = getActiveDurationCapMs();
        if (dur !== undefined)
            out.durationCapMs = dur;
        return Object.freeze(out);
    };
    // sw_status (PWA Runtime Diagnostics): read the DEBUGGED PWA's service-worker
    // registrations + controller and project them to a wire SwStatusSnapshot. This
    // is the app's navigator.serviceWorker — distinct from the extension's own
    // sw_lifecycle module. Feature-detected so insecure/unsupported contexts return
    // a { supported: false } snapshot rather than throwing.
    const swStatusHandler = async () => {
        const container = navigator.serviceWorker;
        if (container === undefined ||
            typeof container.getRegistrations !== 'function') {
            return projectServiceWorkerState([], null, false);
        }
        const registrations = await container.getRegistrations();
        return projectServiceWorkerState(registrations, container.controller, true);
    };
    // cache_* (PWA Runtime Diagnostics): read the debugged PWA's CacheStorage. The
    // readers take an injected CacheStorage; here we pass the live `caches` global
    // (feature-detected → readers return supported:false when absent).
    const getCacheStorage = () => typeof caches !== 'undefined' ? caches : null;
    const DEFAULT_CACHE_INSPECT_LIMIT = 200;
    const cacheListHandler = () => readCacheList(getCacheStorage());
    const cacheInspectHandler = (env) => {
        const r = env.payload !== null && typeof env.payload === 'object'
            ? env.payload
            : {};
        const name = r['cache_name'];
        if (typeof name !== 'string' || name.length === 0) {
            return Promise.resolve({
                error: { message: 'cache_inspect: payload must include { cache_name: non-empty string }' },
            });
        }
        const limit = typeof r['limit'] === 'number' &&
            Number.isInteger(r['limit']) &&
            r['limit'] > 0
            ? r['limit']
            : DEFAULT_CACHE_INSPECT_LIMIT;
        return readCacheInspect(getCacheStorage(), name, limit, Date.now());
    };
    const cacheMatchHandler = (env) => {
        const r = env.payload !== null && typeof env.payload === 'object'
            ? env.payload
            : {};
        const url = r['url'];
        if (typeof url !== 'string' || url.length === 0) {
            return Promise.resolve({
                error: { message: 'cache_match: payload must include { url: non-empty string }' },
            });
        }
        return readCacheMatch(getCacheStorage(), url, Date.now());
    };
    // pwa_status (PWA Runtime Diagnostics): runtime status + capability matrix of
    // the debugged PWA, read from the live window + navigator.
    const pwaStatusHandler = () => readPwaStatus(window, navigator);
    // pwa_installability: discover + fetch + parse the manifest from the live page
    // and run the installability rules.
    const pwaInstallabilityHandler = async () => {
        const link = document.querySelector('link[rel="manifest"]');
        const manifestHref = link?.getAttribute('href') ?? null;
        const swContainer = navigator.serviceWorker;
        let hasServiceWorker = false;
        if (swContainer !== undefined) {
            if (swContainer.controller !== null) {
                hasServiceWorker = true;
            }
            else if (typeof swContainer.getRegistration === 'function') {
                try {
                    hasServiceWorker = (await swContainer.getRegistration()) !== undefined;
                }
                catch {
                    hasServiceWorker = false;
                }
            }
        }
        return readInstallability({
            manifestHref,
            baseUrl: document.baseURI,
            secureContext: window.isSecureContext === true,
            hasServiceWorker,
            fetchText: async (url) => {
                const res = await fetch(url);
                return { ok: res.ok, status: res.status, text: await res.text() };
            },
        });
    };
    // storage_get (PWA Runtime Diagnostics T2): snapshot the debugged PWA's
    // localStorage / sessionStorage. Feature-detected — a blocked/absent area yields
    // supported:false rather than throwing.
    const DEFAULT_STORAGE_LIMIT = 500;
    const getWebStorage = (area) => {
        try {
            const s = area === 'session' ? window.sessionStorage : window.localStorage;
            return s ?? null;
        }
        catch {
            // Access can throw when storage is disabled (e.g. third-party / blocked).
            return null;
        }
    };
    const storageGetHandler = (env) => {
        const r = env.payload !== null && typeof env.payload === 'object'
            ? env.payload
            : {};
        const rawArea = r['area'];
        const area = rawArea === 'session' ? 'session' : 'local';
        const limit = typeof r['limit'] === 'number' &&
            Number.isInteger(r['limit']) &&
            r['limit'] > 0
            ? r['limit']
            : DEFAULT_STORAGE_LIMIT;
        return readWebStorage(getWebStorage(area), area, limit);
    };
    // idb_list / idb_query (PWA Runtime Diagnostics T2): read the debugged PWA's
    // IndexedDB. The readers take an injected IDBFactory-like; here we pass the live
    // `indexedDB` global (feature-detected → readers return supported:false when
    // absent). The real IDBFactory satisfies the structural IdbFactoryLike subset.
    const DEFAULT_IDB_QUERY_LIMIT = 100;
    const getIdbFactory = () => {
        try {
            return typeof indexedDB !== 'undefined'
                ? indexedDB
                : null;
        }
        catch {
            return null;
        }
    };
    const idbListHandler = () => readIdbList(getIdbFactory());
    const idbQueryHandler = (env) => {
        const r = env.payload !== null && typeof env.payload === 'object'
            ? env.payload
            : {};
        const db = r['db'];
        if (typeof db !== 'string' || db.length === 0) {
            return Promise.resolve({
                error: { message: 'idb_query: payload must include { db: non-empty string }' },
            });
        }
        const store = r['store'];
        if (typeof store !== 'string' || store.length === 0) {
            return Promise.resolve({
                error: { message: 'idb_query: payload must include { store: non-empty string }' },
            });
        }
        const limit = typeof r['limit'] === 'number' &&
            Number.isInteger(r['limit']) &&
            r['limit'] > 0
            ? r['limit']
            : DEFAULT_IDB_QUERY_LIMIT;
        return readIdbQuery(getIdbFactory(), db, store, limit);
    };
    // pwa_update_gather (PWA Runtime Diagnostics T3): collect the page-side inputs
    // (SW snapshot + every cache's entries) the host pwa_update_analyze tool needs
    // in one IPC round-trip. Composition over swStatusHandler + the cache readers.
    const DEFAULT_GATHER_PER_CACHE_LIMIT = 100;
    const pwaUpdateGatherHandler = (env) => {
        const r = env.payload !== null && typeof env.payload === 'object'
            ? env.payload
            : {};
        const perCacheLimit = typeof r['per_cache_limit'] === 'number' &&
            Number.isInteger(r['per_cache_limit']) &&
            r['per_cache_limit'] > 0
            ? r['per_cache_limit']
            : DEFAULT_GATHER_PER_CACHE_LIMIT;
        return gatherUpdateInputs({
            readSw: () => swStatusHandler(),
            readCacheList: () => readCacheList(getCacheStorage()),
            readCacheInspect: (name, limit) => readCacheInspect(getCacheStorage(), name, limit, Date.now()),
        }, perCacheLimit);
    };
    // pwa_snapshot (PWA Runtime Diagnostics T3): capture ONE runtime-state blob by
    // composing the existing page-world readers. Pure composition over swStatusHandler
    // + the store/storage/idb/cache readers; no new capture surface.
    const STORAGE_SNAPSHOT_LIMIT = 500;
    // The detected store's full state (no path), framework-tagged + value-capped via
    // the shared serializer; null when no store is discovered. Composes resolveStore
    // + serializeStoreValue (the same passive discovery the store_* tools use).
    const readSnapshotStore = () => {
        const detected = resolveStore();
        if (detected === null)
            return null;
        const serialized = serializeStoreValue(detected.handle.getState());
        return serialized.truncated
            ? { framework: detected.framework, state: serialized.value, truncated: true }
            : { framework: detected.framework, state: serialized.value };
    };
    const pwaSnapshotGatherHandler = () => gatherRuntimeSnapshot({
        readMeta: () => ({
            url: window.location.href,
            title: document.title,
            capturedAt: Date.now(),
        }),
        readSw: () => swStatusHandler(),
        readStore: () => readSnapshotStore(),
        readWebStorage: (area) => readWebStorage(getWebStorage(area), area, STORAGE_SNAPSHOT_LIMIT),
        readIdbList: () => readIdbList(getIdbFactory()),
        readCacheList: () => readCacheList(getCacheStorage()),
    });
    // Path 7 interaction action tools (pdl_*): one handler per ACTION_TOOL_SPECS
    // entry, each bound to its action kind — resolve the locator, apply the action.
    const actionPageHandlers = Object.freeze(Object.fromEntries(ACTION_TOOL_SPECS.map((s) => [
        s.tool,
        (env) => {
            const input = readActionInput(env.payload);
            if (input === null) {
                return { error: { message: `${s.tool}: payload must include a locator` } };
            }
            return runAction(document, s.action, input.locator, input.params);
        },
    ])));
    const HANDLERS = Object.freeze({
        ...actionPageHandlers,
        session_ping: () => sessionPingHandler(),
        evaluate: (env) => evaluateHandler(env),
        react_tree: (env) => reactTreeHandler(env),
        react_get_state: (env) => reactGetStateHandler(env),
        react_find_by_text: (env) => reactFindByTextHandler(env),
        react_find_by_role: (env) => reactFindByRoleHandler(env),
        vue_tree: (env) => vueTreeHandler(env),
        vue_get_state: (env) => vueGetStateHandler(env),
        vue_find_by_text: (env) => vueFindByTextHandler(env),
        vue_find_by_role: (env) => vueFindByRoleHandler(env),
        svelte_components: () => svelteComponentsHandler(),
        svelte_find_by_text: (env) => svelteFindByTextHandler(env),
        svelte_find_by_role: (env) => svelteFindByRoleHandler(env),
        solid_detect: () => solidDetectHandler(),
        solid_find_by_text: (env) => solidFindByTextHandler(env),
        solid_find_by_role: (env) => solidFindByRoleHandler(env),
        redux_get_state: (env) => reduxGetStateHandler(env),
        redux_subscribe: (env) => reduxSubscribeHandler(env),
        redux_dispatch: (env) => reduxDispatchHandler(env),
        // Unified store_* family (Path 4 M2). Same framework-agnostic handlers as
        // redux_* — the framework arg in the payload selects an adapter, or the
        // registry auto-detects. redux_* kept as deprecated aliases.
        store_get_state: (env) => reduxGetStateHandler(env),
        store_subscribe: (env) => reduxSubscribeHandler(env),
        store_dispatch: (env) => reduxDispatchHandler(env),
        source_map_resolve: (env) => sourceMapResolveHandler(env),
        session_record: (env) => sessionRecordHandler(env),
        sw_status: () => swStatusHandler(),
        cache_list: () => cacheListHandler(),
        cache_inspect: (env) => cacheInspectHandler(env),
        cache_match: (env) => cacheMatchHandler(env),
        pwa_status: () => pwaStatusHandler(),
        pwa_installability: () => pwaInstallabilityHandler(),
        storage_get: (env) => storageGetHandler(env),
        idb_list: () => idbListHandler(),
        idb_query: (env) => idbQueryHandler(env),
        pwa_update_gather: (env) => pwaUpdateGatherHandler(env),
        pwa_snapshot_gather: () => pwaSnapshotGatherHandler(),
    });
    const dispatchPageRequest = async (req) => {
        const handler = HANDLERS[req.tool];
        if (!handler) {
            return encodeResponse({
                requestId: req.requestId,
                error: { message: `unknown tool: ${req.tool}` },
            });
        }
        try {
            const payload = await handler(req);
            return encodeResponse({ requestId: req.requestId, payload });
        }
        catch (err) {
            return encodeResponse({
                requestId: req.requestId,
                error: { message: err.message },
            });
        }
    };

    const INTERNAL_LOG_PREFIX = '[pwa-debug/';
    const EXTENSION_FRAME_RE = /^\s*at .*chrome-extension:\/\//;
    const isInternalLog = (args) => {
        if (args.length === 0)
            return false;
        const first = args[0];
        return typeof first === 'string' && first.startsWith(INTERNAL_LOG_PREFIX);
    };
    const stripExtensionFrames = (stack) => {
        const lines = stack.split('\n');
        const headerSkipped = lines.slice(1);
        let firstUserIdx = -1;
        for (let i = 0; i < headerSkipped.length; i++) {
            const line = headerSkipped[i];
            if (!EXTENSION_FRAME_RE.test(line)) {
                firstUserIdx = i;
                break;
            }
        }
        if (firstUserIdx === -1)
            return headerSkipped.join('\n');
        return headerSkipped.slice(firstUserIdx).join('\n');
    };

    const ALL_LEVELS = [
        'log',
        'info',
        'warn',
        'error',
        'debug',
        'trace',
    ];
    const DEFAULT_STACK_LEVELS = ['warn', 'error', 'trace'];
    const captureStack = () => {
        const stack = new Error().stack;
        if (stack === undefined)
            return undefined;
        return stripExtensionFrames(stack);
    };
    const buildConsoleEvent = (level, args, frame, opts) => {
        const { serialized } = serializeArgs$1(args, opts.maxBytes === undefined ? undefined : { maxBytes: opts.maxBytes });
        const wantStack = opts.captureStackFor.includes(level);
        const stack = wantStack ? captureStack() : undefined;
        const base = {
            kind: 'console',
            ts: opts.ts,
            frameUrl: frame.frameUrl,
            frameKey: frame.frameKey,
            ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
            level,
            args: serialized,
        };
        return Object.freeze(stack === undefined ? base : { ...base, stack });
    };
    const installConsoleCapture = (emit, frame, opts) => {
        const captureStackFor = DEFAULT_STACK_LEVELS;
        const maxBytes = opts?.maxBytes;
        const now = (() => Date.now());
        const originals = new Map();
        for (const level of ALL_LEVELS) {
            const original = console[level];
            if (typeof original !== 'function')
                continue;
            originals.set(level, original);
            console[level] = ((...args) => {
                try {
                    original.apply(console, args);
                }
                finally {
                    if (isInternalLog(args))
                        return;
                    try {
                        const opts = maxBytes === undefined
                            ? { ts: now(), captureStackFor }
                            : { ts: now(), maxBytes, captureStackFor };
                        emit(buildConsoleEvent(level, args, frame, opts));
                    }
                    catch {
                        // Capture failure must never break the page's console call.
                    }
                }
            });
        }
        let disposed = false;
        return () => {
            if (disposed)
                return;
            disposed = true;
            for (const [level, original] of originals) {
                console[level] = original;
            }
        };
    };

    const DEFAULT_RESPONSE_BODY_TIMEOUT_MS = 1000;
    const defaultIdGen$2 = () => safeRandomId('f_');
    const headersToRecord = (source) => {
        if (source === undefined)
            return undefined;
        const out = {};
        if (typeof Headers !== 'undefined' && source instanceof Headers) {
            source.forEach((v, k) => {
                out[k] = v;
            });
            return out;
        }
        if (Array.isArray(source)) {
            for (const pair of source) {
                if (Array.isArray(pair) && pair.length >= 2) {
                    out[String(pair[0])] = String(pair[1]);
                }
            }
            return out;
        }
        if (typeof source === 'object') {
            for (const [k, v] of Object.entries(source)) {
                out[k] = String(v);
            }
            return out;
        }
        return undefined;
    };
    const tagBlob$1 = (b) => ({
        __type: 'Blob',
        size: b.size,
        type: b.type,
    });
    const tagArrayBuffer$1 = (buf) => ({
        __type: 'ArrayBuffer',
        byteLength: buf.byteLength,
    });
    const tagStream$1 = () => ({ __type: 'ReadableStream' });
    const tagFormData$1 = () => ({ __type: 'FormData' });
    const tagUrlParams$1 = (p) => ({
        __type: 'URLSearchParams',
        value: p.toString(),
    });
    const serializeRequestBody$1 = (body, maxBytes) => {
        if (body === null || body === undefined)
            return undefined;
        if (typeof body === 'string') {
            const opts = undefined ;
            return serializeArgs$1([body], opts).serialized[0];
        }
        if (typeof Blob !== 'undefined' && body instanceof Blob)
            return tagBlob$1(body);
        if (typeof URLSearchParams !== 'undefined' &&
            body instanceof URLSearchParams) {
            return tagUrlParams$1(body);
        }
        if (typeof FormData !== 'undefined' && body instanceof FormData) {
            return tagFormData$1();
        }
        if (body instanceof ArrayBuffer)
            return tagArrayBuffer$1(body);
        if (ArrayBuffer.isView(body))
            return tagArrayBuffer$1(body.buffer);
        if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
            return tagStream$1();
        }
        return tagStream$1();
    };
    const readResponseBody$1 = async (response, timeoutMs, maxBytes) => {
        let cloned;
        try {
            cloned = response.clone();
        }
        catch {
            return tagStream$1();
        }
        const text = cloned.text();
        const timer = new Promise((resolve) => {
            setTimeout(() => resolve(TIMEOUT), timeoutMs);
        });
        let result;
        try {
            result = await Promise.race([text, timer]);
        }
        catch {
            return tagStream$1();
        }
        if (result === TIMEOUT)
            return tagStream$1();
        const opts = undefined ;
        return serializeArgs$1([result], opts).serialized[0];
    };
    const TIMEOUT = Symbol('timeout');
    const resolveRequestParts = (input, init) => {
        if (typeof input === 'string') {
            return {
                method: init?.method ?? 'GET',
                url: input,
                headers: headersToRecord(init?.headers),
                body: init?.body,
            };
        }
        if (typeof URL !== 'undefined' && input instanceof URL) {
            return {
                method: init?.method ?? 'GET',
                url: input.toString(),
                headers: headersToRecord(init?.headers),
                body: init?.body,
            };
        }
        const req = input;
        return {
            method: init?.method ?? req.method ?? 'GET',
            url: req.url ?? '',
            headers: headersToRecord(init?.headers ?? req.headers),
            body: init?.body,
        };
    };
    const responseHeadersToRecord = (response) => {
        const out = {};
        response.headers.forEach((v, k) => {
            out[k] = v;
        });
        return out;
    };
    const installFetchCapture = (emit, frame, opts) => {
        const original = globalThis.fetch;
        if (typeof original !== 'function') {
            return () => { };
        }
        const now = (() => Date.now());
        const idGen = defaultIdGen$2;
        const maxBytes = opts?.maxBytes;
        const responseBodyTimeoutMs = DEFAULT_RESPONSE_BODY_TIMEOUT_MS;
        const tryEmit = (event) => {
            try {
                emit(event);
            }
            catch {
                // Capture failure must never break the page's fetch call.
            }
        };
        const wrapped = async (input, init) => {
            const captureId = idGen();
            const startTs = now();
            const parts = resolveRequestParts(input, init);
            let requestBody;
            try {
                requestBody = serializeRequestBody$1(parts.body, maxBytes);
            }
            catch {
                requestBody = undefined;
            }
            tryEmit(Object.freeze({
                kind: 'fetch',
                ts: startTs,
                frameUrl: frame.frameUrl,
                frameKey: frame.frameKey,
                ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
                phase: 'request',
                captureId,
                method: parts.method,
                url: parts.url,
                ...(parts.headers === undefined ? {} : { headers: parts.headers }),
                ...(requestBody === undefined ? {} : { body: requestBody }),
            }));
            try {
                const response = await original.call(globalThis, input, init);
                const endTs = now();
                let responseBody;
                try {
                    responseBody = await readResponseBody$1(response, responseBodyTimeoutMs, maxBytes);
                }
                catch {
                    responseBody = undefined;
                }
                tryEmit(Object.freeze({
                    kind: 'fetch',
                    ts: endTs,
                    frameUrl: frame.frameUrl,
                    frameKey: frame.frameKey,
                    ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
                    phase: 'response',
                    captureId,
                    method: parts.method,
                    url: parts.url,
                    status: response.status,
                    headers: responseHeadersToRecord(response),
                    ...(responseBody === undefined ? {} : { body: responseBody }),
                    durationMs: endTs - startTs,
                }));
                return response;
            }
            catch (err) {
                const endTs = now();
                const opts = undefined ;
                const serializedErr = serializeArgs$1([err], opts).serialized[0];
                tryEmit(Object.freeze({
                    kind: 'fetch',
                    ts: endTs,
                    frameUrl: frame.frameUrl,
                    frameKey: frame.frameKey,
                    ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
                    phase: 'error',
                    captureId,
                    method: parts.method,
                    url: parts.url,
                    body: serializedErr,
                    durationMs: endTs - startTs,
                }));
                throw err;
            }
        };
        globalThis.fetch = wrapped;
        let disposed = false;
        return () => {
            if (disposed)
                return;
            disposed = true;
            globalThis.fetch = original;
        };
    };

    const defaultIdGen$1 = () => safeRandomId('x_');
    const tagBlob = (b) => ({
        __type: 'Blob',
        size: b.size,
        type: b.type,
    });
    const tagArrayBuffer = (buf) => ({
        __type: 'ArrayBuffer',
        byteLength: buf.byteLength,
    });
    const tagStream = () => ({ __type: 'ReadableStream' });
    const tagFormData = () => ({ __type: 'FormData' });
    const tagUrlParams = (p) => ({
        __type: 'URLSearchParams',
        value: p.toString(),
    });
    const serializeRequestBody = (body, maxBytes) => {
        if (body === null || body === undefined)
            return undefined;
        if (typeof body === 'string') {
            const opts = undefined ;
            return serializeArgs$1([body], opts).serialized[0];
        }
        if (typeof Blob !== 'undefined' && body instanceof Blob)
            return tagBlob(body);
        if (typeof URLSearchParams !== 'undefined' &&
            body instanceof URLSearchParams) {
            return tagUrlParams(body);
        }
        if (typeof FormData !== 'undefined' && body instanceof FormData) {
            return tagFormData();
        }
        if (body instanceof ArrayBuffer)
            return tagArrayBuffer(body);
        if (ArrayBuffer.isView(body))
            return tagArrayBuffer(body.buffer);
        if (typeof Document !== 'undefined' && body instanceof Document) {
            return { __type: 'Document' };
        }
        return tagStream();
    };
    const readResponseBody = (xhr, maxBytes) => {
        const rt = xhr.responseType;
        try {
            if (rt === '' || rt === 'text') {
                const text = xhr.responseText ?? '';
                const opts = maxBytes === undefined ? undefined : { maxBytes };
                return serializeArgs$1([text], opts).serialized[0];
            }
            if (rt === 'json') {
                const opts = maxBytes === undefined ? undefined : { maxBytes };
                return serializeArgs$1([xhr.response], opts).serialized[0];
            }
            if (rt === 'blob') {
                const blob = xhr.response;
                return blob === null ? undefined : tagBlob(blob);
            }
            if (rt === 'arraybuffer') {
                const buf = xhr.response;
                return buf === null ? undefined : tagArrayBuffer(buf);
            }
            if (rt === 'document') {
                return { __type: 'Document' };
            }
        }
        catch {
            return undefined;
        }
        return undefined;
    };
    const installXhrCapture = (emit, frame, opts) => {
        const Original = globalThis.XMLHttpRequest;
        if (typeof Original !== 'function')
            return () => { };
        const now = (() => Date.now());
        const idGen = defaultIdGen$1;
        const maxBytes = opts?.maxBytes;
        const states = new WeakMap();
        const tryEmit = (event) => {
            try {
                emit(event);
            }
            catch {
                // Capture failure must never break the page's XHR call.
            }
        };
        const emitTerminal = (xhr, phase) => {
            const state = states.get(xhr);
            if (state === undefined)
                return;
            const endTs = now();
            if (phase === 'response') {
                const body = readResponseBody(xhr, maxBytes);
                tryEmit(Object.freeze({
                    kind: 'xhr',
                    ts: endTs,
                    frameUrl: frame.frameUrl,
                    frameKey: frame.frameKey,
                    ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
                    phase: 'response',
                    captureId: state.captureId,
                    ...(state.method === undefined ? {} : { method: state.method }),
                    ...(state.url === undefined ? {} : { url: state.url }),
                    status: xhr.status,
                    responseType: xhr.responseType,
                    ...(body === undefined ? {} : { body }),
                    durationMs: endTs - state.startTs,
                }));
                return;
            }
            tryEmit(Object.freeze({
                kind: 'xhr',
                ts: endTs,
                frameUrl: frame.frameUrl,
                frameKey: frame.frameKey,
                ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
                phase: 'error',
                captureId: state.captureId,
                ...(state.method === undefined ? {} : { method: state.method }),
                ...(state.url === undefined ? {} : { url: state.url }),
                durationMs: endTs - state.startTs,
            }));
        };
        const Wrapped = new Proxy(Original, {
            construct(target, args, newTarget) {
                const xhr = Reflect.construct(target, args, newTarget);
                const state = {
                    captureId: idGen(),
                    method: undefined,
                    url: undefined,
                    headers: {},
                    startTs: 0,
                };
                states.set(xhr, state);
                const origOpen = xhr.open;
                xhr.open = function patchedOpen(method, url, ...rest) {
                    const s = states.get(this);
                    if (s !== undefined) {
                        s.method = method;
                        s.url = typeof url === 'string' ? url : url.toString();
                    }
                    return origOpen.call(this, method, url, ...rest);
                };
                const origSetHeader = xhr.setRequestHeader;
                xhr.setRequestHeader = function patchedSetHeader(name, value) {
                    const s = states.get(this);
                    if (s !== undefined)
                        s.headers[name] = value;
                    return origSetHeader.call(this, name, value);
                };
                const origSend = xhr.send;
                xhr.send = function patchedSend(body) {
                    const s = states.get(this);
                    if (s !== undefined) {
                        s.startTs = now();
                        let serialized;
                        try {
                            serialized = serializeRequestBody(body, maxBytes);
                        }
                        catch {
                            serialized = undefined;
                        }
                        tryEmit(Object.freeze({
                            kind: 'xhr',
                            ts: s.startTs,
                            frameUrl: frame.frameUrl,
                            frameKey: frame.frameKey,
                            ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
                            phase: 'request',
                            captureId: s.captureId,
                            ...(s.method === undefined ? {} : { method: s.method }),
                            ...(s.url === undefined ? {} : { url: s.url }),
                            ...(Object.keys(s.headers).length > 0
                                ? { headers: { ...s.headers } }
                                : {}),
                            ...(serialized === undefined ? {} : { body: serialized }),
                        }));
                    }
                    return origSend.call(this, body);
                };
                xhr.addEventListener('load', () => {
                    emitTerminal(xhr, 'response');
                });
                xhr.addEventListener('error', () => {
                    emitTerminal(xhr, 'error');
                });
                xhr.addEventListener('abort', () => {
                    emitTerminal(xhr, 'error');
                });
                xhr.addEventListener('timeout', () => {
                    emitTerminal(xhr, 'error');
                });
                return xhr;
            },
        });
        globalThis.XMLHttpRequest = Wrapped;
        let disposed = false;
        return () => {
            if (disposed)
                return;
            disposed = true;
            globalThis.XMLHttpRequest = Original;
        };
    };

    const defaultIdGen = () => safeRandomId('w_');
    const tagBinary = (byteLength) => ({
        __type: 'Binary',
        byteLength,
    });
    const serializeTextFrame = (data, maxBytes) => {
        const opts = undefined ;
        return serializeArgs$1([data], opts).serialized[0];
    };
    const projectFrame = (data, maxBytes) => {
        if (typeof data === 'string') {
            return { frameType: 'text', data: serializeTextFrame(data) };
        }
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
            return { frameType: 'binary', data: tagBinary(data.size) };
        }
        if (data instanceof ArrayBuffer) {
            return { frameType: 'binary', data: tagBinary(data.byteLength) };
        }
        if (ArrayBuffer.isView(data)) {
            return { frameType: 'binary', data: tagBinary(data.byteLength) };
        }
        return { frameType: 'binary', data: tagBinary(0) };
    };
    const installWebSocketCapture = (emit, frame, opts) => {
        const Original = globalThis.WebSocket;
        if (typeof Original !== 'function')
            return () => { };
        const now = (() => Date.now());
        const idGen = defaultIdGen;
        const maxBytes = opts?.maxBytes;
        const states = new WeakMap();
        const tryEmit = (event) => {
            try {
                emit(event);
            }
            catch {
                // Capture failure must never break the page's WebSocket.
            }
        };
        const Wrapped = new Proxy(Original, {
            construct(target, args, newTarget) {
                const ws = Reflect.construct(target, args, newTarget);
                const url = typeof args[0] === 'string'
                    ? args[0]
                    : args[0] instanceof URL
                        ? args[0].toString()
                        : (ws.url ?? '');
                const state = {
                    connectionId: idGen(),
                    url,
                };
                states.set(ws, state);
                const origSend = ws.send;
                ws.send = function patchedSend(data) {
                    const s = states.get(this);
                    if (s !== undefined) {
                        let projected;
                        try {
                            projected = projectFrame(data, maxBytes);
                        }
                        catch {
                            projected = { frameType: 'binary', data: tagBinary(0) };
                        }
                        tryEmit(Object.freeze({
                            kind: 'websocket',
                            ts: now(),
                            frameUrl: frame.frameUrl,
                            frameKey: frame.frameKey,
                            ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
                            subkind: 'frame',
                            connectionId: s.connectionId,
                            direction: 'send',
                            frameType: projected.frameType,
                            data: projected.data,
                        }));
                    }
                    return origSend.call(this, data);
                };
                ws.addEventListener('open', () => {
                    const s = states.get(ws);
                    if (s === undefined)
                        return;
                    tryEmit(Object.freeze({
                        kind: 'websocket',
                        ts: now(),
                        frameUrl: frame.frameUrl,
                        frameKey: frame.frameKey,
                        ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
                        subkind: 'open',
                        connectionId: s.connectionId,
                        url: s.url,
                    }));
                });
                ws.addEventListener('message', (event) => {
                    const s = states.get(ws);
                    if (s === undefined)
                        return;
                    const msg = event;
                    let projected;
                    try {
                        projected = projectFrame(msg.data, maxBytes);
                    }
                    catch {
                        projected = { frameType: 'binary', data: tagBinary(0) };
                    }
                    tryEmit(Object.freeze({
                        kind: 'websocket',
                        ts: now(),
                        frameUrl: frame.frameUrl,
                        frameKey: frame.frameKey,
                        ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
                        subkind: 'frame',
                        connectionId: s.connectionId,
                        direction: 'receive',
                        frameType: projected.frameType,
                        data: projected.data,
                    }));
                });
                ws.addEventListener('close', (event) => {
                    const s = states.get(ws);
                    if (s === undefined)
                        return;
                    const closeEvt = event;
                    tryEmit(Object.freeze({
                        kind: 'websocket',
                        ts: now(),
                        frameUrl: frame.frameUrl,
                        frameKey: frame.frameKey,
                        ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
                        subkind: 'close',
                        connectionId: s.connectionId,
                        ...(typeof closeEvt.code === 'number'
                            ? { code: closeEvt.code }
                            : {}),
                        ...(typeof closeEvt.reason === 'string' && closeEvt.reason.length > 0
                            ? { reason: closeEvt.reason }
                            : {}),
                    }));
                });
                ws.addEventListener('error', () => {
                    const s = states.get(ws);
                    if (s === undefined)
                        return;
                    tryEmit(Object.freeze({
                        kind: 'websocket',
                        ts: now(),
                        frameUrl: frame.frameUrl,
                        frameKey: frame.frameKey,
                        ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
                        subkind: 'error',
                        connectionId: s.connectionId,
                    }));
                });
                return ws;
            },
        });
        globalThis.WebSocket = Wrapped;
        let disposed = false;
        return () => {
            if (disposed)
                return;
            disposed = true;
            globalThis.WebSocket = Original;
        };
    };

    const createNodeIdAllocator = () => {
        let map = new WeakMap();
        let counter = 0;
        const idFor = (node) => {
            if (map === null) {
                throw new Error('NodeIdAllocator: idFor called after dispose');
            }
            const existing = map.get(node);
            if (existing !== undefined)
                return existing;
            counter += 1;
            const id = `n${counter}`;
            map.set(node, id);
            return id;
        };
        const dispose = () => {
            map = null;
        };
        return { idFor, dispose };
    };

    const TEXT_CAP_BYTES = 16_384;
    const MAX_CHILDREN_PER_NODE = 32;
    const capText = (text) => text.length > TEXT_CAP_BYTES
        ? `${text.slice(0, TEXT_CAP_BYTES)}…<truncated ${text.length - TEXT_CAP_BYTES}>`
        : text;
    const syntheticTagName = (nodeType) => {
        if (nodeType === 3)
            return '#text';
        if (nodeType === 8)
            return '#comment';
        if (nodeType === 9)
            return '#document';
        if (nodeType === 11)
            return '#fragment';
        return undefined;
    };
    const serializeAttrs = (element) => {
        const attrs = element.attributes;
        if (attrs === undefined || attrs === null || attrs.length === 0)
            return undefined;
        const out = {};
        for (let i = 0; i < attrs.length; i += 1) {
            const a = attrs.item(i);
            if (a !== null)
                out[a.name] = a.value;
        }
        return out;
    };
    const summarizeNode = (node, depthCap, allocator) => {
        const nodeId = allocator.idFor(node);
        const nodeType = node.nodeType;
        if (nodeType === 1) {
            const element = node;
            const tagName = element.tagName;
            const attrs = serializeAttrs(element);
            const childCount = element.childNodes.length;
            const overChildLimit = childCount > MAX_CHILDREN_PER_NODE;
            if (depthCap <= 0 || overChildLimit) {
                const base = {
                    nodeId,
                    nodeType,
                    tagName,
                    childCount,
                    truncated: true,
                };
                return attrs === undefined ? base : { ...base, attrs };
            }
            const base = { nodeId, nodeType, tagName, childCount };
            return attrs === undefined ? base : { ...base, attrs };
        }
        if (nodeType === 3 || nodeType === 8) {
            const text = node.nodeValue ?? '';
            const tagName = syntheticTagName(nodeType);
            const base = { nodeId, nodeType, textContent: capText(text) };
            return tagName === undefined ? base : { ...base, tagName };
        }
        const tagName = syntheticTagName(nodeType);
        const base = { nodeId, nodeType };
        return tagName === undefined ? base : { ...base, tagName };
    };

    // Open shadow roots only. Closed shadow roots are intentionally out of scope:
    // Element.shadowRoot returns null for closed mode per spec, so per-shadow
    // MutationObservers cannot attach to them even when discovered.
    //
    // M13 T-F adds a narrow Element.prototype.attachShadow patch (installAttachShadowPatch)
    // to fire shadow-attach notifications synchronously on creation regardless of mode.
    // We still skip closed shadows in the listener (init.mode === 'open' check) — the
    // patch is a TIMING fix for open shadows, not a closed-shadow capture mechanism.
    // Without the patch, walk_shadow misses shadows attached to a host that subsequently
    // receives zero light-DOM mutations (T-E real-Brave repro: m13-test.html shadow-host
    // got attachShadow + sr.innerHTML + setTimeout sr.appendChild with zero captures).
    //
    // Cross-frame walking is also out of scope here — iframe content is handled by
    // manifest content_scripts.all_frames=true plus frameId tagging (M13 T-C),
    // not by traversing through iframe.contentDocument from this walker.
    const DEFAULT_MUTATION_INIT = {
        childList: true,
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        characterData: true,
        characterDataOldValue: true,
    };
    const HOST_OBSERVER_INIT = {
        childList: true,
        subtree: true,
    };
    const discoverShadowRoots = (node) => {
        const out = [];
        walkForShadows(node, out);
        return out;
    };
    /**
     * The composed parent of a node: its DOM parentNode, or — when the node is a
     * ShadowRoot (no parentNode) — the shadow host it belongs to. Returns null at
     * the document root. This is the single hop used to walk UP across shadow
     * boundaries (light DOM and shadow trees stitched into one composed chain).
     */
    const composedParentNode = (node) => {
        const parent = node.parentNode;
        if (parent !== null)
            return parent;
        // No parentNode: a ShadowRoot stitches to its host; everything else stops.
        const host = node.host;
        return host ?? null;
    };
    /**
     * Walk the composed ancestor chain strictly ABOVE `start` (across shadow
     * boundaries) and return the nearest ancestor Element for which isHost() is
     * true, else null. Used by the popup producer to decide whether a freshly
     * attached shadow host lives inside an already-tracked popup (so it is a NESTED
     * component, e.g. a Reown <wui-*> inside <w3m-modal>) rather than a new
     * top-level popup. Never throws — a faulty predicate is treated as no-match.
     */
    const findEnclosingHost = (start, isHost) => {
        let node = composedParentNode(start);
        while (node !== null) {
            if (node.nodeType === 1) {
                const el = node;
                try {
                    if (isHost(el))
                        return el;
                }
                catch {
                    // A faulty predicate must not abort the ancestor walk.
                }
            }
            node = composedParentNode(node);
        }
        return null;
    };
    /** True when `ancestor` is on the composed ancestor chain above `descendant`. */
    const composedContains = (ancestor, descendant) => findEnclosingHost(descendant, (el) => el === ancestor) !== null;
    const walkForShadows = (node, out) => {
        if (node.nodeType === 1) {
            const element = node;
            const shadow = element.shadowRoot;
            if (shadow !== null) {
                out.push(shadow);
                walkForShadows(shadow, out);
            }
        }
        const children = node.children;
        if (children === undefined)
            return;
        for (let i = 0; i < children.length; i += 1) {
            const child = children[i];
            if (child !== undefined)
                walkForShadows(child, out);
        }
    };
    const attachShadowObserver = (opts) => {
        if (typeof MutationObserver === 'undefined' || typeof Node === 'undefined') {
            return () => { };
        }
        const observerFactory = opts.observerFactory ?? ((cb) => new MutationObserver(cb));
        const mutationInit = opts.mutationInit ?? DEFAULT_MUTATION_INIT;
        const observers = [];
        const seen = new WeakSet();
        let disposed = false;
        const notifyMutation = (records, target) => {
            try {
                opts.onMutation(records, target);
            }
            catch {
                // Observer callbacks must never throw — capture failures stay contained.
            }
        };
        const notifyAttach = (shadow) => {
            if (opts.onShadowAttach === undefined)
                return;
            try {
                opts.onShadowAttach(shadow);
            }
            catch {
                // Observer callbacks must never throw — capture failures stay contained.
            }
        };
        const scanAndObserve = (subtree) => {
            if (disposed)
                return;
            const roots = discoverShadowRoots(subtree);
            for (const shadow of roots) {
                if (seen.has(shadow))
                    continue;
                notifyAttach(shadow);
                observeShadow(shadow);
            }
        };
        const observeShadow = (shadow) => {
            if (seen.has(shadow))
                return;
            seen.add(shadow);
            const observer = observerFactory((records) => {
                if (disposed)
                    return;
                notifyMutation(records, shadow);
                for (const record of records) {
                    if (record.type !== 'childList')
                        continue;
                    for (let i = 0; i < record.addedNodes.length; i += 1) {
                        const added = record.addedNodes[i];
                        if (added !== undefined)
                            scanAndObserve(added);
                    }
                }
            });
            try {
                observer.observe(shadow, mutationInit);
                observers.push(observer);
            }
            catch {
                // Target may have been detached between discovery and observe; skip.
            }
        };
        scanAndObserve(opts.root);
        // T-F attachShadow patch: catch attach-after-insert cases where the host
        // subsequently receives no light-DOM mutations. Synchronous on creation —
        // the per-shadow MutationObserver attaches before any user-script content
        // (sr.innerHTML / sr.appendChild) runs in the same tick.
        const attachPatchDispose = installAttachShadowPatch((shadow) => {
            if (disposed)
                return;
            if (seen.has(shadow))
                return;
            notifyAttach(shadow);
            observeShadow(shadow);
        });
        // Host-tree observer: childList additions can introduce new shadow hosts.
        // attachShadow() itself fires no mutation, so detection rides on neighbouring
        // tree activity. Two paths covered:
        //   1) Web-component construction: host attaches shadow during constructor +
        //      is inserted into the tree → addedNodes contains the host, and
        //      scanAndObserve walks into its already-attached shadow.
        //   2) Post-insertion attachShadow: host is in the tree, attachShadow runs
        //      with no mutation, then any later childList on the host (e.g. light-DOM
        //      child added, slot content moved) fires a record with target=host. We
        //      re-check target.shadowRoot to pick up the now-present shadow.
        // Edge case not handled: attachShadow() on an existing element followed by
        // zero further mutations on that host. Accepted — no captures would be lost
        // because no shadow content exists to observe.
        const hostObserver = observerFactory((records) => {
            if (disposed)
                return;
            for (const record of records) {
                if (record.type !== 'childList')
                    continue;
                if (record.target.nodeType === 1) {
                    const targetEl = record.target;
                    const targetShadow = targetEl.shadowRoot;
                    if (targetShadow !== null && !seen.has(targetShadow)) {
                        notifyAttach(targetShadow);
                        observeShadow(targetShadow);
                        scanAndObserve(targetShadow);
                    }
                }
                for (let i = 0; i < record.addedNodes.length; i += 1) {
                    const added = record.addedNodes[i];
                    if (added !== undefined)
                        scanAndObserve(added);
                }
            }
        });
        try {
            hostObserver.observe(opts.root, HOST_OBSERVER_INIT);
            observers.push(hostObserver);
        }
        catch {
            // root is not a node MutationObserver can observe (eg. Attr); skip silently.
        }
        return () => {
            if (disposed)
                return;
            disposed = true;
            for (const observer of observers) {
                observer.disconnect();
            }
            observers.length = 0;
            attachPatchDispose();
        };
    };
    const ATTACH_SHADOW_PATCH_MARKER = Symbol.for('pwa-debug:walk_shadow:attachShadowPatched');
    const attachShadowListeners = new Set();
    let originalAttachShadow = null;
    const installAttachShadowPatch = (onAttach) => {
        if (typeof Element === 'undefined')
            return () => { };
        const proto = Element.prototype;
        if (proto[ATTACH_SHADOW_PATCH_MARKER] !== true) {
            const raw = Element.prototype.attachShadow;
            if (typeof raw !== 'function')
                return () => { };
            originalAttachShadow = raw;
            Element.prototype.attachShadow = function patchedAttachShadow(init) {
                const shadow = originalAttachShadow.call(this, init);
                if (init !== undefined && init.mode === 'open') {
                    for (const listener of attachShadowListeners) {
                        try {
                            listener(shadow);
                        }
                        catch {
                            // listener failures must not break the host's attachShadow call
                        }
                    }
                }
                return shadow;
            };
            proto[ATTACH_SHADOW_PATCH_MARKER] = true;
        }
        attachShadowListeners.add(onAttach);
        return () => {
            attachShadowListeners.delete(onAttach);
            if (attachShadowListeners.size === 0 && originalAttachShadow !== null) {
                Element.prototype.attachShadow = originalAttachShadow;
                const proto = Element.prototype;
                delete proto[ATTACH_SHADOW_PATCH_MARKER];
                originalAttachShadow = null;
            }
        };
    };

    // DOM mutation producer. Observes `document` directly for light-DOM mutations
    // and composes attachShadowObserver from walk_shadow to cover open shadow root
    // content; closed shadows are excluded per spec (see walk_shadow.ts header).
    // Both surfaces feed the same onRecords pipeline so mutations coalesce into a
    // single DomMutationCapturedEvent batch regardless of which side fired them.
    const DEFAULT_DEPTH_CAP$1 = 3;
    const DEFAULT_COALESCE_MS = 16;
    const DEFAULT_MAX_PATCHES = 500;
    const nodeListSummaries = (nodes, depthCap, allocator) => {
        const out = [];
        for (let i = 0; i < nodes.length; i += 1) {
            const n = nodes[i];
            if (n !== undefined && n !== null) {
                out.push(summarizeNode(n, depthCap, allocator));
            }
        }
        return out;
    };
    const recordToPatch = (record, depthCap, allocator) => {
        if (record.type === 'childList') {
            const target = summarizeNode(record.target, depthCap, allocator);
            const added = nodeListSummaries(record.addedNodes, depthCap, allocator);
            const removed = nodeListSummaries(record.removedNodes, depthCap, allocator);
            if (added.length === 0 && removed.length === 0)
                return null;
            return { kind: 'childList', target, added, removed };
        }
        if (record.type === 'attributes') {
            const target = summarizeNode(record.target, depthCap, allocator);
            const name = record.attributeName ?? '';
            const oldValue = record.oldValue;
            const newValue = record.target.nodeType === 1
                ? record.target.getAttribute(name)
                : null;
            return { kind: 'attributes', target, name, oldValue, newValue };
        }
        if (record.type === 'characterData') {
            const target = summarizeNode(record.target, depthCap, allocator);
            const oldValue = record.oldValue ?? '';
            const newValue = record.target.nodeValue ?? '';
            return { kind: 'characterData', target, oldValue, newValue };
        }
        return null;
    };
    const installDomMutationCapture = (emit, frame, opts) => {
        if (typeof MutationObserver === 'undefined' ||
            typeof document === 'undefined') {
            return () => { };
        }
        const depthCap = DEFAULT_DEPTH_CAP$1;
        const coalesceWindowMs = DEFAULT_COALESCE_MS;
        const maxPatchesPerEvent = DEFAULT_MAX_PATCHES;
        const now = () => Date.now();
        const allocator = createNodeIdAllocator();
        let pending = [];
        let dropped = 0;
        let timer = null;
        let disposed = false;
        const tryEmit = (event) => {
            try {
                emit(event);
            }
            catch {
                // Capture failure must never break the page.
            }
        };
        const flush = () => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            if (pending.length === 0 && dropped === 0)
                return;
            const patches = dropped > 0 ? [...pending, { kind: 'overflow', dropped }] : pending;
            pending = [];
            dropped = 0;
            tryEmit(Object.freeze({
                kind: 'dom_mutation',
                ts: now(),
                frameUrl: frame.frameUrl,
                frameKey: frame.frameKey,
                ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
                patches: Object.freeze(patches),
            }));
        };
        const scheduleFlush = () => {
            if (timer !== null)
                return;
            timer = setTimeout(flush, coalesceWindowMs);
        };
        const onRecords = (records) => {
            if (disposed)
                return;
            for (const record of records) {
                const patch = recordToPatch(record, depthCap, allocator);
                if (patch === null)
                    continue;
                if (pending.length >= maxPatchesPerEvent) {
                    dropped += 1;
                    continue;
                }
                pending.push(patch);
            }
            if (pending.length === 0 && dropped === 0)
                return;
            if (dropped > 0 || pending.length >= maxPatchesPerEvent) {
                flush();
                return;
            }
            scheduleFlush();
        };
        const observer = new MutationObserver(onRecords);
        try {
            observer.observe(document, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeOldValue: true,
                characterData: true,
                characterDataOldValue: true,
            });
        }
        catch {
            return () => { };
        }
        const shadowDispose = attachShadowObserver({
            root: document,
            onMutation: (records) => {
                onRecords(records);
            },
        });
        return () => {
            if (disposed)
                return;
            disposed = true;
            shadowDispose();
            observer.disconnect();
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            pending = [];
            dropped = 0;
            allocator.dispose();
        };
    };

    const serializeState = (state) => {
        const { serialized } = serializeArgs$1([state]);
        return serialized[0];
    };
    const installLifecycleCapture = (emit, frame, opts) => {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return () => { };
        }
        const now = () => Date.now();
        let disposed = false;
        const cleanups = [];
        const tryEmit = (event) => {
            if (disposed)
                return;
            try {
                emit(event);
            }
            catch {
                // Capture failure must never break the page.
            }
        };
        const buildEvent = (payload) => Object.freeze({
            kind: 'lifecycle',
            source: 'page',
            ts: now(),
            frameUrl: frame.frameUrl,
            frameKey: frame.frameKey,
            ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
            ...payload,
        });
        {
            const onPageshow = (e) => {
                const persisted = e.persisted ?? false;
                tryEmit(buildEvent({ subkind: 'pageshow', persisted }));
            };
            window.addEventListener('pageshow', onPageshow);
            cleanups.push(() => window.removeEventListener('pageshow', onPageshow));
        }
        {
            const onPagehide = (e) => {
                const persisted = e.persisted ?? false;
                tryEmit(buildEvent({ subkind: 'pagehide', persisted }));
            };
            window.addEventListener('pagehide', onPagehide);
            cleanups.push(() => window.removeEventListener('pagehide', onPagehide));
        }
        {
            const onVisibility = () => {
                const visibilityState = document.visibilityState === 'visible' ? 'visible' : 'hidden';
                tryEmit(buildEvent({ subkind: 'visibilitychange', visibilityState }));
            };
            document.addEventListener('visibilitychange', onVisibility);
            cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
        }
        {
            const onBeforeunload = () => {
                tryEmit(buildEvent({ subkind: 'beforeunload' }));
            };
            window.addEventListener('beforeunload', onBeforeunload);
            cleanups.push(() => window.removeEventListener('beforeunload', onBeforeunload));
        }
        {
            const onPopstate = (e) => {
                const popEvent = e;
                tryEmit(buildEvent({
                    subkind: 'popstate',
                    url: location.href,
                    state: serializeState(popEvent.state),
                }));
            };
            window.addEventListener('popstate', onPopstate);
            cleanups.push(() => window.removeEventListener('popstate', onPopstate));
        }
        if (typeof history !== 'undefined') {
            const originalPushState = history.pushState;
            const originalReplaceState = history.replaceState;
            const wrap = (method, original) => function patched(state, title, url) {
                original.call(this, state, title, url ?? null);
                const navPayload = {
                    subkind: 'navigation',
                    method,
                    url: location.href,
                    ...(title ? { title } : {}),
                    state: serializeState(state),
                };
                tryEmit(buildEvent(navPayload));
            };
            const ourPushState = wrap('pushState', originalPushState);
            const ourReplaceState = wrap('replaceState', originalReplaceState);
            history.pushState = ourPushState;
            history.replaceState = ourReplaceState;
            cleanups.push(() => {
                if (history.pushState === ourPushState) {
                    history.pushState = originalPushState;
                }
                if (history.replaceState === ourReplaceState) {
                    history.replaceState = originalReplaceState;
                }
            });
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

    // Popup content snapshot (Path 6 M-B; shadow-piercing in M-D). Pure builder
    // turning a detected popup's content subtree (shadow root or portal element)
    // into a PopupState the AI can reason about: is it visible, what is it titled,
    // what does it say, and what actions it offers. Composes existing primitives —
    // dom_serialize for the structural NodeSummary, dom_aria for ARIA
    // role/accessible-name — rather than re-deriving any of that here.
    //
    // Component-based widgets (e.g. Reown/Web3Modal) render their visible content
    // into PER-COMPONENT open shadow roots nested under the top-level host, where
    // textContent/querySelectorAll do NOT reach. So text/title/buttons/alerts are
    // gathered across open shadow boundaries (composedScopes / collectComposedText)
    // — otherwise a primary popup's state would be empty (just the {#fragment}).
    // Side-effect-free; no module state.
    const DEFAULT_DEPTH_CAP = 2;
    const DEFAULT_TEXT_CAP = 4000;
    const DEFAULT_MAX_BUTTONS = 20;
    const DEFAULT_MAX_ALERTS = 8;
    const ALERT_TEXT_CAP = 500;
    const BUTTON_LABEL_CAP = 120;
    // Copy that signals an auth/connect failure (case-insensitive). Tuned further
    // against real widgets in M-D; kept deliberately broad so a failure is surfaced
    // rather than missed.
    // Includes AppKit/Web3Modal in-modal error-view copy ('Connection declined',
    // 'Connection interrupted', 'Connection request reset', 'Try again', 'timed out')
    // so a real-widget error state is surfaced via the shadow-piercing snapshot.
    const FAILURE_COPY = /\b(fail(?:ed|ure)?|reject(?:ed)?|denied|declined|cancell?ed|unable|went wrong|try again|interrupted|reset|timed out|timeout|error)\b/i;
    const ALERT_SELECTOR = '[role="alert"], [aria-live="assertive"], [aria-live="polite"]';
    const ERROR_STYLED_SELECTOR = '[class*="error" i], [class*="fail" i], [data-error]';
    // --- shadow-piercing query scopes -------------------------------------------
    // The content root plus every nested OPEN shadow root, each a separate scope
    // for querySelectorAll (which does not cross shadow boundaries). Closed shadow
    // roots are invisible to discoverShadowRoots and intentionally out of scope.
    const composedScopes = (contentRoot) => {
        const scopes = [contentRoot];
        try {
            for (const shadow of discoverShadowRoots(contentRoot))
                scopes.push(shadow);
        }
        catch {
            // Discovery must never break snapshotting.
        }
        return scopes;
    };
    const pierceQueryAll = (scopes, selector) => {
        const out = [];
        for (const scope of scopes) {
            try {
                const found = scope.querySelectorAll(selector);
                for (let i = 0; i < found.length; i += 1) {
                    const el = found[i];
                    if (el !== undefined)
                        out.push(el);
                }
            }
            catch {
                // A faulty selector in one scope must not abort the rest.
            }
        }
        return out;
    };
    const pierceQueryFirst = (scopes, selector) => {
        for (const scope of scopes) {
            try {
                const el = scope.querySelector(selector);
                if (el !== null)
                    return el;
            }
            catch {
                // Ignore and continue with the next scope.
            }
        }
        return null;
    };
    // Visible text composed over the FLATTENED tree (across open shadow boundaries
    // AND through <slot> projection). A shadow host's rendered content lives in its
    // shadow root, and the host's light children appear wherever a <slot> projects
    // them — so we descend into the shadow, and at each <slot> we visit its
    // assignedNodes (the projected light DOM). This recovers slotted text that
    // component-based widgets (Reown's wui-*/w3m-*) render via slots, which a
    // skip-light-children walk would lose. Falls back to a slot's own children when
    // nothing is assigned, and to plain child traversal for non-host elements.
    const collectComposedText = (root, cap) => {
        const parts = [];
        let len = 0;
        let truncated = false;
        const visit = (node) => {
            if (len >= cap) {
                truncated = true;
                return;
            }
            if (node.nodeType === 3) {
                const t = node.nodeValue ?? '';
                if (t.trim() !== '') {
                    parts.push(t);
                    len += t.length;
                }
                return;
            }
            if (node.nodeType === 1) {
                const el = node;
                // <slot>: render the projected (assigned) light-DOM nodes in its place.
                if (el.tagName === 'SLOT' &&
                    typeof el.assignedNodes === 'function') {
                    let assigned = [];
                    try {
                        assigned = el.assignedNodes({ flatten: true });
                    }
                    catch {
                        assigned = [];
                    }
                    if (assigned.length > 0) {
                        for (const a of assigned) {
                            if (len >= cap)
                                break;
                            visit(a);
                        }
                        return;
                    }
                    // No assigned nodes: fall through to the slot's fallback children.
                }
                else {
                    let shadow = null;
                    try {
                        shadow = el.shadowRoot;
                    }
                    catch {
                        shadow = null;
                    }
                    if (shadow !== null) {
                        visit(shadow);
                        return;
                    }
                }
            }
            const children = node.childNodes;
            for (let i = 0; i < children.length && len < cap; i += 1) {
                const child = children[i];
                if (child !== undefined)
                    visit(child);
            }
        };
        try {
            visit(root);
        }
        catch {
            // A traversal failure yields whatever was gathered so far.
        }
        let raw = parts.join(' ').replace(/\s+/g, ' ').trim();
        if (raw.length > cap) {
            raw = raw.slice(0, cap);
            truncated = true;
        }
        return { text: raw, truncated };
    };
    // --- field derivation --------------------------------------------------------
    const isVisible = (host) => {
        if (!host.isConnected)
            return false;
        if (typeof getComputedStyle !== 'function')
            return true;
        try {
            const style = getComputedStyle(host);
            return style.display !== 'none' && style.visibility !== 'hidden';
        }
        catch {
            return true;
        }
    };
    const roleOf = (el) => el.getAttribute('role')?.trim() || implicitRoleForElement(el);
    // Title uses only an EXPLICIT accessible name (aria-label / aria-labelledby) —
    // not computeAccessibleName's textContent fallback, which would swallow the
    // whole modal body. Falls back to the first heading's text (across shadows).
    const explicitName = (el) => {
        const label = el.getAttribute('aria-label')?.trim();
        if (label)
            return label;
        const labelledby = el.getAttribute('aria-labelledby')?.trim();
        if (labelledby) {
            const ref = el.ownerDocument?.getElementById(labelledby);
            const t = ref?.textContent?.trim();
            if (t)
                return t;
        }
        return undefined;
    };
    const deriveTitle = (host, scopes) => {
        const name = explicitName(host);
        if (name)
            return name;
        const heading = pierceQueryFirst(scopes, 'h1, h2, h3, h4, h5, h6, [role="heading"]');
        const text = heading?.textContent?.trim();
        return text ? text : undefined;
    };
    const collectButtons = (scopes, maxButtons) => {
        const out = [];
        const seen = new Set();
        const candidates = pierceQueryAll(scopes, 'button, [role="button"]');
        for (let i = 0; i < candidates.length && out.length < maxButtons; i += 1) {
            const el = candidates[i];
            if (el === undefined)
                continue;
            if (roleOf(el) !== 'button')
                continue;
            // Accessible name first; fall back to the button's composed text so labels
            // rendered inside the button's own shadow root (e.g. <wui-button>) survive.
            const named = (computeAccessibleName(el) ?? '').trim();
            const label = named !== '' ? named : collectComposedText(el, BUTTON_LABEL_CAP).text;
            if (label === '' || seen.has(label))
                continue;
            seen.add(label);
            out.push({ label, role: 'button' });
        }
        return out;
    };
    const collectAlerts = (scopes) => {
        const out = [];
        const nodes = pierceQueryAll(scopes, ALERT_SELECTOR);
        for (let i = 0; i < nodes.length && out.length < DEFAULT_MAX_ALERTS; i += 1) {
            const text = nodes[i]?.textContent?.trim();
            if (text)
                out.push(text.slice(0, ALERT_TEXT_CAP));
        }
        return out;
    };
    // A failure is the first failure-copy match among: alert texts, then
    // error-styled element text, then the widget's overall text.
    const deriveFailure = (scopes, alerts, text) => {
        for (const alert of alerts) {
            if (FAILURE_COPY.test(alert))
                return { reason: alert };
        }
        const styled = pierceQueryAll(scopes, ERROR_STYLED_SELECTOR);
        for (let i = 0; i < styled.length; i += 1) {
            const t = styled[i]?.textContent?.trim();
            if (t && FAILURE_COPY.test(t))
                return { reason: t.slice(0, ALERT_TEXT_CAP) };
        }
        const m = text.match(FAILURE_COPY);
        if (m) {
            const trimmed = text.trim();
            return { reason: trimmed.slice(0, ALERT_TEXT_CAP) };
        }
        return undefined;
    };
    const buildPopupState = (host, contentRoot, opts) => {
        const depthCap = DEFAULT_DEPTH_CAP;
        const textCap = DEFAULT_TEXT_CAP;
        const maxButtons = DEFAULT_MAX_BUTTONS;
        const allocator = createNodeIdAllocator();
        const content = summarizeNode(contentRoot, depthCap, allocator);
        allocator.dispose();
        // Text, title, buttons, alerts are gathered across open shadow boundaries so
        // component-based widgets surface readable content instead of an empty shell.
        const scopes = composedScopes(contentRoot);
        const { text: rawText, truncated: textTruncated } = collectComposedText(contentRoot, textCap);
        const title = deriveTitle(host, scopes);
        const buttons = collectButtons(scopes, maxButtons);
        const alerts = collectAlerts(scopes);
        const failure = deriveFailure(scopes, alerts, rawText);
        return {
            visible: isVisible(host),
            ...(title !== undefined ? { title } : {}),
            ...(rawText !== '' ? { text: rawText } : {}),
            ...(buttons.length > 0 ? { buttons } : {}),
            ...(alerts.length > 0 ? { alerts } : {}),
            ...(failure !== undefined ? { failure } : {}),
            content,
            ...(textTruncated || content.truncated === true ? { truncated: true } : {}),
        };
    };

    // Library-popup producer (Path 6 M-A + M-B). Generic detection of any injected
    // overlay via two paths feeding one emit pipeline:
    //   1) SHADOW  — an OPEN shadow root attached AFTER install (the genuine
    //      "injection" signal). We reuse installAttachShadowPatch from walk_shadow
    //      to fire synchronously on attachShadow. Shadow roots already present at
    //      install are page baseline (every web component uses shadow DOM) and are
    //      seeded into a skip-set via discoverShadowRoots so they never emit.
    //   2) PORTAL  — a high-z-index fixed/sticky Element added under the document
    //      tree (React/Vue portals append overlays to <body>). A MutationObserver
    //      on the document root childList+subtree catches them on add.
    //
    // M-B: each detected popup carries a PopupState content snapshot (buildPopupState)
    // on appeared, and re-emits a debounced 'updated' when its content meaningfully
    // changes (per-popup MutationObserver on the widget subtree). popupId is stable
    // across appeared→updated→disappeared; removal is detected by sweeping tracked
    // hosts for !isConnected. All emits are wrapped so capture never breaks the page.
    const DEFAULT_MIN_Z_INDEX = 1000;
    const DEFAULT_UPDATE_DEBOUNCE_MS = 50;
    const WIDGET_OBSERVER_INIT = {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
    };
    // --- signature registry -----------------------------------------------------
    const matchesSelector = (host, selector) => {
        try {
            return host.matches(selector);
        }
        catch {
            return false;
        }
    };
    const tagLower = (host) => host.tagName.toLowerCase();
    /**
     * Known-widget signatures. Adding a widget is data-only: push an entry here.
     * Predicates are host-level only and must never throw (matchLibrary guards too).
     */
    const POPUP_SIGNATURES = [
        {
            library: 'walletconnect',
            // Web3Modal/WalletConnect modal custom elements: <w3m-modal>, <wcm-modal>,
            // and the wcm-*/w3m-* element family.
            match: (host) => {
                const tag = tagLower(host);
                return tag.startsWith('w3m-') || tag.startsWith('wcm-');
            },
        },
        {
            library: 'rainbowkit',
            match: (host) => matchesSelector(host, '[data-rk], #rainbowkit, [data-rk] *'),
        },
        {
            library: 'connectkit',
            match: (host) => matchesSelector(host, '[class*="connectkit"], [class*="ck-"], [data-ck]'),
        },
        {
            library: 'privy',
            match: (host) => matchesSelector(host, '[id^="privy-"], iframe[src*="privy"], #privy-dialog'),
        },
    ];
    const matchLibrary = (host, signatures = POPUP_SIGNATURES) => {
        for (const sig of signatures) {
            try {
                if (sig.match(host))
                    return sig.library;
            }
            catch {
                // A faulty predicate must not abort the rest of the registry.
            }
        }
        return 'unknown';
    };
    // --- host summary ------------------------------------------------------------
    const cssEscape = (value) => typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(value)
        : value;
    const buildSelector = (host) => {
        const tag = tagLower(host);
        if (host.id)
            return `${tag}#${cssEscape(host.id)}`;
        const classes = Array.from(host.classList).slice(0, 3);
        if (classes.length > 0) {
            return tag + classes.map((c) => `.${cssEscape(c)}`).join('');
        }
        return tag;
    };
    const buildHostSummary = (host) => {
        const classes = Array.from(host.classList);
        return {
            tagName: host.tagName,
            ...(host.id ? { id: host.id } : {}),
            ...(classes.length > 0 ? { classes } : {}),
            selector: buildSelector(host),
        };
    };
    // --- portal heuristic --------------------------------------------------------
    const isPortalOverlay = (node, minZIndex) => {
        if (node.nodeType !== 1)
            return false;
        if (typeof getComputedStyle !== 'function')
            return false;
        try {
            const style = getComputedStyle(node);
            if (style.position !== 'fixed' && style.position !== 'sticky')
                return false;
            const z = parseInt(style.zIndex, 10);
            return Number.isFinite(z) && z >= minZIndex;
        }
        catch {
            return false;
        }
    };
    // --- state signature (dedupes 'updated' to meaningful changes) ---------------
    const stateSignature = (state) => {
        try {
            return JSON.stringify({
                visible: state.visible,
                title: state.title,
                text: state.text,
                buttons: state.buttons,
                alerts: state.alerts,
                failure: state.failure?.reason,
            });
        }
        catch {
            return `${state.visible}|${state.title ?? ''}|${state.text ?? ''}|${state.failure?.reason ?? ''}`;
        }
    };
    const installPopupCapture = (emit, frame, opts) => {
        if (typeof MutationObserver === 'undefined' ||
            typeof document === 'undefined' ||
            typeof Element === 'undefined') {
            return () => { };
        }
        const minZIndex = DEFAULT_MIN_Z_INDEX;
        const signatures = POPUP_SIGNATURES;
        const observerFactory = ((cb) => new MutationObserver(cb));
        const idGen = (() => safeRandomId('popup_'));
        const snapshotOpts = opts?.snapshot;
        const debounceMs = DEFAULT_UPDATE_DEBOUNCE_MS;
        const now = () => Date.now();
        let disposed = false;
        const tracked = new Map();
        // Shadow hosts present at install are baseline page structure, not popups.
        const baselineShadowHosts = new WeakSet();
        for (const shadow of discoverShadowRoots(document)) {
            if (shadow.host)
                baselineShadowHosts.add(shadow.host);
        }
        const makeEvent = (info, phase, state) => Object.freeze({
            kind: 'library_popup',
            ts: now(),
            frameUrl: frame.frameUrl,
            frameKey: frame.frameKey,
            ...(frame.isCrossOrigin !== undefined
                ? { isCrossOrigin: frame.isCrossOrigin }
                : {}),
            popupId: info.popupId,
            phase,
            detection: info.detection,
            library: info.library,
            host: info.hostSummary,
            role: info.role,
            parentPopupId: info.parentPopupId,
            ...(state !== undefined ? { state } : {}),
        });
        const tryEmit = (event) => {
            try {
                emit(event);
            }
            catch {
                // Capture failure must never break the page.
            }
        };
        const snapshot = (host, contentRoot) => {
            try {
                return buildPopupState(host, contentRoot, snapshotOpts);
            }
            catch {
                return undefined;
            }
        };
        const reSnapshot = (host) => {
            if (disposed)
                return;
            const info = tracked.get(host);
            if (info === undefined)
                return;
            info.timer = null;
            const state = snapshot(host, info.contentRoot);
            if (state === undefined)
                return;
            const sig = stateSignature(state);
            if (sig === info.lastSig)
                return; // no meaningful change
            info.lastSig = sig;
            tryEmit(makeEvent(info, 'updated', state));
        };
        const scheduleReSnapshot = (host) => {
            const info = tracked.get(host);
            if (info === undefined || info.timer !== null)
                return;
            info.timer = setTimeout(() => reSnapshot(host), debounceMs);
        };
        const observeWidget = (host, contentRoot) => {
            const observers = [];
            const add = (target, init) => {
                const observer = observerFactory(() => {
                    if (!disposed)
                        scheduleReSnapshot(host);
                });
                try {
                    observer.observe(target, init);
                    observers.push(observer);
                }
                catch {
                    // Target not observable (e.g. detached); skip.
                }
            };
            add(contentRoot, WIDGET_OBSERVER_INIT);
            // Visibility/class/style changes on a shadow host don't show up inside the
            // shadow root, so watch the host's attributes too when it differs.
            if (host !== contentRoot) {
                add(host, { attributes: true });
            }
            return observers;
        };
        // Re-tag any already-tracked PRIMARY popups that actually live inside a newly
        // registered primary host (their shadow attached before the parent's was
        // tracked). They become nested children of the new popup; their update
        // observers are torn down (only primaries re-snapshot) and a corrective
        // 'updated' carries the new role so consumers can re-classify.
        const reparentInto = (newHost, newInfo) => {
            for (const [host, info] of tracked) {
                if (host === newHost || info.role !== 'primary')
                    continue;
                if (composedContains(newHost, host)) {
                    info.role = 'nested';
                    info.parentPopupId = newInfo.popupId;
                    teardown(info);
                    tryEmit(makeEvent(info, 'updated', snapshot(host, info.contentRoot)));
                }
            }
        };
        const registerPopup = (host, detection, contentRoot) => {
            if (disposed || tracked.has(host))
                return;
            // Containment: a host inside an already-tracked popup is a NESTED component
            // of that popup (e.g. Reown <wui-*>/<ph-*> inside <w3m-modal>), not a new
            // top-level popup. parentPopupId points at the nearest enclosing tracked
            // popup so consumers can reconstruct the widget hierarchy.
            const parentHost = findEnclosingHost(host, (el) => tracked.has(el));
            const parent = parentHost !== null ? tracked.get(parentHost) : undefined;
            const role = parent !== undefined ? 'nested' : 'primary';
            const state = snapshot(host, contentRoot);
            const info = {
                popupId: idGen(),
                detection,
                library: matchLibrary(host, signatures),
                hostSummary: buildHostSummary(host),
                contentRoot,
                role,
                parentPopupId: parent !== undefined ? parent.popupId : null,
                lastSig: state !== undefined ? stateSignature(state) : '',
                observers: [],
                timer: null,
            };
            tracked.set(host, info);
            if (role === 'primary')
                reparentInto(host, info);
            tryEmit(makeEvent(info, 'appeared', state));
            if (role === 'primary') {
                // Only PRIMARY popups get a per-widget update observer. Nested components
                // would otherwise each fire their own 'updated' storm (a single Reown
                // modal is ~50 nested web components) and drown the primary's events.
                info.observers.push(...observeWidget(host, contentRoot));
            }
            else {
                // A nested component rendering is exactly when the enclosing primary's
                // content (which lives across these nested shadow roots) fills in. Re-
                // snapshot that primary — debounced, so the ~50 nested attachments of one
                // modal coalesce into a few primary re-snapshots rather than a storm, and
                // WITHOUT giving any nested its own observer.
                const primaryHost = findEnclosingHost(host, (el) => {
                    const t = tracked.get(el);
                    return t !== undefined && t.role === 'primary';
                });
                if (primaryHost !== null)
                    scheduleReSnapshot(primaryHost);
            }
        };
        const teardown = (info) => {
            for (const observer of info.observers)
                observer.disconnect();
            info.observers.length = 0;
            if (info.timer !== null) {
                clearTimeout(info.timer);
                info.timer = null;
            }
        };
        const sweepRemovals = () => {
            if (disposed || tracked.size === 0)
                return;
            for (const [host, info] of tracked) {
                if (!host.isConnected) {
                    tracked.delete(host);
                    teardown(info);
                    tryEmit(makeEvent(info, 'disappeared'));
                }
            }
        };
        // SHADOW: only shadows attached AFTER install (genuine injections) emit.
        const attachDispose = installAttachShadowPatch((shadow) => {
            if (disposed)
                return;
            const host = shadow.host;
            if (host && !baselineShadowHosts.has(host)) {
                registerPopup(host, 'shadow', shadow);
            }
        });
        // PORTAL: high-z fixed/sticky elements added anywhere under the document root.
        const onBodyMutations = (records) => {
            if (disposed)
                return;
            for (const record of records) {
                if (record.type !== 'childList')
                    continue;
                for (let i = 0; i < record.addedNodes.length; i += 1) {
                    const added = record.addedNodes[i];
                    if (added !== undefined && isPortalOverlay(added, minZIndex)) {
                        registerPopup(added, 'portal', added);
                    }
                }
            }
            sweepRemovals();
        };
        const bodyObserver = observerFactory((records) => onBodyMutations(records));
        const root = document.body ?? document.documentElement;
        try {
            bodyObserver.observe(root, { childList: true, subtree: true });
        }
        catch {
            attachDispose();
            return () => { };
        }
        return () => {
            if (disposed)
                return;
            disposed = true;
            attachDispose();
            bodyObserver.disconnect();
            for (const info of tracked.values())
                teardown(info);
            tracked.clear();
        };
    };

    // Page-error producer. Hooks window 'error' (ErrorEvent / window.onerror) and
    // 'unhandledrejection' (PromiseRejectionEvent) and emits a PageErrorCapturedEvent
    // per uncaught failure. App- and framework-agnostic: surfaces thrown errors and
    // rejected promises that BUBBLE (including wallet/connect rejections the app
    // lets through) so the AI sees them without the app having to log anything.
    // Errors the app fully catches do not surface here — that is expected; a
    // library-aware hook (Path 6 WC task) covers swallowed wallet rejections.
    const MESSAGE_CAP = 4000;
    const capMessage = (s) => s.length > MESSAGE_CAP ? s.slice(0, MESSAGE_CAP) : s;
    // Extract a readable {message, name?, stack?} from any thrown/rejected value:
    // Error instances, strings, structured objects (message/reason/msg), else JSON.
    // Exported for reuse by the wallet-rejection producer.
    const describeThrown = (value) => {
        if (value instanceof Error) {
            const stack = value.stack;
            return {
                message: value.message !== '' ? value.message : value.name,
                name: value.name,
                ...(stack !== undefined ? { stack: stripExtensionFrames(stack) } : {}),
            };
        }
        if (typeof value === 'string')
            return { message: value };
        if (value !== null && typeof value === 'object') {
            const o = value;
            for (const key of ['message', 'reason', 'msg']) {
                const v = o[key];
                if (typeof v === 'string' && v.trim() !== '')
                    return { message: v };
            }
            try {
                return { message: JSON.stringify(value) };
            }
            catch {
                return { message: String(value) };
            }
        }
        return { message: String(value) };
    };
    // Build a frozen PageErrorCapturedEvent. Exported so the wallet-rejection
    // producer emits into the same page_error stream without duplicating shape.
    const buildPageError = (subkind, info, frame, now, source) => Object.freeze({
        kind: 'page_error',
        ts: now(),
        frameUrl: frame.frameUrl,
        frameKey: frame.frameKey,
        ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
        subkind,
        message: capMessage(info.message),
        ...(info.name !== undefined ? { name: info.name } : {}),
        ...(info.stack !== undefined ? { stack: info.stack } : {}),
        ...(source !== undefined ? { source } : {}),
    });
    const installErrorCapture = (emit, frame, opts) => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
            return () => { };
        }
        const now = (() => Date.now());
        const make = (subkind, info, source) => buildPageError(subkind, info, frame, now, source);
        const tryEmit = (event) => {
            try {
                emit(event);
            }
            catch {
                // Capture failure must never affect the page's own error handling.
            }
        };
        const onError = (event) => {
            const e = event;
            // Prefer the real Error object (carries name + stack); fall back to message.
            const info = e.error instanceof Error
                ? describeThrown(e.error)
                : { message: typeof e.message === 'string' && e.message !== '' ? e.message : 'Uncaught error' };
            const filename = typeof e.filename === 'string' && e.filename !== '' ? e.filename : undefined;
            const source = filename !== undefined
                ? `${filename}:${e.lineno ?? 0}:${e.colno ?? 0}`
                : undefined;
            tryEmit(make('error', info, source));
        };
        const onRejection = (event) => {
            const e = event;
            tryEmit(make('unhandledrejection', describeThrown(e.reason)));
        };
        // Bubble phase: capture script errors + unhandled rejections (not resource
        // load errors, which only fire in the capture phase and are page noise).
        window.addEventListener('error', onError, false);
        window.addEventListener('unhandledrejection', onRejection, false);
        let disposed = false;
        return () => {
            if (disposed)
                return;
            disposed = true;
            window.removeEventListener('error', onError, false);
            window.removeEventListener('unhandledrejection', onRejection, false);
        };
    };

    // Wallet-aware rejection producer (Path 6 M-D). Wraps the EIP-1193 .request
    // method of injected wallet providers (window.ethereum, its .providers[], and
    // EIP-6963 announced providers) to observe request REJECTIONS at the provider
    // boundary — including user cancellations (code 4001) that the app catches in
    // try/catch and never lets bubble (so the general window-error capture misses
    // them). Each rejection is emitted into the shared page_error stream as
    // subkind:'wallet_rejection', so it surfaces via error_tail and correlates in
    // popup_failures with no new buffer. Call-through + rethrow: never alters the
    // wallet's behavior. General across EVM injected wallets. (WalletConnect's
    // relay/mobile path goes through UniversalProvider, not window.ethereum, and is
    // out of scope here; AppKit's in-modal error view is covered by the popup
    // snapshot's failure detection instead.)
    const METHOD_CAP = 80;
    const requestMethod = (args) => {
        const a0 = args[0];
        if (a0 !== null &&
            typeof a0 === 'object' &&
            typeof a0.method === 'string') {
            return a0.method.slice(0, METHOD_CAP);
        }
        return 'request';
    };
    const installWalletCapture = (emit, frame, opts) => {
        if (typeof window === 'undefined')
            return () => { };
        const now = (() => Date.now());
        const wrapped = new WeakSet();
        const restorers = [];
        const tryEmit = (event) => {
            try {
                emit(event);
            }
            catch {
                // Capture failure must never affect the wallet/app.
            }
        };
        const emitRejection = (method, err) => {
            const info = describeThrown(err);
            const code = err !== null && typeof err === 'object' && 'code' in err
                ? err.code
                : undefined;
            const codeStr = typeof code === 'number' || typeof code === 'string' ? ` (code ${code})` : '';
            tryEmit(buildPageError('wallet_rejection', {
                message: `${method} rejected${codeStr}: ${info.message}`,
                ...(info.name !== undefined ? { name: info.name } : {}),
                ...(info.stack !== undefined ? { stack: info.stack } : {}),
            }, frame, now));
        };
        const wrapProvider = (provider) => {
            if (provider === null || typeof provider !== 'object')
                return;
            if (wrapped.has(provider))
                return;
            const p = provider;
            const original = p.request;
            if (typeof original !== 'function')
                return;
            wrapped.add(provider);
            const call = original.bind(provider);
            const patched = (...args) => {
                const method = requestMethod(args);
                let result;
                try {
                    result = call(...args);
                }
                catch (e) {
                    emitRejection(method, e);
                    throw e;
                }
                if (result === null ||
                    typeof result?.then !== 'function') {
                    return result;
                }
                return Promise.resolve(result).catch((e) => {
                    emitRejection(method, e);
                    throw e;
                });
            };
            try {
                p.request = patched;
                restorers.push(() => {
                    try {
                        p.request = original;
                    }
                    catch {
                        // ignore
                    }
                });
            }
            catch {
                // request is a non-writable/getter property; cannot wrap — skip.
                wrapped.delete(provider);
                return;
            }
            // Multi-wallet aggregation exposes sub-providers under .providers[].
            const subs = p.providers;
            if (Array.isArray(subs)) {
                for (const sub of subs)
                    wrapProvider(sub);
            }
        };
        // 1) Wrap whatever is present now.
        const initial = window.ethereum;
        wrapProvider(initial);
        // 2) EIP-6963: wrap every announced provider (sync or async).
        const onAnnounce = (event) => {
            const detail = event.detail;
            if (detail?.provider !== undefined)
                wrapProvider(detail.provider);
        };
        let announceAdded = false;
        try {
            window.addEventListener('eip6963:announceProvider', onAnnounce);
            announceAdded = true;
            window.dispatchEvent(new Event('eip6963:requestProvider'));
        }
        catch {
            // No CustomEvent/dispatch in this environment; rely on the direct wrap.
        }
        // 3) Late injection: trap assignment to window.ethereum so a provider set
        // after our script still gets wrapped. Guarded — some wallets define the
        // property non-configurable, in which case we keep the initial + 6963 paths.
        let trapped = false;
        let stored = initial;
        try {
            const desc = Object.getOwnPropertyDescriptor(window, 'ethereum');
            if (desc === undefined || desc.configurable === true) {
                Object.defineProperty(window, 'ethereum', {
                    configurable: true,
                    enumerable: true,
                    get: () => stored,
                    set: (v) => {
                        stored = v;
                        wrapProvider(v);
                    },
                });
                trapped = true;
            }
        }
        catch {
            // Leave window.ethereum as-is.
        }
        let disposed = false;
        return () => {
            if (disposed)
                return;
            disposed = true;
            if (announceAdded) {
                try {
                    window.removeEventListener('eip6963:announceProvider', onAnnounce);
                }
                catch {
                    // ignore
                }
            }
            for (const restore of restorers)
                restore();
            if (trapped) {
                try {
                    Object.defineProperty(window, 'ethereum', {
                        configurable: true,
                        enumerable: true,
                        writable: true,
                        value: stored,
                    });
                }
                catch {
                    // ignore
                }
            }
        };
    };

    /**
     * Page-world capture producer for the DEBUGGED PWA's service-worker lifecycle.
     *
     * Subscribes to navigator.serviceWorker and emits a typed SwStateCapturedEvent
     * (kind 'sw_state') on each transition — a new worker installing (updatefound),
     * a worker advancing state (statechange), or the page's controller changing
     * (controllerchange). Feeds the existing capture pipeline (page → CS → SW →
     * host ring buffer), tailed by the sw_lifecycle_tail MCP tool.
     *
     * This is the APP's service worker (navigator.serviceWorker), distinct from the
     * extension's own sw_lifecycle module (which emits page-navigation events).
     */
    /** Pure builder: frame meta + ts + subkind + the present optional fields. */
    const buildSwStateEvent = (subkind, frame, ts, fields) => Object.freeze({
        kind: 'sw_state',
        ts,
        frameUrl: frame.frameUrl,
        frameKey: frame.frameKey,
        ...(frame.isCrossOrigin !== undefined
            ? { isCrossOrigin: frame.isCrossOrigin }
            : {}),
        subkind,
        ...(fields.scope !== undefined ? { scope: fields.scope } : {}),
        ...(fields.scriptURL !== undefined ? { scriptURL: fields.scriptURL } : {}),
        ...(fields.state !== undefined ? { state: fields.state } : {}),
        ...(fields.slot !== undefined ? { slot: fields.slot } : {}),
    });
    const installSwStateCapture = (emit, frame, opts) => {
        const container = (navigator.serviceWorker ?? null);
        const now = (() => Date.now());
        if (container === null || typeof container.addEventListener !== 'function') {
            return () => { };
        }
        const cleanups = [];
        const listen = (target, type, handler) => {
            target.addEventListener(type, handler);
            cleanups.push(() => target.removeEventListener(type, handler));
        };
        const safeEmit = (subkind, fields) => {
            try {
                emit(buildSwStateEvent(subkind, frame, now(), fields));
            }
            catch {
                // Capture failure must never break the page.
            }
        };
        const watchWorker = (worker, scope, slot) => {
            if (worker === null)
                return;
            listen(worker, 'statechange', () => {
                safeEmit('statechange', {
                    ...(scope !== undefined ? { scope } : {}),
                    scriptURL: worker.scriptURL,
                    state: worker.state,
                    slot,
                });
            });
        };
        const watchRegistration = (reg) => {
            listen(reg, 'updatefound', () => {
                const installing = reg.installing;
                safeEmit('updatefound', {
                    scope: reg.scope,
                    ...(installing !== null
                        ? { scriptURL: installing.scriptURL, state: installing.state }
                        : {}),
                    slot: 'installing',
                });
                // The just-appeared installing worker drives the install→activated chain.
                watchWorker(installing, reg.scope, 'installing');
            });
            // Attach to any workers already in flight so an in-progress install/activate
            // isn't missed (the snapshot is sw_status; this is the forward stream).
            watchWorker(reg.installing, reg.scope, 'installing');
            watchWorker(reg.waiting, reg.scope, 'waiting');
            watchWorker(reg.active, reg.scope, 'active');
        };
        listen(container, 'controllerchange', () => {
            const controller = container.controller;
            safeEmit('controllerchange', {
                ...(controller !== null
                    ? { scriptURL: controller.scriptURL, state: controller.state }
                    : {}),
                slot: 'active',
            });
        });
        if (typeof container.getRegistrations === 'function') {
            container
                .getRegistrations()
                .then((regs) => {
                for (const reg of regs)
                    watchRegistration(reg);
            })
                .catch(() => {
                // No registrations / API failure — controllerchange stays wired.
            });
        }
        let disposed = false;
        return () => {
            if (disposed)
                return;
            disposed = true;
            for (const cleanup of cleanups)
                cleanup();
        };
    };

    /** Brand tagging a `.connect` (and its shim) as installed by THIS module, so a
     *  pre-existing connect is recognised as real-devtools vs. our own re-install. */
    const PWA_CONNECT_SHIM = Symbol.for('pwaDebug.zustandDevtoolsShim');
    const installZustandDevtoolsShim = (scope) => {
        const captured = [];
        const shim = Object.freeze({
            getStores: () => Object.freeze([...captured]),
        });
        const ext = scope.__REDUX_DEVTOOLS_EXTENSION__;
        if (ext !== undefined && typeof ext.connect === 'function') {
            const prior = ext.connect[PWA_CONNECT_SHIM];
            // Our own connect already here → idempotent re-install; return its shim so
            // captures stay on the original array. Otherwise the real Redux DevTools
            // extension owns the hook → never clobber, capture via explicit handoff.
            return prior ?? shim;
        }
        const connect = () => {
            // Zustand creates one connection per devtools-wrapped store, so each
            // connect() call corresponds to exactly one store.
            const listeners = [];
            let lastState = undefined;
            let registered = false;
            const handle = {
                getState: () => lastState,
                setState: () => {
                    throw new Error('zustand: setState is unavailable on a store captured via the devtools ' +
                        'auto-capture shim — the devtools connection is observe-only, and a write ' +
                        'would have to round-trip through JSON time-travel (stripping the store\'s ' +
                        'action functions). Dispatch a named in-store action instead ' +
                        '(e.g. store_dispatch type:"increment"), or expose the vanilla store on ' +
                        'window.__pwaDebug_zustand for full setState.');
                },
                subscribe: (listener) => {
                    const wrapped = () => listener(lastState, lastState);
                    listeners.push(wrapped);
                    return () => {
                        const i = listeners.indexOf(wrapped);
                        if (i >= 0)
                            listeners.splice(i, 1);
                    };
                },
            };
            const record = (state) => {
                lastState = state;
                if (!registered) {
                    captured.push(handle);
                    registered = true;
                }
                for (const l of [...listeners])
                    l();
            };
            return {
                init: (state) => record(state),
                send: (_action, state) => record(state),
                // Time-travel listener accepted and ignored — auto-capture never pushes
                // state back into the store (see handle.setState).
                subscribe: () => () => undefined,
                unsubscribe: () => undefined,
                error: () => undefined,
            };
        };
        connect[PWA_CONNECT_SHIM] = shim;
        if (typeof ext === 'function') {
            // Decorate the existing callable (our Redux stub) so it is BOTH an enhancer
            // factory (Redux) and a connect provider (Zustand). THE breakage fix.
            ext.connect = connect;
        }
        else {
            // No devtools present. Install a callable carrier that provides `.connect`
            // for Zustand. zustand@5's middleware only needs this global to be
            // truthy-with-`.connect` — it never invokes it (verified middleware.js:66) —
            // so the callable half exists purely for Redux coexistence: a legacy-pattern
            // app does `compose(applyMiddleware(...), __REDUX_DEVTOOLS_EXTENSION__())`.
            // Returning a valid IDENTITY enhancer (createStore => createStore) instead of
            // `undefined` makes that compose a clean no-op rather than crashing the host
            // app. We deliberately never set __REDUX_DEVTOOLS_EXTENSION_COMPOSE__ (the
            // wrong-contract global that crashed RTK in the deleted Redux shim, note 238).
            const carrier = (() => (createStore) => createStore);
            carrier.connect = connect;
            scope.__REDUX_DEVTOOLS_EXTENSION__ = carrier;
        }
        return shim;
    };

    const probeGlobals = () => {
        const w = window;
        return {
            react: '__REACT_DEVTOOLS_GLOBAL_HOOK__' in w,
            vue: '__VUE_DEVTOOLS_GLOBAL_HOOK__' in w,
            svelte: '__svelte' in w,
            redux: '__REDUX_DEVTOOLS_EXTENSION__' in w,
        };
    };
    const probeDom = () => {
        let react = false;
        let vue = false;
        let svelte = false;
        const root = document.body ?? document.documentElement;
        if (!root)
            return { react, vue, svelte };
        const sample = [root];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let count = 0;
        while (walker.nextNode() && count < 100) {
            sample.push(walker.currentNode);
            count += 1;
        }
        for (const el of sample) {
            if (react && vue && svelte)
                break;
            const keys = Object.keys(el);
            if (!react &&
                keys.some((k) => k.startsWith('__reactFiber$') ||
                    k.startsWith('__reactContainer$') ||
                    k.startsWith('__reactProps$'))) {
                react = true;
            }
            if (!vue &&
                ('__vue__' in el ||
                    '__vue_app__' in el ||
                    keys.some((k) => k === '_vnode' || k.startsWith('__vnode')))) {
                vue = true;
            }
            if (!svelte && keys.some((k) => k.startsWith('__svelte'))) {
                svelte = true;
            }
        }
        return { react, vue, svelte };
    };
    const merge = (early, dom) => ({
        react: early.react || dom.react,
        vue: early.vue || dom.vue,
        svelte: early.svelte || dom.svelte,
        redux: early.redux,
    });
    const installBridgeListener = () => {
        window.addEventListener('message', (event) => {
            if (!isInboundCsToPage(event))
                return;
            dispatchPageRequest(event.data).then((response) => {
                window.postMessage(response, window.location.origin);
            }, (err) => {
                console.warn('[pwa-debug/page] dispatchPageRequest rejected (should not happen):', err.message);
            });
        });
    };
    const installCaptures = (frame) => {
        const emit = (event) => {
            window.postMessage(encodeEvent(event), window.location.origin);
        };
        const kinds = {
            console: typeof console !== 'undefined',
            fetch: typeof globalThis.fetch === 'function',
            xhr: typeof globalThis.XMLHttpRequest === 'function',
            websocket: typeof globalThis.WebSocket === 'function',
            dom_mutation: typeof MutationObserver !== 'undefined' &&
                typeof document !== 'undefined',
            lifecycle: typeof window !== 'undefined' &&
                typeof document !== 'undefined' &&
                typeof history?.pushState === 'function',
            library_popup: typeof MutationObserver !== 'undefined' &&
                typeof document !== 'undefined' &&
                typeof Element !== 'undefined',
            page_error: typeof window !== 'undefined' &&
                typeof window.addEventListener === 'function',
            sw_state: typeof navigator !== 'undefined' &&
                navigator.serviceWorker !== undefined,
        };
        const disposers = [
            installConsoleCapture(emit, frame),
            installFetchCapture(emit, frame),
            installXhrCapture(emit, frame),
            installWebSocketCapture(emit, frame),
            installDomMutationCapture(emit, frame),
            installLifecycleCapture(emit, frame),
            installPopupCapture(emit, frame),
            installErrorCapture(emit, frame),
            installWalletCapture(emit, frame),
            installSwStateCapture(emit, frame),
        ];
        const dispose = () => {
            for (const d of disposers)
                d();
        };
        return { dispose, kinds };
    };
    const INSTALL_GUARD = '__pwaDebugPageWorldInstalled';
    const bootstrap = () => {
        // Idempotency guard. page-world.js can run more than once in the same MAIN
        // world: the manifest injects it at document_start, and the SW self-heal
        // (sw_health_probe) re-injects it via chrome.scripting.executeScript. After an
        // extension reload the original page-world is orphaned but STILL running (a
        // MAIN-world 'message' listener survives reload — there is no navigation), so
        // a second bootstrap would register a DUPLICATE bridge listener and capture
        // set. Two bridge listeners dispatch every cs->page request twice, making
        // every mutating pdl_* action (click/fill/check/...) run twice. The flag lives
        // on `window` and persists across the reload, so the re-injection no-ops here
        // and the (orphaned-but-functional) original listener stays the sole handler.
        const w = window;
        if (w[INSTALL_GUARD])
            return;
        Object.defineProperty(window, INSTALL_GUARD, {
            value: true,
            configurable: true,
        });
        // Redux store capture is PASSIVE now — read-only react-redux fiber-context
        // discovery (see stores/redux/discover). We no longer impersonate
        // __REDUX_DEVTOOLS_EXTENSION_COMPOSE__, which used to break RTK apps by
        // sitting in their store-creation path.
        //
        // Install the Zustand devtools-connect shim: zustand's devtools middleware
        // calls __REDUX_DEVTOOLS_EXTENSION__.connect(...). With no real devtools and
        // no Redux stub present, the shim installs a benign callable carrier that
        // also provides `.connect` (and no-ops if the real Redux DevTools owns the
        // hook).
        const zustandShim = installZustandDevtoolsShim(window);
        setZustandShim(zustandShim);
        installBridgeListener();
        const frame = computeFrameMeta();
        const { kinds } = installCaptures(frame);
        console.log('[pwa-debug/page] captures installed', { frame, kinds });
        const early = probeGlobals();
        console.log('[pwa-debug/page] world=MAIN, hooks(early)=', early);
        const reportLate = () => {
            const merged = merge(early, probeDom());
            console.log('[pwa-debug/page] hooks(post-load)=', merged);
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', reportLate, { once: true });
        }
        else {
            setTimeout(reportLate, 0);
        }
    };
    bootstrap();

    exports.bootstrap = bootstrap;

    return exports;

})({});
//# sourceMappingURL=page-world.js.map
