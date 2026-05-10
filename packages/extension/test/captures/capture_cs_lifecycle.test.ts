import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installCsLifecycleCapture } from '../../src/captures/capture_cs_lifecycle.js';
import type { FrameMeta } from '../../src/captures/capture_console.js';
import type { LifecycleCapturedEvent } from '../../src/captures/types.js';

const FRAME: FrameMeta = {
  frameUrl: 'https://test.example/page',
  frameKey: 'top',
};

const firePagehide = (persisted: boolean): void => {
  const evt = new Event('pagehide') as Event & { persisted?: boolean };
  Object.defineProperty(evt, 'persisted', { value: persisted, configurable: true });
  window.dispatchEvent(evt);
};

let captured: LifecycleCapturedEvent[];
let send: (event: LifecycleCapturedEvent) => void;

beforeEach(() => {
  captured = [];
  send = (event) => {
    captured.push(event);
  };
});

afterEach(() => {
  // jsdom carries listeners across tests; nothing else to clean up since
  // each test installs a fresh listener and disposes it.
});

describe('installCsLifecycleCapture — pagehide', () => {
  it('emits a CS-source pagehide event with persisted bit + frame metadata', () => {
    const dispose = installCsLifecycleCapture({ frame: FRAME, send });
    firePagehide(false);
    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    expect(ev.kind).toBe('lifecycle');
    expect(ev.source).toBe('cs');
    expect(ev.subkind).toBe('pagehide');
    expect((ev as { persisted: boolean }).persisted).toBe(false);
    expect(ev.frameUrl).toBe(FRAME.frameUrl);
    expect(ev.frameKey).toBe(FRAME.frameKey);
    expect(typeof ev.ts).toBe('number');
    dispose();
  });

  it('captures persisted=true when PageTransitionEvent.persisted is true', () => {
    const dispose = installCsLifecycleCapture({ frame: FRAME, send });
    firePagehide(true);
    expect((captured[0] as { persisted: boolean }).persisted).toBe(true);
    dispose();
  });
});

describe('installCsLifecycleCapture — disposer', () => {
  it('removes the listener — second pagehide after dispose does not fire send', () => {
    const dispose = installCsLifecycleCapture({ frame: FRAME, send });
    firePagehide(false);
    expect(captured).toHaveLength(1);
    dispose();
    firePagehide(false);
    expect(captured).toHaveLength(1);
  });

  it('disposer is idempotent — calling twice does not throw', () => {
    const dispose = installCsLifecycleCapture({ frame: FRAME, send });
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
  });
});

describe('installCsLifecycleCapture — failure isolation', () => {
  it('send-callback throws — install + listener do not propagate (page must not break)', () => {
    const throwingSend = vi.fn(() => {
      throw new Error('host disconnected mid-pagehide');
    });
    const dispose = installCsLifecycleCapture({ frame: FRAME, send: throwingSend });
    expect(() => firePagehide(false)).not.toThrow();
    expect(throwingSend).toHaveBeenCalledOnce();
    dispose();
  });
});

describe('installCsLifecycleCapture — opts.enabled', () => {
  it('opts.enabled.pagehide=false skips listener install', () => {
    const dispose = installCsLifecycleCapture({
      frame: FRAME,
      send,
      opts: { enabled: { pagehide: false } },
    });
    firePagehide(false);
    expect(captured).toHaveLength(0);
    dispose();
  });

  it('opts.enabled.pagehide=true installs listener (explicit opt-in matches default)', () => {
    const dispose = installCsLifecycleCapture({
      frame: FRAME,
      send,
      opts: { enabled: { pagehide: true } },
    });
    firePagehide(false);
    expect(captured).toHaveLength(1);
    dispose();
  });
});
