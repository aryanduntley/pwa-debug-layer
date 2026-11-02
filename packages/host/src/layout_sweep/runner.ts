import {
  expandTemplate,
  groupKey,
  planPageViews,
  viewVars,
  type ChecksConfig,
  type LayoutFinding,
  type LayoutMeasureResult,
  type LayoutStateDriver,
  type LayoutView,
  type SweepPlan,
} from '@pwa-debug/shared';
import type { CdpClient } from '../cdp_client/types.js';
import { applyColorScheme, applyViewport, captureClip, clipFor, reloadAndWait, resetEmulation } from './emulation.js';
import {
  finishJob,
  recordView,
  withCurrent,
  withPlanned,
  withScreenshot,
  withWarning,
  type SweepJob,
  type SweepStore,
} from './jobs.js';
import { isConnectionGone, type PageOps } from './page_ops.js';

export type SweepRunnerDeps = {
  readonly page: PageOps;
  readonly cdp: CdpClient;
  readonly store: SweepStore;
  /** Page errors / unhandled rejections the host received for this connection since a time. */
  readonly errorsSince: (sinceMs: number) => readonly { readonly message: string }[];
  readonly writeScreenshot: (jobId: string, index: number, base64: string) => Promise<string>;
  readonly writeReport: (job: SweepJob) => Promise<void>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
};

export type SweepSettle = {
  readonly wait_ms: number;
  readonly wait_for?: string;
  readonly freeze_animations: boolean;
};

export type SweepRunInput = {
  readonly job_id: string;
  readonly plan: SweepPlan;
  readonly checks: ChecksConfig;
  readonly root_selector?: string;
  readonly exempt_selectors: readonly string[];
  readonly settle: SweepSettle;
  readonly screenshots: 'none' | 'first_per_group';
  readonly view_timeout_ms: number;
  /** Where the tab was before the sweep; restored at the end. */
  readonly start_url: string;
  /** The page's own layout viewport before any override (for @device views and caveats). */
  readonly device: { readonly width: number; readonly height: number };
};

const MAX_STATES = 200;
const MAX_SCREENSHOTS = 50;
const WAIT_FOR_TIMEOUT_MS = 3_000;
const WAIT_FOR_POLL_MS = 100;
const BRIDGE_WAIT_MS = 8_000;
const RELOAD_TIMEOUT_MS = 12_000;

type Timed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<Timed<T>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: false }), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });

/** Poll until the bridge answers session_ping (after a navigation or reload). */
export const waitForBridge = async (deps: Pick<SweepRunnerDeps, 'page' | 'now' | 'sleep'>, timeoutMs = BRIDGE_WAIT_MS): Promise<boolean> => {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    if (await deps.page.ping()) return true;
    await deps.sleep(150);
  }
  return false;
};

/** State keys for the loaded page: the driver's discover expression, deduped and capped, or ['']. */
export const discoverStates = async (
  page: PageOps,
  driver: LayoutStateDriver | undefined,
): Promise<{ readonly states: readonly string[]; readonly warning?: string }> => {
  if (driver?.discover === undefined) return { states: [''] };
  try {
    const raw = await page.evaluate(driver.discover, true);
    const list = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [];
    const states = [...new Set(list)].slice(0, MAX_STATES);
    if (states.length === 0) {
      return { states: [''], warning: 'states.discover returned no state keys on a page; it was swept as loaded' };
    }
    return {
      states,
      ...(list.length > MAX_STATES ? { warning: `states.discover returned more than ${MAX_STATES} states; the rest were skipped` } : {}),
    };
  } catch (err) {
    return { states: [''], warning: `states.discover failed (${(err as Error).message}); the page was swept as loaded` };
  }
};

