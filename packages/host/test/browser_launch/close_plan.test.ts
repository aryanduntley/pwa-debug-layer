import { describe, it, expect } from 'vitest';
import { planClose } from '../../src/browser_launch/close_plan.js';
import { removeLaunch, type LaunchRecord } from '../../src/browser_launch/registry.js';

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

describe('planClose — target matching', () => {
  it('matches nothing when the target is empty (closing requires intent)', () => {
    expect(planClose([rec()], {}, 'persist')).toEqual([]);
  });

  it('all:true matches every record', () => {
    const recs = [rec({ port: 9222 }), rec({ port: 9333, browser: 'chrome' })];
    expect(planClose(recs, { all: true }, 'persist')).toHaveLength(2);
  });

  it('AND-matches provided selectors', () => {
    const recs = [
      rec({ port: 9222, browser: 'brave' }),
      rec({ port: 9333, browser: 'chrome' }),
    ];
    expect(
      planClose(recs, { browser: 'brave' }, 'persist').map((p) => p.record.port),
    ).toEqual([9222]);
    expect(
      planClose(recs, { port: 9333 }, 'persist').map((p) => p.record.browser),
    ).toEqual(['chrome']);
    // browser + port that don't co-occur → no match
    expect(planClose(recs, { browser: 'brave', port: 9333 }, 'persist')).toEqual(
      [],
    );
  });
});

describe('planClose — safety model', () => {
  it('attached launch (pid null) is detach-only, never terminated', () => {
    const [p] = planClose([rec({ pid: null })], { all: true }, 'discard');
    expect(p!.action).toBe('detach');
    expect(p!.discardProfile).toBe(false);
    expect(p!.note).toMatch(/attached/);
  });

  it("session 'detach' drops the record without terminating", () => {
    const [p] = planClose([rec()], { all: true }, 'detach');
    expect(p!.action).toBe('detach');
    expect(p!.discardProfile).toBe(false);
    expect(p!.note).toBeUndefined();
  });

  it("session 'discard' removes a sandbox profile", () => {
    const [p] = planClose(
      [rec({ profileType: 'sandbox-temp' })],
      { all: true },
      'discard',
    );
    expect(p!.action).toBe('terminate');
    expect(p!.discardProfile).toBe(true);
  });

  it("session 'discard' is downgraded for an existing profile (never delete user data)", () => {
    const [p] = planClose(
      [rec({ profileType: 'existing' })],
      { all: true },
      'discard',
    );
    expect(p!.action).toBe('terminate');
    expect(p!.discardProfile).toBe(false);
    expect(p!.note).toMatch(/discard.*ignored/i);
  });

  it("default 'persist' terminates without discarding", () => {
    const [p] = planClose([rec()], { all: true }, 'persist');
    expect(p!.action).toBe('terminate');
    expect(p!.discardProfile).toBe(false);
    expect(p!.note).toBeUndefined();
  });
});

describe('removeLaunch', () => {
  it('drops the record on the given port, keeps others', () => {
    const recs = [rec({ port: 9222 }), rec({ port: 9333 })];
    expect(removeLaunch(recs, 9222).map((r) => r.port)).toEqual([9333]);
  });

  it('is a no-op when the port is absent', () => {
    expect(removeLaunch([rec({ port: 9222 })], 9999)).toHaveLength(1);
  });
});
