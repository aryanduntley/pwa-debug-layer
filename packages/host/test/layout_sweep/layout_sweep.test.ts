import { describe, expect, it, vi } from 'vitest';
import { planSweep, resolveChecksConfig, type LayoutMeasureRequest, type LayoutMeasureResult, type SweepPlan } from '@pwa-debug/shared';
import { classifySweepTarget, locateTabByNonce, type LiveLaunch } from '../../src/layout_sweep/target.js';
import {
  buildSweepResult,
  createSweepStore,
  newSweepJob,
  orderGroups,
  recordView,
} from '../../src/layout_sweep/jobs.js';
import { runSweep, type SweepRunInput } from '../../src/layout_sweep/runner.js';
import type { PageOps } from '../../src/layout_sweep/page_ops.js';
import type { CdpClient } from '../../src/cdp_client/types.js';
import type { CdpPageEndpoint } from '../../src/transport/cdp_transport.js';
import { layoutSweepCancel, layoutSweepStatus } from '../../src/mcp/tools/layout_sweep.js';

const endpoint = (over: Partial<CdpPageEndpoint> = {}): CdpPageEndpoint => ({
  connectionId: 'cdp:127.0.0.1:9222:abcd1234',
  baseUrl: 'http://127.0.0.1:9222',
  targetId: 'abcd1234ffff',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/abcd',
  url: 'https://x.test/',
  origin: 'desktop',
  ...over,
});

const launch = (over: Partial<LiveLaunch> = {}): LiveLaunch => ({
  browser: 'brave',
  profileType: 'sandbox-persistent',
  port: 9222,
  browserUrl: 'http://127.0.0.1:9222',
  live: true,
  ...over,
});

describe('classifySweepTarget', () => {
  it('accepts phones over adb whatever the launches', () => {
    const r = classifySweepTarget({ kind: 'cdp', extensionId: 'cdp:x' }, endpoint({ origin: 'android', baseUrl: 'http://127.0.0.1:40001' }), []);
    expect(r).toMatchObject({ ok: true, kind: 'phone' });
  });

  it('accepts a desktop CDP connection only on a live launched port', () => {
    expect(classifySweepTarget({ kind: 'cdp', extensionId: 'cdp:x' }, endpoint(), [launch()])).toMatchObject({ ok: true, kind: 'launched_cdp' });
    const r = classifySweepTarget({ kind: 'cdp', extensionId: 'cdp:x' }, endpoint(), [launch({ port: 9333, browserUrl: 'http://127.0.0.1:9333' })]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('did not launch') });
  });

  it('sends extension connections to the nonce search when a launch is live, refuses otherwise', () => {
    expect(classifySweepTarget({ kind: 'extension', extensionId: 'ext' }, undefined, [launch(), launch({ live: false, port: 9333 })])).toEqual({
      ok: true,
      kind: 'launched_extension',
      browserUrls: ['http://127.0.0.1:9222'],
    });
    const none = classifySweepTarget({ kind: 'extension', extensionId: 'ext' }, undefined, []);
    expect(none.ok).toBe(false);
    const portless = classifySweepTarget({ kind: 'extension', extensionId: 'ext' }, undefined, [launch({ live: false, browserUrl: null, profileType: 'existing' })]);
    expect(portless).toMatchObject({ ok: false, next_steps: expect.arrayContaining([expect.stringContaining('Chromium 136+')]) });
  });
});

describe('locateTabByNonce', () => {
  const t = (id: string) => ({ id, type: 'page', title: id, url: `https://x.test/${id}`, webSocketDebuggerUrl: `ws://h/${id}` });

  it('returns the single page carrying the nonce and always clears it', async () => {
    const clearNonce = vi.fn(async () => undefined);
    const r = await locateTabByNonce(
      {
        stampNonce: async () => undefined,
        clearNonce,
        listTargets: async () => [t('a'), t('b')],
        hasNonce: async (ws) => ws === 'ws://h/b',
      },
      ['http://127.0.0.1:9222'],
      'n1',
    );
    expect(r).toMatchObject({ ok: true, target: { id: 'b' } });
    expect(clearNonce).toHaveBeenCalled();
  });

  it('refuses when no page or several pages match', async () => {
    const base = { stampNonce: async () => undefined, clearNonce: async () => undefined, listTargets: async () => [t('a'), t('b')] };
    expect(await locateTabByNonce({ ...base, hasNonce: async () => false }, ['u'], 'n')).toMatchObject({ ok: false, error: expect.stringContaining('not found') });
    expect(await locateTabByNonce({ ...base, hasNonce: async () => true }, ['u'], 'n')).toMatchObject({ ok: false, error: expect.stringContaining('matched 2') });
  });
});