/** Apply one view's state: the driver's apply expression, or hash_template; optional reload. */
export const applyState = async (
  deps: Pick<SweepRunnerDeps, 'page' | 'cdp' | 'now' | 'sleep'>,
  view: LayoutView,
  driver: LayoutStateDriver | undefined,
  device: { readonly width: number; readonly height: number },
): Promise<string | null> => {
  if (driver === undefined) return null;
  const vars = viewVars(view, device);
  let warning: string | null = null;
  if (driver.apply !== undefined) {
    await deps.page.evaluate(`((view) => (${driver.apply}))(${JSON.stringify(vars)})`, true);
  } else if (driver.hash_template !== undefined) {
    const hash = expandTemplate(driver.hash_template, vars);
    const h = JSON.stringify(hash.startsWith('#') ? hash : `#${hash}`);
    const took = await deps.page.evaluate(`(location.hash = ${h}, location.hash === ${h} || (${h} === '#' && location.hash === ''))`);
    if (took !== true) {
      warning =
        'states.hash_template: location.hash did not change, so states were not applied (pages loaded from data: or other opaque URLs cannot take a fragment). Serve the pages over http(s) or use states.apply.';
    }
  } else {
    return null;
  }
  if (driver.reload === true) {
    await reloadAndWait(deps.cdp, RELOAD_TIMEOUT_MS);
    await waitForBridge(deps);
  }
  return warning;
};

const settleView = async (deps: Pick<SweepRunnerDeps, 'page' | 'now' | 'sleep'>, settle: SweepSettle): Promise<string | null> => {
  if (settle.wait_ms > 0) await deps.sleep(settle.wait_ms);
  if (settle.wait_for === undefined) return null;
  const deadline = deps.now() + WAIT_FOR_TIMEOUT_MS;
  while (deps.now() < deadline) {
    const ok = await deps.page.evaluate(`Boolean(${settle.wait_for})`, true).catch(() => false);
    if (ok === true) return null;
    await deps.sleep(WAIT_FOR_POLL_MS);
  }
  return `settle.wait_for stayed falsy for ${WAIT_FOR_TIMEOUT_MS}ms; measured anyway`;
};

/** Page errors in the view's window, as findings. */
export const errorFindings = (errors: readonly { readonly message: string }[]): readonly LayoutFinding[] =>
  errors.map((e) => ({
    check: 'errors' as const,
    signature: `error "${e.message.slice(0, 80)}"`,
    message: `page error during the view: ${e.message.slice(0, 300)}`,
  }));

type ViewOutcome = {
  readonly findings: readonly LayoutFinding[];
  readonly measured?: LayoutMeasureResult;
  readonly error?: string;
  readonly warning?: string;
};

const measureOnce = async (deps: SweepRunnerDeps, input: SweepRunInput): Promise<LayoutMeasureResult> => {
  const req = {
    checks: input.checks,
    exempt_selectors: input.exempt_selectors,
    ...(input.root_selector !== undefined ? { root_selector: input.root_selector } : {}),
  };
  try {
    return await deps.page.measure(req);
  } catch (err) {
    if (isConnectionGone(err)) throw err;
    // The bridge may be re-attaching after a state change; wait once and retry.
    await waitForBridge(deps, 3_000);
    return deps.page.measure(req);
  }
};

const runView = async (deps: SweepRunnerDeps, input: SweepRunInput, view: LayoutView): Promise<ViewOutcome> => {
  const started = deps.now();
  const stateWarning = await applyState(deps, view, input.plan.states, input.device);
  if (input.settle.freeze_animations) await deps.page.freeze().catch(() => undefined);
  const warning = stateWarning ?? (await settleView(deps, input.settle));
  const measured = await measureOnce(deps, input);
  const errors = input.checks.errors.enabled ? errorFindings(deps.errorsSince(started)) : [];
  return {
    findings: [...measured.findings, ...errors],
    measured,
    ...(warning !== null ? { warning } : {}),
  };
};

const viewportKey = (v: LayoutView['viewport']): string => (v === null ? 'device' : `${v.width}x${v.height}@${v.dpr}${v.mobile ? 'm' : ''}`);

/** First-per-group screenshots for groups this view introduces. */
const shootNewGroups = async (
  deps: SweepRunnerDeps,
  jobId: string,
  findings: readonly LayoutFinding[],
  scroll: { readonly x: number; readonly y: number },
): Promise<void> => {
  const fresh = findings.filter((f) => f.rect !== undefined);
  for (const f of fresh) {
    const job = deps.store.get(jobId);
    if (job === undefined) return;
    const key = groupKey(f);
    const taken = Object.keys(job.screenshots).length;
    if (job.screenshots[key] !== undefined || taken >= MAX_SCREENSHOTS) continue;
    const data = await captureClip(deps.cdp, clipFor(f.rect!, scroll));
    if (data === null) continue;
    const path = await deps.writeScreenshot(jobId, taken + 1, data);
    deps.store.update(jobId, (j) => withScreenshot(j, key, path));
  }
};

