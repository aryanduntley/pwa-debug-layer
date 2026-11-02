import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  planSweep,
  resolveChecksConfig,
  type ChecksInput,
  type LayoutColorScheme,
  type LayoutStateDriver,
  type SweepTarget,
  type ViewportInput,
} from '@pwa-debug/shared';
import {
  errorResponse,
  okResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import { resolveTarget } from './target_resolution.js';
import { connectCdp } from '../../cdp_client/client.js';
import type { CdpClient } from '../../cdp_client/types.js';
import { listPageTargets, type CdpTarget } from '../../cdp_client/discovery.js';
import { defaultLaunchDeps, getLaunchRegistry } from '../../browser_launch/node_deps.js';
import type { LaunchRecord } from '../../browser_launch/registry.js';
import { atomicWriteJson, xdgConfigPath } from '../../host_io/host_io.js';
import { classifySweepTarget, locateTabByNonce, type LiveLaunch } from '../../layout_sweep/target.js';
import { connectionRequest, createPageOps, type PageOps } from '../../layout_sweep/page_ops.js';
import {
  buildSweepReport,
  buildSweepResult,
  getSweepStore,
  newSweepJob,
  type SweepJob,
  type SweepResult,
  type SweepStore,
} from '../../layout_sweep/jobs.js';
import { runSweep } from '../../layout_sweep/runner.js';

const toggle = <T extends z.ZodRawShape>(knobs: T) =>
  z.union([z.boolean(), z.object({ enabled: z.boolean().optional(), ...knobs })]).optional();

const checksSchema = z
  .object({
    page_overflow_x: toggle({}),
    offscreen: toggle({}),
    tap_target: toggle({ min: z.number().optional() }),
    pinned_visible: toggle({ pinned_selectors: z.array(z.string()).optional() }),
    text_clipped: toggle({}),
    edge_contact: toggle({ min_inset: z.number().optional() }),
    text_patterns: toggle({ extra: z.array(z.string()).optional() }),
    errors: toggle({}),
    contrast: toggle({}),
  })
  .optional();

const schemeSchema = z.enum(['light', 'dark', 'no-preference']);

const sweepSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  pages: z.array(z.string().min(1)).min(1),
  base_url: z.string().min(1).optional(),
  viewports: z
    .array(
      z.object({
        width: z.number(),
        height: z.number().optional(),
        dpr: z.number().optional(),
        mobile: z.boolean().optional(),
      }),
    )
    .min(1)
    .optional(),
  color_schemes: z.array(schemeSchema).min(1).optional(),
  states: z
    .object({
      discover: z.string().min(1).optional(),
      apply: z.string().min(1).optional(),
      hash_template: z.string().min(1).optional(),
      dimensions: z.record(z.string(), z.array(z.string())).optional(),
      reload: z.boolean().optional(),
    })
    .optional(),
  root_selector: z.string().min(1).optional(),
  settle: z
    .object({
      wait_ms: z.number().int().min(0).max(10_000).optional(),
      wait_for: z.string().min(1).optional(),
      freeze_animations: z.boolean().optional(),
    })
    .optional(),
  checks: checksSchema,
  exempt_selectors: z.array(z.string().min(1)).optional(),
  max_views: z.number().int().optional(),
  screenshots: z.enum(['none', 'first_per_group']).optional(),
  view_timeout_ms: z.number().int().min(1_000).max(60_000).optional(),
  report_path: z.string().min(1).optional(),
};

type SweepArgs = z.infer<z.ZodObject<typeof sweepSchema>>;

/** Injected effects, so the tools are testable without a browser. */
export type LayoutSweepDeps = {
  readonly store: SweepStore;
  readonly listLaunches: () => readonly LaunchRecord[];
  readonly probePort: (port: number) => Promise<boolean>;
  readonly connect: (wsUrl: string) => Promise<CdpClient>;
  readonly listTargets: (baseUrl: string) => Promise<readonly CdpTarget[] | null>;
  readonly writeText: (path: string, data: string | Buffer) => Promise<void>;
  readonly writeJson: (path: string, data: unknown) => Promise<void>;
  readonly reportPath: (jobId: string) => string;
  readonly screenshotPath: (jobId: string, index: number) => string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly newId: () => string;
};