const view = { page: 'https://x.test/a.html', viewport: null, scheme: 'light' as const, state: '', dims: {}, label: 'a.html@device light' };

describe('jobs', () => {
  it('records views, groups findings and lists overflow first', () => {
    const job0 = newSweepJob({ job_id: 'j', connection_id: 'c', target: 'phone', planned_views: 2, caveats: [], report_path: '/r.json', now: 0 });
    const job1 = recordView(job0, view, [
      { check: 'tap_target', signature: 'a "Item 1"', message: 'small' },
      { check: 'tap_target', signature: 'a "Item 2"', message: 'small' },
      { check: 'page_overflow_x', signature: 'html', message: 'wide' },
    ], { duration_ms: 10 });
    const job2 = recordView(job1, { ...view, label: 'a.html@360 light' }, [], { duration_ms: 5, error: 'boom' });
    const r = buildSweepResult(job2, 100);
    expect(r).toMatchObject({ views: 2, failed_views: 1, view_errors: [{ label: 'a.html@360 light', error: 'boom' }], summary: { problems: 3, groups: 2 } });
    expect(r.groups.map((g) => g.check)).toEqual(['page_overflow_x', 'tap_target']);
    expect(orderGroups([]).length).toBe(0);
  });

  it('store tracks the active job per connection and cancel requests', () => {
    const store = createSweepStore();
    store.put(newSweepJob({ job_id: 'j1', connection_id: 'c', target: 'phone', planned_views: 1, caveats: [], report_path: '/r', now: 1 }));
    expect(store.activeFor('c')?.job_id).toBe('j1');
    expect(store.requestCancel('j1')).toBe(true);
    expect(store.isCancelled('j1')).toBe(true);
    expect(store.requestCancel('nope')).toBe(false);
  });
});

const fakeClient = () => {
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  const client: CdpClient = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, ...(params !== undefined ? { params } : {}) });
      return method === 'Page.captureScreenshot' ? { data: 'iVBORw0KGgo=' } : {};
    }),
    on: () => () => undefined,
    onClose: () => () => undefined,
    close: () => undefined,
    isOpen: () => true,
  };
  return { client, sent };
};

const measured = (findings: LayoutMeasureResult['findings']): LayoutMeasureResult => ({
  url: 'https://x.test/',
  viewport: { width: 360, height: 800 },
  scroll: { x: 0, y: 0 },
  findings,
  truncated: false,
});

const fakePage = (over: Partial<PageOps> = {}) => {
  const evaluated: string[] = [];
  const navigated: string[] = [];
  const page: PageOps = {
    navigate: async (url) => {
      navigated.push(url);
    },
    evaluate: async (expr) => {
      evaluated.push(expr);
      return expr.includes('data-state') ? ['open', 'closed'] : true;
    },
    measure: async (_req: LayoutMeasureRequest) => measured([{ check: 'tap_target', signature: 'a "Go"', message: 'small', rect: { x: 0, y: 0, width: 20, height: 20 } }]),
    freeze: async () => undefined,
    ping: async () => true,
    ...over,
  };
  return { page, evaluated, navigated };
};

const planFor = (over: Parameters<typeof planSweep>[0] extends infer P ? Partial<P> : never = {}): SweepPlan => {
  const r = planSweep({ target: 'phone', pages: ['https://x.test/a.html'], viewports: [{ width: 360 }, { width: 430 }], color_schemes: ['light'], ...over });
  if (!r.ok) throw new Error(r.error);
  return r.plan;
};

const runInput = (plan: SweepPlan, over: Partial<SweepRunInput> = {}): SweepRunInput => {
  const checks = resolveChecksConfig(undefined);
  if (!checks.ok) throw new Error('checks');
  return {
    job_id: 'j',
    plan,
    checks: checks.config,
    exempt_selectors: [],
    settle: { wait_ms: 0, freeze_animations: true },
    screenshots: 'none',
    view_timeout_ms: 1_000,
    start_url: 'https://x.test/start',
    device: { width: 412, height: 915 },
    ...over,
  };
};

