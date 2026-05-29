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

import { buildPageError, describeThrown } from './capture_errors.js';
import type { Disposer, FrameMeta } from './capture_console.js';
import type { PageErrorCapturedEvent } from './types.js';

export type WalletCaptureOptions = {
  readonly now?: () => number;
};

const METHOD_CAP = 80;

const requestMethod = (args: readonly unknown[]): string => {
  const a0 = args[0];
  if (
    a0 !== null &&
    typeof a0 === 'object' &&
    typeof (a0 as { method?: unknown }).method === 'string'
  ) {
    return (a0 as { method: string }).method.slice(0, METHOD_CAP);
  }
  return 'request';
};

export const installWalletCapture = (
  emit: (event: PageErrorCapturedEvent) => void,
  frame: FrameMeta,
  opts?: WalletCaptureOptions,
): Disposer => {
  if (typeof window === 'undefined') return () => {};
  const now = opts?.now ?? ((): number => Date.now());

  const wrapped = new WeakSet<object>();
  const restorers: Array<() => void> = [];

  const tryEmit = (event: PageErrorCapturedEvent): void => {
    try {
      emit(event);
    } catch {
      // Capture failure must never affect the wallet/app.
    }
  };

  const emitRejection = (method: string, err: unknown): void => {
    const info = describeThrown(err);
    const code =
      err !== null && typeof err === 'object' && 'code' in err
        ? (err as { code: unknown }).code
        : undefined;
    const codeStr =
      typeof code === 'number' || typeof code === 'string' ? ` (code ${code})` : '';
    tryEmit(
      buildPageError(
        'wallet_rejection',
        {
          message: `${method} rejected${codeStr}: ${info.message}`,
          ...(info.name !== undefined ? { name: info.name } : {}),
          ...(info.stack !== undefined ? { stack: info.stack } : {}),
        },
        frame,
        now,
      ),
    );
  };

  const wrapProvider = (provider: unknown): void => {
    if (provider === null || typeof provider !== 'object') return;
    if (wrapped.has(provider)) return;
    const p = provider as Record<string, unknown>;
    const original = p.request;
    if (typeof original !== 'function') return;
    wrapped.add(provider);

    const call = (original as (...a: unknown[]) => unknown).bind(provider);
    const patched = (...args: unknown[]): unknown => {
      const method = requestMethod(args);
      let result: unknown;
      try {
        result = call(...args);
      } catch (e) {
        emitRejection(method, e);
        throw e;
      }
      if (
        result === null ||
        typeof (result as { then?: unknown } | null)?.then !== 'function'
      ) {
        return result;
      }
      return Promise.resolve(result as Promise<unknown>).catch((e: unknown) => {
        emitRejection(method, e);
        throw e;
      });
    };

    try {
      p.request = patched;
      restorers.push(() => {
        try {
          p.request = original;
        } catch {
          // ignore
        }
      });
    } catch {
      // request is a non-writable/getter property; cannot wrap — skip.
      wrapped.delete(provider);
      return;
    }

    // Multi-wallet aggregation exposes sub-providers under .providers[].
    const subs = p.providers;
    if (Array.isArray(subs)) {
      for (const sub of subs) wrapProvider(sub);
    }
  };

  // 1) Wrap whatever is present now.
  const initial = (window as unknown as { ethereum?: unknown }).ethereum;
  wrapProvider(initial);

  // 2) EIP-6963: wrap every announced provider (sync or async).
  const onAnnounce = (event: Event): void => {
    const detail = (event as CustomEvent).detail as { provider?: unknown } | undefined;
    if (detail?.provider !== undefined) wrapProvider(detail.provider);
  };
  let announceAdded = false;
  try {
    window.addEventListener(
      'eip6963:announceProvider',
      onAnnounce as EventListener,
    );
    announceAdded = true;
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch {
    // No CustomEvent/dispatch in this environment; rely on the direct wrap.
  }

  // 3) Late injection: trap assignment to window.ethereum so a provider set
  // after our script still gets wrapped. Guarded — some wallets define the
  // property non-configurable, in which case we keep the initial + 6963 paths.
  let trapped = false;
  let stored: unknown = initial;
  try {
    const desc = Object.getOwnPropertyDescriptor(window, 'ethereum');
    if (desc === undefined || desc.configurable === true) {
      Object.defineProperty(window, 'ethereum', {
        configurable: true,
        enumerable: true,
        get: () => stored,
        set: (v: unknown) => {
          stored = v;
          wrapProvider(v);
        },
      });
      trapped = true;
    }
  } catch {
    // Leave window.ethereum as-is.
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (announceAdded) {
      try {
        window.removeEventListener(
          'eip6963:announceProvider',
          onAnnounce as EventListener,
        );
      } catch {
        // ignore
      }
    }
    for (const restore of restorers) restore();
    if (trapped) {
      try {
        Object.defineProperty(window, 'ethereum', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: stored,
        });
      } catch {
        // ignore
      }
    }
  };
};
