import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildConsoleEvent,
  installConsoleCapture,
  type FrameMeta,
} from '../../src/captures/capture_console.js';
import type { ConsoleCapturedEvent } from '../../src/captures/types.js';

const FRAME: FrameMeta = {
  frameUrl: 'https://example.com/x',
  frameKey: 'top',
};

describe('buildConsoleEvent', () => {
  it('produces a frozen event with serialized args', () => {
    const evt = buildConsoleEvent('log', ['hi', { x: 1 }], FRAME, {
      ts: 1000,
      captureStackFor: [],
    });
    expect(evt.kind).toBe('console');
    expect(evt.level).toBe('log');
    expect(evt.ts).toBe(1000);
    expect(evt.frameUrl).toBe(FRAME.frameUrl);
    expect(evt.frameKey).toBe(FRAME.frameKey);
    expect(evt.args).toEqual(['hi', { x: 1 }]);
    expect(evt.stack).toBeUndefined();
    expect(Object.isFrozen(evt)).toBe(true);
  });

  it('attaches stack only when level is in captureStackFor', () => {
    const withStack = buildConsoleEvent('error', ['boom'], FRAME, {
      ts: 1,
      captureStackFor: ['error'],
    });
    expect(typeof withStack.stack).toBe('string');

    const withoutStack = buildConsoleEvent('log', ['hi'], FRAME, {
      ts: 1,
      captureStackFor: ['error'],
    });
    expect(withoutStack.stack).toBeUndefined();
  });

  it('serializes cyclic args without throwing', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    const evt = buildConsoleEvent('log', [a], FRAME, {
      ts: 1,
      captureStackFor: [],
    });
    expect(evt.args[0]).toEqual({ self: { __type: 'Cycle' } });
  });
});

describe('installConsoleCapture', () => {
  let received: ConsoleCapturedEvent[];
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    received = [];
  });

  afterEach(() => {
    if (dispose) {
      dispose();
      dispose = undefined;
    }
  });

  it('captures every default console level (using buildConsoleEvent directly)', () => {
    // Avoids happy-dom's internal trace-calls-log behavior by exercising the
    // pure builder for each level.
    const frame = FRAME;
    const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
    const events = levels.map((level) =>
      buildConsoleEvent(level, ['x'], frame, {
        ts: 42,
        captureStackFor: [],
      }),
    );
    expect(events.map((e) => e.level)).toEqual([...levels]);
    expect(events.every((e) => e.ts === 42)).toBe(true);
  });

  it('end-to-end: console.log fires exactly one capture event', () => {
    dispose = installConsoleCapture((e) => received.push(e), FRAME, {
      now: () => 7,
    });
    console.log('hello', { x: 1 });
    expect(received).toHaveLength(1);
    expect(received[0]?.level).toBe('log');
    expect(received[0]?.ts).toBe(7);
    expect(received[0]?.args).toEqual(['hello', { x: 1 }]);
  });

  it('default-attaches stack for warn/error and not for log/info/debug', () => {
    dispose = installConsoleCapture((e) => received.push(e), FRAME);
    console.log('a');
    console.warn('b');
    console.error('c');
    console.debug('d');
    // Filter to events we care about (happy-dom's trace implementation may
    // internally call console.log; ignore extras for this assertion).
    const wantLevels = new Set(['log', 'warn', 'error', 'debug']);
    const byLevel = Object.fromEntries(
      received
        .filter((e) => wantLevels.has(e.level))
        .map((e) => [e.level, e.stack]),
    );
    expect(byLevel['log']).toBeUndefined();
    expect(byLevel['debug']).toBeUndefined();
    expect(typeof byLevel['warn']).toBe('string');
    expect(typeof byLevel['error']).toBe('string');
  });

  it('preserves the original console behavior (calls through)', () => {
    const originalLog = console.log;
    const calls: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };
    const probeLog = console.log;
    dispose = installConsoleCapture((e) => received.push(e), FRAME);
    console.log('hello');
    expect(calls).toEqual([['hello']]);
    dispose();
    expect(console.log).toBe(probeLog);
    console.log = originalLog;
    dispose = undefined;
  });

  it('disposer restores the originals and is idempotent', () => {
    const originalLog = console.log;
    dispose = installConsoleCapture((e) => received.push(e), FRAME);
    expect(console.log).not.toBe(originalLog);
    dispose();
    expect(console.log).toBe(originalLog);
    dispose();
    expect(console.log).toBe(originalLog);
    console.log('after-dispose');
    expect(received).toHaveLength(0);
  });

  it("emit failures don't break the page's console call", () => {
    const throwingEmit = () => {
      throw new Error('sink down');
    };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    dispose = installConsoleCapture(throwingEmit, FRAME);
    expect(() => console.log('hi')).not.toThrow();
    spy.mockRestore();
  });
});