export const defaultLayoutSweepDeps = (): LayoutSweepDeps => ({
  store: getSweepStore(),
  listLaunches: () => getLaunchRegistry().list(),
  probePort: (port) => defaultLaunchDeps().probeDebugPort(port),
  connect: (ws) => connectCdp(ws),
  listTargets: async (baseUrl) => {
    const r = await listPageTargets(baseUrl);
    return r.ok ? r.value : null;
  },
  writeText: async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  },
  writeJson: atomicWriteJson,
  reportPath: (id) => xdgConfigPath(`layout-sweeps/${id}.json`),
  screenshotPath: (id, n) => xdgConfigPath(`layout-sweeps/${id}/group-${n}.png`),
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  newId: () => `sweep-${randomUUID().slice(0, 8)}`,
});

const liveLaunches = async (deps: LayoutSweepDeps): Promise<readonly LiveLaunch[]> =>
  Promise.all(
    deps.listLaunches().map(async (l) => ({
      browser: l.browser,
      profileType: l.profileType,
      port: l.port,
      browserUrl: l.browserUrl,
      live: await deps.probePort(l.port).catch(() => false),
    })),
  );

const hasNonce = (deps: LayoutSweepDeps) => async (ws: string, nonce: string): Promise<boolean> => {
  const client = await deps.connect(ws);
  try {
    const r = (await client.send(
      'Runtime.evaluate',
      { expression: `globalThis.__pdl_sweep_nonce === ${JSON.stringify(nonce)}`, returnByValue: true },
      { timeoutMs: 2_000 },
    )) as { result?: { value?: unknown } };
    return r.result?.value === true;
  } finally {
    client.close();
  }
};

/** The page's own size and URL before the sweep touches anything. */
const readStart = async (page: PageOps): Promise<{ url: string; width: number; height: number }> => {
  const v = await page.evaluate(
    '[location.href, document.documentElement.clientWidth || innerWidth, document.documentElement.clientHeight || innerHeight]',
  );
  const [url, width, height] = Array.isArray(v) ? v : [];
  return {
    url: typeof url === 'string' ? url : '',
    width: typeof width === 'number' ? width : 0,
    height: typeof height === 'number' ? height : 0,
  };
};

const caveatsFor = (
  target: SweepTarget,
  device: { readonly width: number },
  widths: readonly number[],
  schemes: readonly LayoutColorScheme[],
): readonly string[] => [
  ...(target === 'launched_browser'
    ? ['Desktop browser emulating a phone viewport: fonts, scrollbars and the user agent are the desktop browser\'s. Confirm important findings on a phone.']
    : []),
  ...(target === 'phone' && widths.some((w) => w > device.width + 1)
    ? [`Some viewports are wider than this phone's own ${device.width}px layout width; the phone scales those views down.`]
    : []),
  ...(schemes.includes('no-preference') ? ["'no-preference' leaves prefers-color-scheme at the device's own setting."] : []),
];

const resultNextSteps = (r: SweepResult): readonly string[] => {
  if (r.status === 'running') {
    return [
      `Running: ${r.views}/${r.planned_views} views${r.current !== undefined ? ` (now ${r.current.label})` : ''}. Call layout_sweep_status({ job_id: "${r.job_id}" }) again in a few seconds; partial groups are already included.`,
    ];
  }
  const first = r.groups[0];
  return [
    ...(r.failed_views > 0
      ? [`${r.failed_views} view(s) failed instead of measuring (see view_errors), e.g. ${r.view_errors[0]?.label}: ${r.view_errors[0]?.error}. A bad root_selector/exempt selector or a failing states.apply fails every view; fix it first.`]
      : []),
    ...(r.status !== 'done' ? [`The sweep ended ${r.status}${r.error !== undefined ? `: ${r.error}` : ''}. Results cover the ${r.views} views that ran.`] : []),
    ...(first === undefined
      ? [r.views > 0 && r.failed_views === r.views ? 'No view was measured, so there are no results yet; fix the view errors above and re-run.' : 'No problems found in the swept views.']
      : [
          `Fix first: [${first.check}] ${first.message} (${first.count}× on ${first.pages.length} page(s)).`,
          ...(r.groups.some((g) => g.check === 'page_overflow_x')
            ? ['Page overflow is listed first: on a phone it widens the layout viewport, so offscreen / pinned findings on those views may be symptoms. Fix it and re-run.']
            : []),
          'After fixing, re-run layout_sweep on only the affected pages (groups[].pages).',
        ]),
    `Every finding and view is in ${r.report_path}.`,
  ];
};