/**
 * Run a sweep job to the end: page by page (navigate, discover states), view
 * by view (emulate, apply state, settle, measure). Progress and partial
 * results land in the store as they happen. Emulation and the starting URL
 * are restored however the job ends, and the report file is written.
 */
export const runSweep = async (deps: SweepRunnerDeps, input: SweepRunInput): Promise<void> => {
  const id = input.job_id;
  const update = (fn: (j: SweepJob) => SweepJob): void => {
    deps.store.update(id, fn);
  };
  let lastViewport: string | null = null;
  let lastScheme: string | null = null;
  let budget = input.plan.max_views;
  let planned = 0;
  let status: 'done' | 'cancelled' | 'interrupted' | 'failed' = 'done';
  let failure: string | undefined;
  try {
    await deps.cdp.send('Page.enable').catch(() => undefined);
    pages: for (const [pageIndex, url] of input.plan.pages.entries()) {
      if (deps.store.isCancelled(id)) {
        status = 'cancelled';
        break;
      }
      await deps.page.navigate(url);
      await waitForBridge(deps);
      const { states, warning } = await discoverStates(deps.page, input.plan.states);
      if (warning !== undefined) update((j) => withWarning(j, warning));
      const views = planPageViews(input.plan, url, states);
      const remainingPages = input.plan.pages.length - pageIndex - 1;
      planned += views.length;
      const estimateRest = remainingPages * input.plan.viewports.length * input.plan.schemes.length * input.plan.dimCombos.length;
      update((j) => withPlanned(j, Math.min(input.plan.max_views, planned + estimateRest)));
      for (const view of views) {
        if (deps.store.isCancelled(id)) {
          status = 'cancelled';
          break pages;
        }
        if (budget <= 0) {
          update((j) => withWarning(j, `stopped at max_views ${input.plan.max_views}; later views were not swept`));
          break pages;
        }
        budget -= 1;
        update((j) => withCurrent(j, view));
        const vk = viewportKey(view.viewport);
        if (vk !== lastViewport) {
          await applyViewport(deps.cdp, view.viewport);
          lastViewport = vk;
        }
        if (view.scheme !== lastScheme) {
          await applyColorScheme(deps.cdp, view.scheme);
          lastScheme = view.scheme;
        }
        const started = deps.now();
        try {
          const timed = await withTimeout(runView(deps, input, view), input.view_timeout_ms);
          if (!timed.ok) {
            const f: LayoutFinding = {
              check: 'timeout',
              signature: 'view',
              message: `the view did not finish within ${input.view_timeout_ms}ms (state apply, settle or measure hung)`,
            };
            update((j) => recordView(j, view, [f], { duration_ms: deps.now() - started, error: 'timeout' }));
            continue;
          }
          const out = timed.value;
          if (out.warning !== undefined) update((j) => withWarning(j, out.warning!));
          update((j) => recordView(j, view, out.findings, { duration_ms: deps.now() - started }));
          if (input.screenshots === 'first_per_group' && out.measured !== undefined) {
            await shootNewGroups(deps, id, out.findings, out.measured.scroll);
          }
        } catch (err) {
          if (isConnectionGone(err)) throw err;
          update((j) =>
            recordView(j, view, [], { duration_ms: deps.now() - started, error: (err as Error).message.slice(0, 300) }),
          );
        }
      }
    }
  } catch (err) {
    status = isConnectionGone(err) ? 'interrupted' : 'failed';
    failure = (err as Error).message;
  } finally {
    await resetEmulation(deps.cdp);
    if (status !== 'interrupted') {
      await deps.page.navigate(input.start_url).catch(() => undefined);
    }
    update((j) => finishJob(j, status, deps.now(), failure));
    const finished = deps.store.get(id);
    if (finished !== undefined) await deps.writeReport(finished).catch(() => undefined);
  }
};
