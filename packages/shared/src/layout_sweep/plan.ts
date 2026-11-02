import type {
  LayoutColorScheme,
  LayoutStateDriver,
  LayoutView,
  LayoutViewportSpec,
} from './types.js';

// shared compiles without DOM or Node libs; URL is a global in both runtimes
// that load this code (host on Node, page world in the browser).
declare const URL: new (
  url: string,
  base?: string,
) => { readonly href: string; readonly pathname: string; readonly host: string };

export type SweepTarget = 'phone' | 'launched_browser';

export type ViewportInput = {
  readonly width: number;
  readonly height?: number;
  readonly dpr?: number;
  readonly mobile?: boolean;
};

export type SweepPlanInput = {
  readonly target: SweepTarget;
  readonly pages: readonly string[];
  readonly base_url?: string;
  readonly viewports?: readonly ViewportInput[];
  readonly color_schemes?: readonly LayoutColorScheme[];
  readonly states?: LayoutStateDriver;
  readonly max_views?: number;
};

export type SweepPlan = {
  readonly target: SweepTarget;
  readonly pages: readonly string[];
  /** null = the device's own size, no override (phones only). */
  readonly viewports: readonly (LayoutViewportSpec | null)[];
  readonly schemes: readonly LayoutColorScheme[];
  readonly dimCombos: readonly Readonly<Record<string, string>>[];
  readonly states?: LayoutStateDriver;
  readonly max_views: number;
  /** pages × viewports × schemes × dimension combos, counting one state per page. */
  readonly estimated_views: number;
};

export type SweepPlanResult =
  | { readonly ok: true; readonly plan: SweepPlan }
  | { readonly ok: false; readonly error: string };

export const DEFAULT_MAX_VIEWS = 2000;
export const HARD_MAX_VIEWS = 10000;
export const MAX_PAGES = 200;
const DEFAULT_WIDTHS: readonly number[] = [360, 390, 430];
const DEFAULT_HEIGHT = 800;
const DEFAULT_DPR = 2;
const DEFAULT_SCHEMES: readonly LayoutColorScheme[] = ['light', 'dark'];
const RESERVED_VARS: ReadonlySet<string> = new Set(['state', 'scheme', 'page', 'width', 'height', 'viewport']);
const DIM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Absolute URL for a page entry: absolute as given, or resolved against base_url. Null when unusable. */
export const resolvePageUrl = (page: string, baseUrl?: string): string | null => {
  const p = page.trim();
  if (p.length === 0 || /^javascript:/i.test(p)) return null;
  try {
    return baseUrl !== undefined ? new URL(p, baseUrl).href : new URL(p).href;
  } catch {
    return null;
  }
};

/** Every combination of the extra dimensions, in declaration order. No dimensions → [{}]. */
export const crossDimensions = (
  dims: Readonly<Record<string, readonly string[]>> | undefined,
): readonly Readonly<Record<string, string>>[] =>
  Object.entries(dims ?? {}).reduce<readonly Readonly<Record<string, string>>[]>(
    (combos, [name, values]) => combos.flatMap((c) => values.map((v) => ({ ...c, [name]: v }))),
    [{}],
  );

const toViewportSpec = (v: ViewportInput): LayoutViewportSpec => ({
  width: Math.round(v.width),
  height: Math.round(v.height ?? DEFAULT_HEIGHT),
  dpr: v.dpr ?? DEFAULT_DPR,
  mobile: v.mobile ?? true,
});

/** Viewports given by the caller, or the defaults: phones start with their own size. */
export const defaultViewports = (target: SweepTarget): readonly (LayoutViewportSpec | null)[] => [
  ...(target === 'phone' ? [null] : []),
  ...DEFAULT_WIDTHS.map((width) => toViewportSpec({ width })),
];

const validViewport = (v: ViewportInput): boolean =>
  Number.isFinite(v.width) &&
  v.width >= 120 &&
  v.width <= 3840 &&
  (v.height === undefined || (Number.isFinite(v.height) && v.height >= 120 && v.height <= 4320)) &&
  (v.dpr === undefined || (Number.isFinite(v.dpr) && v.dpr > 0 && v.dpr <= 5));

const checkDimensions = (dims: LayoutStateDriver['dimensions']): string | null => {
  const bad = Object.entries(dims ?? {}).find(
    ([name, values]) =>
      !DIM_NAME.test(name) ||
      RESERVED_VARS.has(name) ||
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((v) => typeof v !== 'string'),
  );
  return bad === undefined
    ? null
    : `states.dimensions.${bad[0]}: name must be an identifier other than ${[...RESERVED_VARS].join('/')}, with a non-empty array of string values`;
};

/**
 * Validate a sweep request and resolve its defaults into a plan. States are
 * discovered per page at run time, so estimated_views counts one state per
 * page; the runner re-checks max_views once each page's states are known.
 */
