// Page-error producer. Hooks window 'error' (ErrorEvent / window.onerror) and
// 'unhandledrejection' (PromiseRejectionEvent) and emits a PageErrorCapturedEvent
// per uncaught failure. App- and framework-agnostic: surfaces thrown errors and
// rejected promises that BUBBLE (including wallet/connect rejections the app
// lets through) so the AI sees them without the app having to log anything.
// Errors the app fully catches do not surface here — that is expected; a
// library-aware hook (Path 6 WC task) covers swallowed wallet rejections.

import { stripExtensionFrames } from './filter.js';
import type { Disposer, FrameMeta } from './capture_console.js';
import type { PageErrorCapturedEvent } from './types.js';

const MESSAGE_CAP = 4000;

export type ErrorCaptureOptions = {
  readonly now?: () => number;
};

export type ErrorInfo = {
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
};

const capMessage = (s: string): string =>
  s.length > MESSAGE_CAP ? s.slice(0, MESSAGE_CAP) : s;

// Extract a readable {message, name?, stack?} from any thrown/rejected value:
// Error instances, strings, structured objects (message/reason/msg), else JSON.
// Exported for reuse by the wallet-rejection producer.
export const describeThrown = (value: unknown): ErrorInfo => {
  if (value instanceof Error) {
    const stack = value.stack;
    return {
      message: value.message !== '' ? value.message : value.name,
      name: value.name,
      ...(stack !== undefined ? { stack: stripExtensionFrames(stack) } : {}),
    };
  }
  if (typeof value === 'string') return { message: value };
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['message', 'reason', 'msg']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim() !== '') return { message: v };
    }
    try {
      return { message: JSON.stringify(value) };
    } catch {
      return { message: String(value) };
    }
  }
  return { message: String(value) };
};

// Build a frozen PageErrorCapturedEvent. Exported so the wallet-rejection
// producer emits into the same page_error stream without duplicating shape.
export const buildPageError = (
  subkind: PageErrorCapturedEvent['subkind'],
  info: ErrorInfo,
  frame: FrameMeta,
  now: () => number,
  source?: string,
): PageErrorCapturedEvent =>
  Object.freeze({
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
  }) as PageErrorCapturedEvent;

export const installErrorCapture = (
  emit: (event: PageErrorCapturedEvent) => void,
  frame: FrameMeta,
  opts?: ErrorCaptureOptions,
): Disposer => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const now = opts?.now ?? ((): number => Date.now());

  const make = (
    subkind: PageErrorCapturedEvent['subkind'],
    info: ErrorInfo,
    source?: string,
  ): PageErrorCapturedEvent => buildPageError(subkind, info, frame, now, source);

  const tryEmit = (event: PageErrorCapturedEvent): void => {
    try {
      emit(event);
    } catch {
      // Capture failure must never affect the page's own error handling.
    }
  };

  const onError = (event: Event): void => {
    const e = event as ErrorEvent;
    // Prefer the real Error object (carries name + stack); fall back to message.
    const info =
      e.error instanceof Error
        ? describeThrown(e.error)
        : { message: typeof e.message === 'string' && e.message !== '' ? e.message : 'Uncaught error' };
    const filename = typeof e.filename === 'string' && e.filename !== '' ? e.filename : undefined;
    const source =
      filename !== undefined
        ? `${filename}:${e.lineno ?? 0}:${e.colno ?? 0}`
        : undefined;
    tryEmit(make('error', info, source));
  };

  const onRejection = (event: Event): void => {
    const e = event as PromiseRejectionEvent;
    tryEmit(make('unhandledrejection', describeThrown(e.reason)));
  };

  // Bubble phase: capture script errors + unhandled rejections (not resource
  // load errors, which only fire in the capture phase and are page noise).
  window.addEventListener('error', onError, false);
  window.addEventListener('unhandledrejection', onRejection, false);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('error', onError, false);
    window.removeEventListener('unhandledrejection', onRejection, false);
  };
};