const runWith = async (pageOver: Partial<PageOps>, plan: SweepPlan, inputOver: Partial<SweepRunInput> = {}, cancelAfter?: number) => {
  const store = createSweepStore();
  store.put(newSweepJob({ job_id: 'j', connection_id: 'c', target: 'phone', planned_views: plan.estimated_views, caveats: [], report_path: '/r', now: 0 }));
  const { client, sent } = fakeClient();
  const { page, evaluated, navigated } = fakePage(pageOver);
  let measures = 0;
  const wrapped: PageOps = {
    ...page,
    measure: async (req) => {
      measures += 1;
      if (cancelAfter !== undefined && measures >= cancelAfter) store.requestCancel('j');
      return page.measure(req);
    },
  };
  const writeReport = vi.fn(async () => undefined);
  await runSweep(
    {
      page: wrapped,
      cdp: client,
      store,
      errorsSince: () => [],
      writeScreenshot: async (_id, n) => `/shots/${n}.png`,
      writeReport,
      now: Date.now,
      sleep: async () => undefined,
    },
    runInput(plan, inputOver),
  );
  return { job: store.get('j')!, sent, evaluated, navigated, writeReport };
};

describe('runSweep', () => {
  it('emulates each viewport, applies hash states, measures, then restores', async () => {
    const plan = planFor({ states: { discover: "[...document.querySelectorAll('[data-state]')]", hash_template: '#s={state}' } });
    const { job, sent, evaluated, navigated, writeReport } = await runWith({}, plan);
    expect(job.status).toBe('done');
    expect(job.views_done).toBe(4);
    expect(job.planned_views).toBe(4);
    expect(job.findings).toHaveLength(4);
    const metrics = sent.filter((s) => s.method === 'Emulation.setDeviceMetricsOverride').map((s) => s.params?.['width']);
    expect(metrics).toEqual([360, 430]);
    expect(
      evaluated.filter((e) => e.includes('location.hash')).map((e) => /location\.hash = "([^"]+)"/.exec(e)?.[1]),
    ).toEqual(['#s=open', '#s=closed', '#s=open', '#s=closed']);
    expect(job.warnings).toEqual([]);
    expect(navigated).toEqual(['https://x.test/a.html', 'https://x.test/start']);
    expect(sent.map((s) => s.method)).toContain('Emulation.clearDeviceMetricsOverride');
    expect(writeReport).toHaveBeenCalled();
  });

  it('warns when the hash does not take (opaque URLs)', async () => {
    const plan = planFor({ states: { discover: "[...document.querySelectorAll('[data-state]')]", hash_template: '#s={state}' } });
    const { job } = await runWith(
      { evaluate: async (expr) => (expr.includes('data-state') ? ['open'] : expr.includes('location.hash') ? false : true) },
      plan,
    );
    expect(job.warnings).toEqual([expect.stringContaining('location.hash did not change')]);
  });

  it('records a failing view as an error and keeps going', async () => {
    let n = 0;
    const { job } = await runWith(
      {
        measure: async () => {
          n += 1;
          if (n <= 2) throw new Error('layout_measure: invalid CSS selector "[["');
          return measured([]);
        },
      },
      planFor(),
    );
    expect(job.status).toBe('done');
    expect(job.views.map((v) => v.error !== undefined)).toEqual([true, false]);
  });

  it('stops on cancel and ends interrupted when the connection disappears', async () => {
    const cancelled = await runWith({}, planFor({ pages: ['https://x.test/a', 'https://x.test/b'] }), {}, 1);
    expect(cancelled.job.status).toBe('cancelled');
    expect(cancelled.job.views_done).toBe(1);
    const gone = await runWith(
      { measure: async () => { throw new Error('no connected NMH for cdp:x'); } },
      planFor(),
    );
    expect(gone.job.status).toBe('interrupted');
    expect(gone.navigated).toEqual(['https://x.test/a.html']);
  });

  it('turns a hung view into a timeout finding', async () => {
    const { job } = await runWith({ measure: () => new Promise(() => undefined) }, planFor({ viewports: [{ width: 360 }] }), { view_timeout_ms: 20 });
    expect(job.findings).toEqual([expect.objectContaining({ check: 'timeout' })]);
  });

  it('takes one screenshot per new group', async () => {
    const { job, sent } = await runWith({}, planFor(), { screenshots: 'first_per_group' });
    expect(sent.filter((s) => s.method === 'Page.captureScreenshot')).toHaveLength(1);
    expect(Object.values(job.screenshots)).toEqual(['/shots/1.png']);
    expect(buildSweepResult(job, Date.now()).groups[0]?.screenshot).toBe('/shots/1.png');
  });
});