export const layoutSweepStart = async (
  args: SweepArgs,
  ctx: ToolContext,
  deps: LayoutSweepDeps,
): Promise<ToolResponse> => {
  const resolved = resolveTarget(ctx, args.extension_id);
  if (!resolved.ok) return errorResponse(resolved.error, ['Call host_status to see live connections.']);
  const connId = resolved.extensionId;
  const conn = ctx.ipcServer.listConnections().find((c) => c.extensionId === connId);
  if (conn === undefined) return errorResponse(`connection ${connId} disappeared`, ['Call host_status.']);

  const active = deps.store.activeFor(connId);
  if (active !== undefined) {
    return errorResponse(`a sweep is already running on ${connId} (job ${active.job_id})`, [
      `Wait for it (layout_sweep_status({ job_id: "${active.job_id}" })) or stop it (layout_sweep_cancel).`,
    ]);
  }

  const endpoint = conn.kind === 'cdp' ? ctx.cdp?.pageEndpoint(connId) : undefined;
  const cls = classifySweepTarget(conn, endpoint, await liveLaunches(deps));
  if (!cls.ok) return errorResponse(cls.error, cls.next_steps);
  const target: SweepTarget = cls.kind === 'phone' ? 'phone' : 'launched_browser';

  const checks = resolveChecksConfig(args.checks as ChecksInput | undefined);
  if (!checks.ok) return errorResponse(checks.error, ['Fix the checks argument; pdl_help({ topic: "layout" }) shows the knobs.']);
  const planned = planSweep({
    target,
    pages: args.pages,
    ...(args.base_url !== undefined ? { base_url: args.base_url } : {}),
    ...(args.viewports !== undefined ? { viewports: args.viewports as readonly ViewportInput[] } : {}),
    ...(args.color_schemes !== undefined ? { color_schemes: args.color_schemes } : {}),
    ...(args.states !== undefined ? { states: args.states as LayoutStateDriver } : {}),
    ...(args.max_views !== undefined ? { max_views: args.max_views } : {}),
  });
  if (!planned.ok) return errorResponse(planned.error, ['Fix the arguments and call layout_sweep again.']);
  const plan = planned.plan;

  const tabId = conn.kind === 'extension' ? args.tab_id : undefined;
  const page = createPageOps(connectionRequest(ctx.ipcServer, connId), tabId);

  let wsUrl: string;
  if (cls.kind === 'launched_extension') {
    const located = await locateTabByNonce(
      {
        stampNonce: async (n) => {
          await page.evaluate(`(globalThis.__pdl_sweep_nonce = ${JSON.stringify(n)}, true)`);
        },
        clearNonce: async () => {
          await page.evaluate('(delete globalThis.__pdl_sweep_nonce, true)');
        },
        listTargets: deps.listTargets,
        hasNonce: hasNonce(deps),
      },
      cls.browserUrls,
      deps.newId(),
    );
    if (!located.ok) {
      return errorResponse(located.error, [
        "layout_sweep runs only on browsers pwa-debug launched. pdl_launch_browser({ profile: 'sandbox-persistent' }), or attach a phone with pdl_android_attach.",
      ]);
    }
    wsUrl = located.target.webSocketDebuggerUrl;
  } else {
    wsUrl = cls.endpoint.webSocketDebuggerUrl;
  }

  // Capability probe: an extension whose service worker predates layout_measure
  // (unpacked builds keep the old worker across restarts) would fail every view.
  try {
    await page.measure({ op: 'unfreeze' });
  } catch (err) {
    const msg = (err as Error).message;
    return errorResponse(
      /unknown tool/.test(msg)
        ? 'the connected pwa-debug extension (or page bridge) does not know layout_measure yet; it predates the layout sweep'
        : `the page bridge did not answer layout_measure: ${msg}`,
      [
        'Reload the pwa-debug extension (chrome://extensions → reload, or relaunch with pdl_launch_browser), reload the tab, then call layout_sweep again.',
        'An unpacked extension keeps its old service worker across browser restarts until it is reloaded.',
      ],
    );
  }

  let start: { url: string; width: number; height: number };
  try {
    start = await readStart(page);
  } catch (err) {
    return errorResponse(`cannot read the page before sweeping: ${(err as Error).message}`, [
      'Make sure the tab shows a normal web page (not chrome:// or the web store) and call session_ping.',
    ]);
  }

  let client: CdpClient;
  try {
    client = await deps.connect(wsUrl);
  } catch (err) {
    return errorResponse(`cannot open a CDP session on the page: ${(err as Error).message}`, [
      'The debug port may have closed. Call pdl_browser_status (desktop) or pdl_android_devices (phone).',
    ]);
  }

  const jobId = deps.newId();
  const reportPath = args.report_path ?? deps.reportPath(jobId);
  const widths = plan.viewports.flatMap((v) => (v === null ? [] : [v.width]));
  const caveats = caveatsFor(target, start, widths, plan.schemes);
  deps.store.put(
    newSweepJob({ job_id: jobId, connection_id: connId, target, planned_views: plan.estimated_views, caveats, report_path: reportPath, now: deps.now() }),
  );

  const captures = ctx.capturesRegistry;
  void runSweep(
    {
      page,
      cdp: client,
      store: deps.store,
      errorsSince: (since) =>
        (captures.get(connId)?.tail('page_error', { filter: (e) => e.receivedAt >= since }) ?? []).map((e) => ({
          message: typeof e['message'] === 'string' ? (e['message'] as string) : String(e['subkind'] ?? 'error'),
        })),
      writeScreenshot: async (id, n, b64) => {
        const path = deps.screenshotPath(id, n);
        await deps.writeText(path, Buffer.from(b64, 'base64'));
        return path;
      },
      writeReport: (job: SweepJob) => deps.writeJson(job.report_path, buildSweepReport(job, deps.now())),
      now: deps.now,
      sleep: deps.sleep,
    },
    {
      job_id: jobId,
      plan,
      checks: checks.config,
      exempt_selectors: args.exempt_selectors ?? [],
      ...(args.root_selector !== undefined ? { root_selector: args.root_selector } : {}),
      settle: {
        wait_ms: args.settle?.wait_ms ?? 80,
        freeze_animations: args.settle?.freeze_animations ?? true,
        ...(args.settle?.wait_for !== undefined ? { wait_for: args.settle.wait_for } : {}),
      },
      screenshots: args.screenshots ?? 'none',
      view_timeout_ms: args.view_timeout_ms ?? 5_000,
      start_url: start.url,
      device: { width: start.width, height: start.height },
    },
  ).finally(() => client.close());

  return okResponse(
    { job_id: jobId, connection_id: connId, target, planned_views: plan.estimated_views, caveats, report_path: reportPath },
    [
      `Sweep started (${plan.estimated_views} views planned before state discovery). Poll layout_sweep_status({ job_id: "${jobId}" }); partial results are available while it runs.`,
      'The sweep drives this tab (navigation, viewport and color-scheme emulation) until it finishes; avoid other page actions on it meanwhile. The starting URL and emulation are restored at the end.',
    ],
  );
};

