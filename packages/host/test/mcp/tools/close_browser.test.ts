import { describe, it, expect } from 'vitest';
import {
  closeBrowserCore,
  type CloseBrowserDeps,
} from '../../../src/mcp/tools/close_browser.js';
import type { LaunchRecord } from '../../../src/browser_launch/registry.js';
import type { TerminateOutcome } from '../../../src/browser_launch/node_deps.js';

const rec = (over: Partial<LaunchRecord> = {}): LaunchRecord =>
  Object.freeze({
    browser: 'brave',
    profileType: 'sandbox-persistent',
    port: 9222,
    pid: 1234,
    browserUrl: 'http://127.0.0.1:9222',
    userDataDir: '/h/.pwa-debug/profiles/brave',
    launchedAt: 1,
    ...over,
  });

const makeDeps = (opts: {
  launches: LaunchRecord[];
  outcome?: TerminateOutcome;
}): CloseBrowserDeps & {
  terminated: LaunchRecord[];
  discarded: string[];
  removed: number[];
} => {
  const terminated: LaunchRecord[] = [];
  const discarded: string[] = [];
  const removed: number[] = [];
  return {
    terminated,
    discarded,
    removed,
    listLaunches: () => opts.launches,
    terminate: async (r) => {
      terminated.push(r);
      return opts.outcome ?? { closed: true, method: 'cdp' };
    },
    discardProfile: (dir) => {
      discarded.push(dir);
      return true;
    },
    removeFromRegistry: (port) => {
      removed.push(port);
    },
  };
};

describe('closeBrowserCore', () => {
  it('errors with no effects when no managed launch matches', async () => {
    const deps = makeDeps({ launches: [rec()] });
    const res = await closeBrowserCore({}, deps); // empty target
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only acts on browsers pwa-debug launched/);
    expect(deps.terminated).toHaveLength(0);
    expect(deps.removed).toHaveLength(0);
  });

  it('terminates a spawned sandbox launch and removes it from the registry', async () => {
    const deps = makeDeps({ launches: [rec()] });
    const res = await closeBrowserCore({ port: 9222 }, deps);
    expect(res.ok).toBe(true);
    expect(deps.terminated.map((r) => r.port)).toEqual([9222]);
    expect(deps.removed).toEqual([9222]);
    expect(deps.discarded).toEqual([]); // persist by default
  });

  it("session 'discard' deletes the sandbox profile dir after terminate", async () => {
    const deps = makeDeps({ launches: [rec()] });
    await closeBrowserCore({ port: 9222, session: 'discard' }, deps);
    expect(deps.discarded).toEqual(['/h/.pwa-debug/profiles/brave']);
    expect(deps.removed).toEqual([9222]);
  });

  it('reports profileDiscarded:false + a next_step when the dir survives the discard', async () => {
    const deps: CloseBrowserDeps = {
      listLaunches: () => [rec()],
      terminate: async () => ({ closed: true, method: 'cdp' }),
      discardProfile: async () => false, // browser still flushing → dir not gone
      removeFromRegistry: () => {},
    };
    const res = await closeBrowserCore({ port: 9222, session: 'discard' }, deps);
    expect(res.ok).toBe(true);
    const data = res.data as {
      closed: Array<{ profileDiscarded?: boolean }>;
    };
    expect(data.closed[0]!.profileDiscarded).toBe(false);
    expect(res.next_steps.join(' ')).toMatch(/could not be fully removed/);
  });

  it('an attached launch (pid null) is detached — never terminated, profile kept', async () => {
    const deps = makeDeps({ launches: [rec({ pid: null })] });
    const res = await closeBrowserCore({ all: true, session: 'discard' }, deps);
    expect(res.ok).toBe(true);
    expect(deps.terminated).toHaveLength(0); // never killed
    expect(deps.discarded).toHaveLength(0);
    expect(deps.removed).toEqual([9222]); // dropped from registry
    const data = res.data as { closed: Array<{ action: string }> };
    expect(data.closed[0]!.action).toBe('detached');
  });

  it('does not remove or discard when terminate fails', async () => {
    const deps = makeDeps({
      launches: [rec()],
      outcome: { closed: false, method: 'failed' },
    });
    const res = await closeBrowserCore({ port: 9222, session: 'discard' }, deps);
    expect(res.ok).toBe(true); // per-entry reporting; overall ok
    expect(deps.removed).toEqual([]);
    expect(deps.discarded).toEqual([]);
    expect(res.next_steps.join(' ')).toMatch(/Could not confirm shutdown/);
  });
});