describe('status and cancel tools', () => {
  it('report missing jobs and finished jobs', () => {
    const store = createSweepStore();
    expect(layoutSweepStatus({}, { store, now: () => 0 }).ok).toBe(false);
    store.put(newSweepJob({ job_id: 'j', connection_id: 'c', target: 'phone', planned_views: 1, caveats: [], report_path: '/r', now: 0 }));
    const running = layoutSweepStatus({ job_id: 'j' }, { store, now: () => 5 });
    expect(running.next_steps[0]).toContain('Running');
    expect(layoutSweepCancel({ job_id: 'j' }, { store })).toMatchObject({ ok: true, data: { status: 'cancelling' } });
    expect(layoutSweepCancel({ job_id: 'zz' }, { store }).ok).toBe(false);
  });
});

describe('layoutSweepStart refusals', () => {
  const baseDeps = () => ({
    store: createSweepStore(),
    listLaunches: () => [],
    probePort: async () => false,
    connect: async () => fakeClient().client,
    listTargets: async () => [],
    writeText: async () => undefined,
    writeJson: async () => undefined,
    reportPath: (id: string) => `/r/${id}.json`,
    screenshotPath: (id: string, n: number) => `/r/${id}-${n}.png`,
    now: () => 0,
    sleep: async () => undefined,
    newId: () => 'sweep-test',
  });
  const ctxWith = (conn: { extensionId: string; kind: 'cdp' | 'extension' }, reply: (tool: string) => unknown) =>
    ({
      ipcServer: {
        listConnections: () => [{ ...conn, connectedAt: 0, lastSeenAt: 0 }],
        request: async (_id: string, env: { requestId: string; tool: string }) => {
          const r = reply(env.tool);
          return r instanceof Error
            ? { type: 'response', requestId: env.requestId, error: { message: r.message } }
            : { type: 'response', requestId: env.requestId, payload: r };
        },
      },
      cdp: { pageEndpoint: () => endpoint({ origin: 'android' }) },
      capturesRegistry: { get: () => undefined },
    }) as never;

  it('refuses an extension connection in a browser pwa-debug did not launch', async () => {
    const { layoutSweepStart } = await import('../../src/mcp/tools/layout_sweep.js');
    const r = await layoutSweepStart({ pages: ['https://x.test/'] } as never, ctxWith({ extensionId: 'ext', kind: 'extension' }, () => ({})), baseDeps());
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('not in a browser pwa-debug launched') });
  });

  it('refuses up front when the bridge predates layout_measure', async () => {
    const { layoutSweepStart } = await import('../../src/mcp/tools/layout_sweep.js');
    const r = await layoutSweepStart(
      { pages: ['https://x.test/'] } as never,
      ctxWith({ extensionId: 'cdp:x', kind: 'cdp' }, (tool) => (tool === 'layout_measure' ? new Error('unknown tool: layout_measure') : { value: ['https://x.test/', 400, 800] })),
      baseDeps(),
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('predates the layout sweep') });
    expect(r.next_steps[0]).toContain('Reload the pwa-debug extension');
  });

  it('starts a phone job when the bridge answers', async () => {
    const { layoutSweepStart } = await import('../../src/mcp/tools/layout_sweep.js');
    const deps = baseDeps();
    const r = await layoutSweepStart(
      { pages: ['https://x.test/'], color_schemes: ['light'], viewports: [{ width: 360 }] } as never,
      ctxWith({ extensionId: 'cdp:x', kind: 'cdp' }, (tool) =>
        tool === 'layout_measure' ? { frozen: false } : tool === 'evaluate' ? { value: ['https://x.test/', 400, 800] } : {},
      ),
      deps,
    );
    expect(r).toMatchObject({ ok: true, data: { job_id: 'sweep-test', target: 'phone', planned_views: 1 } });
    expect(deps.store.get('sweep-test')).toBeDefined();
  });
});
