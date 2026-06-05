(function (exports) {
    'use strict';

    const PAGE_BRIDGE_NS = 'pwa-debug';
    const encodeRequest = (input) => {
        const base = {
            ns: PAGE_BRIDGE_NS,
            dir: 'cs->page',
            requestId: input.requestId,
            tool: input.tool,
        };
        return Object.freeze(input.payload === undefined ? base : { ...base, payload: input.payload });
    };
    const isPageBridgeNs = (v) => v === PAGE_BRIDGE_NS;
    const isInboundPageToCs = (event) => {
        if (event.source !== window)
            return false;
        const data = event.data;
        if (data === null || typeof data !== 'object')
            return false;
        const r = data;
        return (isPageBridgeNs(r['ns']) &&
            r['dir'] === 'page->cs' &&
            typeof r['requestId'] === 'string');
    };
    const isInboundPageEvent = (event) => {
        if (event.source !== window)
            return false;
        const data = event.data;
        if (data === null || typeof data !== 'object')
            return false;
        const r = data;
        return (isPageBridgeNs(r['ns']) &&
            r['dir'] === 'page-event' &&
            'event' in r);
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

    const PAGE_EVENT_SW_TAG = 'pwa-debug-page-event';
    const DEFAULT_TIMEOUT_MS = 4000;
    const defaultForwardEventToSw = (message) => {
        try {
            chrome.runtime.sendMessage(message);
        }
        catch {
            // chrome.runtime missing (test env) or messaging port closed; events are
            // fire-and-forget so dropping is acceptable.
        }
    };
    const isCsToolRequest = (m) => {
        if (m === null || typeof m !== 'object')
            return false;
        const r = m;
        return typeof r['tool'] === 'string';
    };
    const createCsDispatcher = (input = {}) => {
        const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const generateRequestId = input.generateRequestId ?? safeUuid;
        const forwardEventToSw = input.forwardEventToSw ?? defaultForwardEventToSw;
        const pending = new Map();
        const finish = (requestId, response) => {
            const entry = pending.get(requestId);
            if (!entry)
                return;
            pending.delete(requestId);
            clearTimeout(entry.timeoutHandle);
            try {
                entry.sendResponse(response);
            }
            catch {
                // sendResponse throws if the SW message channel was closed; safe to ignore.
            }
        };
        const handleSwRequest = (req, sendResponse) => {
            const requestId = generateRequestId();
            const envelope = encodeRequest({
                requestId,
                tool: req.tool,
                payload: req.payload,
            });
            const timeoutHandle = setTimeout(() => {
                finish(requestId, {
                    error: {
                        message: `page-bridge timeout after ${timeoutMs}ms (tool=${req.tool})`,
                    },
                });
            }, timeoutMs);
            pending.set(requestId, { sendResponse, timeoutHandle });
            window.postMessage(envelope, window.location.origin);
        };
        const handlePageMessage = (event) => {
            if (isInboundPageToCs(event)) {
                const env = event.data;
                const response = {};
                if (env.payload !== undefined) {
                    response.payload = env.payload;
                }
                if (env.error !== undefined) {
                    response.error = env.error;
                }
                finish(env.requestId, response);
                return;
            }
            if (isInboundPageEvent(event)) {
                const env = event.data;
                forwardEventToSw({ tag: PAGE_EVENT_SW_TAG, event: env.event });
            }
        };
        const dispose = () => {
            for (const entry of pending.values()) {
                clearTimeout(entry.timeoutHandle);
            }
            pending.clear();
        };
        return Object.freeze({ handleSwRequest, handlePageMessage, dispose });
    };

    const NOOP_DISPOSER = () => { };
    const installCsLifecycleCapture = (input) => {
        if (typeof window === 'undefined') {
            return NOOP_DISPOSER;
        }
        const { frame, send, opts } = input;
        if (opts?.enabled?.pagehide === false) {
            return NOOP_DISPOSER;
        }
        let disposed = false;
        const onPagehide = (e) => {
            if (disposed)
                return;
            const persisted = e.persisted ?? false;
            const event = Object.freeze({
                kind: 'lifecycle',
                source: 'cs',
                subkind: 'pagehide',
                persisted,
                ts: Date.now(),
                frameUrl: frame.frameUrl,
                frameKey: frame.frameKey,
                ...(frame.isCrossOrigin !== undefined ? { isCrossOrigin: frame.isCrossOrigin } : {}),
            });
            try {
                send(event);
            }
            catch {
                // CS-side send failures must never break the page.
            }
        };
        window.addEventListener('pagehide', onPagehide);
        return () => {
            if (disposed)
                return;
            disposed = true;
            window.removeEventListener('pagehide', onPagehide);
        };
    };

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

    const bootstrap = () => {
        const dispatcher = createCsDispatcher();
        chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
            if (!isCsToolRequest(msg))
                return false;
            dispatcher.handleSwRequest(msg, sendResponse);
            return true;
        });
        window.addEventListener('message', (event) => {
            dispatcher.handlePageMessage(event);
        });
        const frame = computeFrameMeta();
        const sendLifecycle = (event) => {
            try {
                chrome.runtime.sendMessage({ tag: PAGE_EVENT_SW_TAG, event });
            }
            catch {
                // Page may be tearing down; sendMessage failure is expected on the
                // very last tick. The event is already best-effort.
            }
        };
        installCsLifecycleCapture({ frame, send: sendLifecycle });
        console.log('[pwa-debug/cs] attached at', location.href);
    };
    bootstrap();

    exports.bootstrap = bootstrap;

    return exports;

})({});
//# sourceMappingURL=content-script.js.map
