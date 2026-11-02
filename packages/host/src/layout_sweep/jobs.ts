import {
  capGroups,
  groupFindings,
  groupKey,
  summarizeFindings,
  type LayoutFinding,
  type LayoutGroup,
  type LayoutSummary,
  type LocatedFinding,
  type LayoutView,
} from '@pwa-debug/shared';

export type SweepJobStatus = 'running' | 'done' | 'cancelled' | 'interrupted' | 'failed';
export type SweepJobTarget = 'phone' | 'launched_browser';

/** What happened in one view (kept for the report file). */
export type SweepViewRecord = {
  readonly label: string;
  readonly page: string;
  readonly width: number | null;
  readonly findings: number;
  readonly duration_ms: number;
  readonly error?: string;
};

export type SweepJob = {
  readonly job_id: string;
  readonly connection_id: string;
  readonly target: SweepJobTarget;
  readonly status: SweepJobStatus;
  readonly started_at: number;
  readonly finished_at?: number;
  /** Estimate first (one state per page), corrected as each page's states are discovered. */
  readonly planned_views: number;
  readonly views_done: number;
  readonly current?: { readonly page: string; readonly label: string };
  readonly findings: readonly LocatedFinding[];
  readonly views: readonly SweepViewRecord[];
  readonly caveats: readonly string[];
  readonly warnings: readonly string[];
  /** groupKey → screenshot file, with screenshots: 'first_per_group'. */
  readonly screenshots: Readonly<Record<string, string>>;
  readonly report_path: string;
  readonly error?: string;
};

export const newSweepJob = (init: {
  readonly job_id: string;
  readonly connection_id: string;
  readonly target: SweepJobTarget;
  readonly planned_views: number;
  readonly caveats: readonly string[];
  readonly report_path: string;
  readonly now: number;
}): SweepJob => ({
  job_id: init.job_id,
  connection_id: init.connection_id,
  target: init.target,
  status: 'running',
  started_at: init.now,
  planned_views: init.planned_views,
  views_done: 0,
  findings: [],
  views: [],
  caveats: init.caveats,
  warnings: [],
  screenshots: {},
  report_path: init.report_path,
});

/** Place a view's raw findings in that view. */
export const locateFindings = (view: LayoutView, findings: readonly LayoutFinding[]): readonly LocatedFinding[] =>
  findings.map((f) => ({ ...f, page: view.page, where: view.label }));

export const withCurrent = (job: SweepJob, view: LayoutView): SweepJob => ({
  ...job,
  current: { page: view.page, label: view.label },
});

/** Record one finished view: its located findings and its view record. */
export const recordView = (
  job: SweepJob,
  view: LayoutView,
  findings: readonly LayoutFinding[],
  record: { readonly duration_ms: number; readonly error?: string },
): SweepJob => ({
  ...job,
  views_done: job.views_done + 1,
  findings: [...job.findings, ...locateFindings(view, findings)],
  views: [
    ...job.views,
    {
      label: view.label,
      page: view.page,
      width: view.viewport?.width ?? null,
      findings: findings.length,
      duration_ms: record.duration_ms,
      ...(record.error !== undefined ? { error: record.error } : {}),
    },
  ],
});

export const withPlanned = (job: SweepJob, planned: number): SweepJob => ({ ...job, planned_views: planned });
export const withWarning = (job: SweepJob, warning: string): SweepJob =>
  job.warnings.includes(warning) ? job : { ...job, warnings: [...job.warnings, warning] };
export const withScreenshot = (job: SweepJob, key: string, path: string): SweepJob => ({
  ...job,
  screenshots: { ...job.screenshots, [key]: path },
});

export const finishJob = (
  job: SweepJob,
  status: Exclude<SweepJobStatus, 'running'>,
  now: number,
  error?: string,
): SweepJob => {
  const { current: _current, ...rest } = job;
  return { ...rest, status, finished_at: now, ...(error !== undefined ? { error } : {}) };
};

export type SweepGroup = LayoutGroup & { readonly screenshot?: string };

export type SweepResult = {
  readonly job_id: string;
  readonly connection_id: string;
  readonly status: SweepJobStatus;
  readonly target: SweepJobTarget;
  readonly caveats: readonly string[];
  readonly warnings: readonly string[];
  readonly views: number;
  readonly planned_views: number;
  readonly duration_ms: number;
  readonly current?: { readonly page: string; readonly label: string };
  readonly summary: LayoutSummary;
  readonly groups: readonly SweepGroup[];
  readonly omitted_groups: number;
  /** Views that errored instead of measuring (bad selector, failed state apply, timeout). */
  readonly failed_views: number;
  readonly view_errors: readonly { readonly label: string; readonly error: string }[];
  readonly report_path: string;
  readonly error?: string;
};

