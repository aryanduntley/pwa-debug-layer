import { serializeArgs } from './serialize.js';
import { isInternalLog, stripExtensionFrames } from './filter.js';
import type { ConsoleCapturedEvent, ConsoleLevel } from './types.js';

export type Disposer = () => void;

export type FrameMeta = {
  readonly frameUrl: string;
  readonly frameKey: string;
};

export type ConsoleCaptureOptions = {
  readonly maxBytes?: number;
  readonly captureStackFor?: readonly ConsoleLevel[];
  readonly now?: () => number;
};

const ALL_LEVELS: readonly ConsoleLevel[] = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
];

const DEFAULT_STACK_LEVELS: readonly ConsoleLevel[] = ['warn', 'error', 'trace'];

const captureStack = (): string | undefined => {
  const stack = new Error().stack;
  if (stack === undefined) return undefined;
  return stripExtensionFrames(stack);
};

export const buildConsoleEvent = (
  level: ConsoleLevel,
  args: readonly unknown[],
  frame: FrameMeta,
  opts: {
    readonly ts: number;
    readonly maxBytes?: number;
    readonly captureStackFor: readonly ConsoleLevel[];
  },
): ConsoleCapturedEvent => {
  const { serialized } = serializeArgs(
    args,
    opts.maxBytes === undefined ? undefined : { maxBytes: opts.maxBytes },
  );
  const wantStack = opts.captureStackFor.includes(level);
  const stack = wantStack ? captureStack() : undefined;
  const base = {
    kind: 'console' as const,
    ts: opts.ts,
    frameUrl: frame.frameUrl,
    frameKey: frame.frameKey,
    level,
    args: serialized,
  };
  return Object.freeze(stack === undefined ? base : { ...base, stack });
};

export const installConsoleCapture = (
  emit: (event: ConsoleCapturedEvent) => void,
  frame: FrameMeta,
  opts?: ConsoleCaptureOptions,
): Disposer => {
  const captureStackFor = opts?.captureStackFor ?? DEFAULT_STACK_LEVELS;
  const maxBytes = opts?.maxBytes;
  const now = opts?.now ?? (() => Date.now());

  type ConsoleMethod = (...args: unknown[]) => void;
  const originals = new Map<ConsoleLevel, ConsoleMethod>();
  for (const level of ALL_LEVELS) {
    const original = console[level] as ConsoleMethod;
    if (typeof original !== 'function') continue;
    originals.set(level, original);
    console[level] = ((...args: unknown[]) => {
      try {
        original.apply(console, args);
      } finally {
        if (isInternalLog(args)) return;
        try {
          const opts =
            maxBytes === undefined
              ? { ts: now(), captureStackFor }
              : { ts: now(), maxBytes, captureStackFor };
          emit(buildConsoleEvent(level, args, frame, opts));
        } catch {
          // Capture failure must never break the page's console call.
        }
      }
    }) as Console[typeof level];
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const [level, original] of originals) {
      console[level] = original as Console[typeof level];
    }
  };
};