export const planSweep = (input: SweepPlanInput): SweepPlanResult => {
  if (input.pages.length === 0) return { ok: false, error: 'pages must list at least one page' };
  if (input.pages.length > MAX_PAGES) return { ok: false, error: `pages lists more than ${MAX_PAGES} pages` };
  const resolved = input.pages.map((p) => resolvePageUrl(p, input.base_url));
  const badIndex = resolved.findIndex((u) => u === null);
  if (badIndex >= 0) {
    return {
      ok: false,
      error: `pages[${badIndex}] ${JSON.stringify(input.pages[badIndex])} is not an absolute URL${input.base_url === undefined ? ' (pass base_url to use relative paths)' : ` and does not resolve against base_url`}`,
    };
  }
  const given = input.viewports;
  if (given !== undefined && (given.length === 0 || !given.every(validViewport))) {
    return { ok: false, error: 'viewports: each needs width 120-3840, optional height 120-4320 and dpr 0-5' };
  }
  const viewports = given === undefined ? defaultViewports(input.target) : given.map(toViewportSpec);
  const schemes = input.color_schemes ?? DEFAULT_SCHEMES;
  if (schemes.length === 0) return { ok: false, error: 'color_schemes must not be empty' };
  const dimError = checkDimensions(input.states?.dimensions);
  if (dimError !== null) return { ok: false, error: dimError };
  const maxViews = input.max_views ?? DEFAULT_MAX_VIEWS;
  if (!Number.isInteger(maxViews) || maxViews < 1 || maxViews > HARD_MAX_VIEWS) {
    return { ok: false, error: `max_views must be an integer from 1 to ${HARD_MAX_VIEWS}` };
  }
  const dimCombos = crossDimensions(input.states?.dimensions);
  const pages = resolved as readonly string[];
  const estimated = pages.length * viewports.length * schemes.length * dimCombos.length;
  if (estimated > maxViews) {
    return {
      ok: false,
      error: `the sweep plans at least ${estimated} views (pages × viewports × schemes × dimensions), over max_views ${maxViews}. Narrow it or raise max_views (up to ${HARD_MAX_VIEWS}).`,
    };
  }
  return {
    ok: true,
    plan: {
      target: input.target,
      pages,
      viewports,
      schemes,
      dimCombos,
      ...(input.states !== undefined ? { states: input.states } : {}),
      max_views: maxViews,
      estimated_views: estimated,
    },
  };
};

/** Short page name for labels: the last path segment, else the host. */
const LABEL_MAX = 60;

/** Short stable tag for opaque URLs (data:, blob:), so labels stay readable. */
const shortHash = (s: string): string =>
  ([...s].reduce((h, c) => ((h * 33) ^ c.charCodeAt(0)) >>> 0, 5381)).toString(36);

export const pageLabel = (url: string): string => {
  if (/^(data|blob|javascript|about):/i.test(url)) return `${url.split(':')[0]}:${shortHash(url)}`;
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    const label = last ?? u.host;
    return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
  } catch {
    return url.length > LABEL_MAX ? `${url.slice(0, LABEL_MAX - 1)}…` : url;
  }
};

/** "4.30-sign-in.html@360 create/es/dark"; a native phone viewport reads "@device". */
export const viewLabel = (
  page: string,
  viewport: LayoutViewportSpec | null,
  scheme: LayoutColorScheme,
  state: string,
  dims: Readonly<Record<string, string>>,
): string => {
  const parts = [state, ...Object.values(dims), scheme].filter((p) => p.length > 0);
  return `${pageLabel(page)}@${viewport === null ? 'device' : viewport.width} ${parts.join('/')}`;
};

/**
 * Views for one page once its states are known, ordered for the runner:
 * viewport (one emulation change) → scheme → dimension combo → state.
 */
export const planPageViews = (
  plan: SweepPlan,
  page: string,
  states: readonly string[],
): readonly LayoutView[] => {
  const keys = states.length === 0 ? [''] : states;
  return plan.viewports.flatMap((viewport) =>
    plan.schemes.flatMap((scheme) =>
      plan.dimCombos.flatMap((dims) =>
        keys.map((state) => ({
          page,
          viewport,
          scheme,
          state,
          dims,
          label: viewLabel(page, viewport, scheme, state, dims),
        })),
      ),
    ),
  );
};

/** Variables a state driver sees for one view (spec §4). */
export const viewVars = (
  view: LayoutView,
  actual: { readonly width: number; readonly height: number },
): Readonly<Record<string, string>> => ({
  ...view.dims,
  state: view.state,
  scheme: view.scheme,
  page: view.page,
  width: String(view.viewport?.width ?? actual.width),
  height: String(view.viewport?.height ?? actual.height),
});

/** Fill {name} placeholders from vars (URI-encoded); unknown names are left as written. */
export const expandTemplate = (template: string, vars: Readonly<Record<string, string>>): string =>
  template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const v = vars[name];
    return v === undefined ? whole : encodeURIComponent(v);
  });