export const layoutSweepStatus = (
  args: { readonly job_id?: string | undefined },
  deps: Pick<LayoutSweepDeps, 'store' | 'now'>,
): ToolResponse => {
  const job = args.job_id !== undefined ? deps.store.get(args.job_id) : deps.store.latest();
  if (job === undefined) {
    return errorResponse(args.job_id !== undefined ? `no sweep job ${args.job_id}` : 'no sweep has run in this host session', [
      'Start one with layout_sweep. Finished jobs from earlier host sessions are only in their report files.',
    ]);
  }
  const r = buildSweepResult(job, deps.now());
  return okResponse(r, resultNextSteps(r));
};

export const layoutSweepCancel = (
  args: { readonly job_id: string },
  deps: Pick<LayoutSweepDeps, 'store'>,
): ToolResponse => {
  const job = deps.store.get(args.job_id);
  if (job === undefined) return errorResponse(`no sweep job ${args.job_id}`, ['layout_sweep_status lists the latest job.']);
  if (!deps.store.requestCancel(args.job_id)) {
    return okResponse({ job_id: job.job_id, status: job.status }, [`Job already ${job.status}; nothing to cancel.`]);
  }
  return okResponse({ job_id: job.job_id, status: 'cancelling' }, [
    'The sweep stops after the current view, then restores the viewport, color scheme and starting URL. layout_sweep_status shows the partial results.',
  ]);
};

