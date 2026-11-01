import {
  installConsoleCapture,
  type Disposer,
  type FrameMeta,
} from '../captures/capture_console.js';
import { installFetchCapture } from '../captures/capture_fetch.js';
import { installXhrCapture } from '../captures/capture_xhr.js';
import { installWebSocketCapture } from '../captures/capture_websocket.js';
import { installDomMutationCapture } from '../captures/capture_dom_mutation.js';
import { installLifecycleCapture } from '../captures/capture_lifecycle.js';
import { installPopupCapture } from '../captures/capture_popup.js';
import { installErrorCapture } from '../captures/capture_errors.js';
import { installWalletCapture } from '../captures/capture_wallet.js';
import { installSwStateCapture } from '../captures/capture_sw_state.js';
import type { CapturedEvent } from '../captures/types.js';
import { computeFrameMeta } from '../frame_meta/frame_meta.js';
import {
  installZustandDevtoolsShim,
  type ZustandDevtoolsShim,
} from '../stores/zustand/devtools_shim.js';
import { setZustandShim } from '../page_bridge/page_dispatch.js';

/**
 * Window flag set by the extension page-world entry. The CDP entry reads it so
 * it never installs a second capture set into a page the extension owns.
 */
export const EXTENSION_PAGE_WORLD_GUARD = '__pwaDebugPageWorldInstalled';

/** Which capture producers this runtime supports. */
export type CaptureKinds = {
  readonly console: boolean;
  readonly fetch: boolean;
  readonly xhr: boolean;
  readonly websocket: boolean;
  readonly dom_mutation: boolean;
  readonly lifecycle: boolean;
  readonly library_popup: boolean;
  readonly page_error: boolean;
  readonly sw_state: boolean;
};

export type PageWorldBootOptions = {
  /** Where captured events go (postMessage to the CS, or a CDP binding). */
  readonly emit: (event: CapturedEvent) => void;
  /** Makes dispatchPageRequest reachable (window listener, or a page global). */
  readonly installRequestChannel: () => void;
  /** false skips the capture producers (another page-world already owns them). */
  readonly captures?: boolean;
};

export type PageWorldBootResult = {
  readonly kinds: CaptureKinds | null;
  readonly dispose: Disposer;
};

type FrameworkHookProbe = {
  readonly react: boolean;
  readonly vue: boolean;
  readonly svelte: boolean;
  readonly redux: boolean;
};

const probeGlobals = (): FrameworkHookProbe => {
  const w = window as unknown as Record<string, unknown>;
  return {
    react: '__REACT_DEVTOOLS_GLOBAL_HOOK__' in w,
    vue: '__VUE_DEVTOOLS_GLOBAL_HOOK__' in w,
    svelte: '__svelte' in w,
    redux: '__REDUX_DEVTOOLS_EXTENSION__' in w,
  };
};

const probeDom = (): Pick<FrameworkHookProbe, 'react' | 'vue' | 'svelte'> => {
  let react = false;
  let vue = false;
  let svelte = false;
  const root = document.body ?? document.documentElement;
  if (!root) return { react, vue, svelte };
  const sample: Element[] = [root];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let count = 0;
  while (walker.nextNode() && count < 100) {
    sample.push(walker.currentNode as Element);
    count += 1;
  }
  for (const el of sample) {
    if (react && vue && svelte) break;
    const keys = Object.keys(el);
    if (
      !react &&
      keys.some(
        (k) =>
          k.startsWith('__reactFiber$') ||
          k.startsWith('__reactContainer$') ||
          k.startsWith('__reactProps$'),
      )
    ) {
      react = true;
    }
    if (
      !vue &&
      ('__vue__' in el ||
        '__vue_app__' in el ||
        keys.some((k) => k === '_vnode' || k.startsWith('__vnode')))
    ) {
      vue = true;
    }
    if (!svelte && keys.some((k) => k.startsWith('__svelte'))) {
      svelte = true;
    }
  }
  return { react, vue, svelte };
};

const merge = (
  early: FrameworkHookProbe,
  dom: Pick<FrameworkHookProbe, 'react' | 'vue' | 'svelte'>,
): FrameworkHookProbe => ({
  react: early.react || dom.react,
  vue: early.vue || dom.vue,
  svelte: early.svelte || dom.svelte,
  redux: early.redux,
});

const detectKinds = (): CaptureKinds => ({
  console: typeof console !== 'undefined',
  fetch: typeof globalThis.fetch === 'function',
  xhr: typeof globalThis.XMLHttpRequest === 'function',
  websocket: typeof globalThis.WebSocket === 'function',
  dom_mutation:
    typeof MutationObserver !== 'undefined' && typeof document !== 'undefined',
  lifecycle:
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof history?.pushState === 'function',
  library_popup:
    typeof MutationObserver !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof Element !== 'undefined',
  page_error:
    typeof window !== 'undefined' && typeof window.addEventListener === 'function',
  sw_state:
    typeof navigator !== 'undefined' && navigator.serviceWorker !== undefined,
});

const installCaptures = (
  emit: (event: CapturedEvent) => void,
  frame: FrameMeta,
): { readonly dispose: Disposer; readonly kinds: CaptureKinds } => {
  const kinds = detectKinds();
  const disposers: Disposer[] = [
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
  const dispose: Disposer = () => {
    for (const d of disposers) d();
  };
  return { dispose, kinds };
};

const NOOP: Disposer = () => undefined;

/**
 * Start the page world. Transport-specific concerns (idempotency guard, how
 * events leave, how requests arrive) belong to the entry point that calls this.
 */
export const bootPageWorld = (opts: PageWorldBootOptions): PageWorldBootResult => {
  // Redux store capture is PASSIVE — read-only react-redux fiber-context
  // discovery (see stores/redux/discover); we do not impersonate
  // __REDUX_DEVTOOLS_EXTENSION_COMPOSE__ (that broke RTK apps).
  //
  // Zustand's devtools middleware calls __REDUX_DEVTOOLS_EXTENSION__.connect(...).
  // With no real devtools present the shim installs a benign callable carrier
  // that provides `.connect` (and no-ops if the real Redux DevTools owns it).
  const zustandShim: ZustandDevtoolsShim = installZustandDevtoolsShim(
    window as unknown as Parameters<typeof installZustandDevtoolsShim>[0],
  );
  setZustandShim(zustandShim);

  opts.installRequestChannel();

  const frame = computeFrameMeta();
  const installed = opts.captures === false ? null : installCaptures(opts.emit, frame);
  console.log('[pwa-debug/page] captures', installed ? 'installed' : 'skipped', {
    frame,
    kinds: installed?.kinds ?? null,
  });

  const early = probeGlobals();
  console.log('[pwa-debug/page] world=MAIN, hooks(early)=', early);
  const reportLate = (): void => {
    console.log('[pwa-debug/page] hooks(post-load)=', merge(early, probeDom()));
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reportLate, { once: true });
  } else {
    setTimeout(reportLate, 0);
  }

  return Object.freeze({
    kinds: installed?.kinds ?? null,
    dispose: installed?.dispose ?? NOOP,
  });
};