const OVERFLOW_FIRST: ReadonlySet<string> = new Set(['page_overflow_x']);

/** Overflow groups first (their views' other geometry findings are often symptoms), then by count. */
export const orderGroups = (groups: readonly LayoutGroup[]): readonly LayoutGroup[] => [
  ...groups.filter((g) => OVERFLOW_FIRST.has(g.check)),
  ...groups.filter((g) => !OVERFLOW_FIRST.has(g.check)),
];

/** The status/result view of a job (spec §6.2), groups capped inline. */
export const buildSweepResult = (job: SweepJob, now: number, cap = 50): SweepResult => {
  const grouped = orderGroups(groupFindings(job.findings));
  const capped = capGroups(grouped, cap);
  return {
    job_id: job.job_id,
    connection_id: job.connection_id,
    status: job.status,
    target: job.target,
    caveats: job.caveats,
    warnings: job.warnings,
    views: job.views_done,
    planned_views: job.planned_views,
    duration_ms: (job.finished_at ?? now) - job.started_at,
    ...(job.current !== undefined ? { current: job.current } : {}),
    summary: summarizeFindings(job.findings, grouped),
    groups: capped.groups.map((g) => {
      const shot = job.screenshots[groupKey(g)];
      return shot !== undefined ? { ...g, screenshot: shot } : g;
    }),
    omitted_groups: capped.omitted,
    failed_views: job.views.filter((v) => v.error !== undefined).length,
    view_errors: job.views
      .flatMap((v) => (v.error !== undefined ? [{ label: v.label, error: v.error }] : []))
      .slice(0, 5),
    report_path: job.report_path,
    ...(job.error !== undefined ? { error: job.error } : {}),
  };
};

/** Every finding and view, for the report file. */
export const buildSweepReport = (job: SweepJob, now: number): Readonly<Record<string, unknown>> => ({
  ...buildSweepResult(job, now, Number.MAX_SAFE_INTEGER),
  view_records: job.views,
  findings: job.findings,
});

export type SweepStore = {
  readonly put: (job: SweepJob) => void;
  readonly get: (jobId: string) => SweepJob | undefined;
  readonly update: (jobId: string, fn: (job: SweepJob) => SweepJob) => SweepJob | undefined;
  readonly latest: () => SweepJob | undefined;
  readonly activeFor: (connectionId: string) => SweepJob | undefined;
  readonly requestCancel: (jobId: string) => boolean;
  readonly isCancelled: (jobId: string) => boolean;
};

const MAX_KEPT_JOBS = 20;

/**
 * In-memory job store (jobs live in the host, spec §2). Finished jobs beyond
 * the last MAX_KEPT_JOBS are dropped; their report files stay on disk.
 */
export const createSweepStore = (): SweepStore => {
  const jobs = new Map<string, SweepJob>();
  const cancelled = new Set<string>();
  const prune = (): void => {
    const finished = [...jobs.values()].filter((j) => j.status !== 'running');
    finished
      .slice(0, Math.max(0, finished.length - MAX_KEPT_JOBS))
      .forEach((j) => {
        jobs.delete(j.job_id);
        cancelled.delete(j.job_id);
      });
  };
  return Object.freeze({
    put: (job) => {
      jobs.set(job.job_id, job);
      prune();
    },
    get: (id) => jobs.get(id),
    update: (id, fn) => {
      const cur = jobs.get(id);
      if (cur === undefined) return undefined;
      const next = fn(cur);
      jobs.set(id, next);
      return next;
    },
    latest: () => [...jobs.values()].sort((a, b) => b.started_at - a.started_at)[0],
    activeFor: (connectionId) =>
      [...jobs.values()].find((j) => j.connection_id === connectionId && j.status === 'running'),
    requestCancel: (id) => {
      const j = jobs.get(id);
      if (j === undefined || j.status !== 'running') return false;
      cancelled.add(id);
      return true;
    },
    isCancelled: (id) => cancelled.has(id),
  });
};

let singleton: SweepStore | null = null;

/** The host-wide store the layout_sweep tools share. */
export const getSweepStore = (): SweepStore => {
  singleton ??= createSweepStore();
  return singleton;
};