export const layoutSweepTool: ToolDef<typeof sweepSchema> = Object.freeze({
  name: 'layout_sweep',
  description:
    "Responsive layout audit across a view matrix: pages × viewport widths × color schemes × app states. For every view it emulates the viewport and prefers-color-scheme over CDP on the real top-level page, applies the app state, settles, and measures in the page: sideways page overflow, elements off screen (scroll rows and carousels skipped automatically), tap targets under the minimum (WCAG 2.2 default 24px; set checks.tap_target.min 44/48 for platform guidelines), fixed bars not fully on screen, cut-off text, text or fields touching their box's edge, unresolved copy ({{x}}, undefined, NaN, [object Object], plus checks.text_patterns.extra), page errors, and optionally contrast. Results are grouped into distinct problems, not raw rows. Runs in the background: returns { job_id, planned_views, target } at once; poll layout_sweep_status. TARGETS: phones (pdl_android_attach connection) and browsers started by pdl_launch_browser (extension connection; the host uses the launch's debug port). Other connections are refused. Args: { extension_id?, tab_id?, pages: absolute URLs or paths with base_url, base_url?, viewports?: [{ width, height?=800, dpr?=2, mobile?=true }] (default 360/390/430; phones also check their own size first), color_schemes?: ['light','dark'] default, states?: { discover?: expression → string[] of state keys, apply?: expression with `view` bound ({ state, scheme, width, height, page, ...dimensions }), hash_template?: '#state={state}&lang={lang}', dimensions?: { lang: ['en','es'] }, reload?: reload after applying }, root_selector?, settle?: { wait_ms?=80, wait_for?: expression, freeze_animations?=true }, checks?: each check true/false or its knobs, exempt_selectors?, max_views?=2000 (≤10000), screenshots?: 'none' | 'first_per_group', view_timeout_ms?=5000, report_path? }. pdl_help({ topic: 'layout' }) has a worked example.",
  inputSchema: sweepSchema,
  handler: (args, ctx) => layoutSweepStart(args, ctx, defaultLayoutSweepDeps()),
});

const statusSchema = { job_id: z.string().min(1).optional() };

export const layoutSweepStatusTool: ToolDef<typeof statusSchema> = Object.freeze({
  name: 'layout_sweep_status',
  description:
    'Progress and results of a layout_sweep job (the latest one when job_id is omitted): status (running | done | cancelled | interrupted | failed), views done / planned, the current view, caveats and warnings, summary { problems, groups, by_check }, and groups: distinct problems most frequent first (page overflow always first), each { check, signature, message, count, pages, where (up to 5 view labels), rect?, screenshot? }, capped at 50 inline. report_path holds every finding and view. Partial results while running. Args: { job_id? }.',
  inputSchema: statusSchema,
  handler: async (args) => layoutSweepStatus(args, defaultLayoutSweepDeps()),
});

const cancelSchema = { job_id: z.string().min(1) };

export const layoutSweepCancelTool: ToolDef<typeof cancelSchema> = Object.freeze({
  name: 'layout_sweep_cancel',
  description:
    'Stop a running layout_sweep after its current view; the viewport, color scheme and starting URL are restored and partial results stay available through layout_sweep_status. Args: { job_id }.',
  inputSchema: cancelSchema,
  handler: async (args) => layoutSweepCancel(args, defaultLayoutSweepDeps()),
});
