/**
 * Wire types for the layout sweep (docs/layout-sweep-spec.md). The page world
 * produces LayoutFinding rows per view (layout_measure); the host plans views,
 * locates findings and groups them into distinct problems.
 */

/** Checks the page world runs, plus the two the host records (errors, timeout). */
export type LayoutCheckName =
  | 'page_overflow_x'
  | 'offscreen'
  | 'tap_target'
  | 'pinned_visible'
  | 'text_clipped'
  | 'edge_contact'
  | 'ring_clipped'
  | 'text_patterns'
  | 'errors'
  | 'contrast'
  | 'timeout';

/** A finding's check: a built-in name, or custom:<name> for a caller's custom check. */
export type LayoutCheckId = LayoutCheckName | `custom:${string}`;

/** A caller-defined check (layout_sweep custom_checks): a page expression run per view. */
export type CustomCheck = {
  readonly name: string;
  readonly expression: string;
};

/** A custom check that threw, returned a promise or returned something unusable in one view. */
export type CustomCheckError = {
  readonly name: string;
  readonly error: string;
};

export type LayoutRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** Fully resolved check configuration: every check present, every knob set. */
export type ChecksConfig = {
  readonly page_overflow_x: { readonly enabled: boolean };
  readonly offscreen: { readonly enabled: boolean };
  readonly tap_target: { readonly enabled: boolean; readonly min: number };
  readonly pinned_visible: {
    readonly enabled: boolean;
    readonly pinned_selectors: readonly string[];
  };
  readonly text_clipped: { readonly enabled: boolean };
  readonly edge_contact: { readonly enabled: boolean; readonly min_inset: number };
  /** Outline / outer box-shadow ink cut off by a clipping or scrolling ancestor. */
  readonly ring_clipped: { readonly enabled: boolean; readonly min_px: number };
  readonly text_patterns: { readonly enabled: boolean; readonly extra: readonly string[] };
  readonly errors: { readonly enabled: boolean };
  readonly contrast: { readonly enabled: boolean };
};

/** One problem seen in one view, as the page world reports it. */
export type LayoutFinding = {
  readonly check: LayoutCheckId;
  /** Element signature: tag#id.classes "accessible name" (or a pattern key). */
  readonly signature: string;
  readonly message: string;
  readonly rect?: LayoutRect;
};

/** Payload of the layout_measure bridge command. */
export type LayoutMeasureRequest = {
  /** measure (default) reads; freeze / unfreeze add or remove the animation-freeze style. */
  readonly op?: 'measure' | 'freeze' | 'unfreeze';
  readonly root_selector?: string;
  readonly exempt_selectors?: readonly string[];
  readonly checks?: ChecksConfig;
  /** Caller checks to run after the built-ins (already validated by resolveCustomChecks). */
  readonly custom?: readonly CustomCheck[];
  /** The view's variables, bound as `view` in custom check expressions. */
  readonly view?: Readonly<Record<string, string>>;
};

export type LayoutMeasureResult = {
  readonly url: string;
  readonly viewport: { readonly width: number; readonly height: number };
  /** Page scroll offset when measured; rects are viewport-relative, add this for page coordinates. */
  readonly scroll: { readonly x: number; readonly y: number };
  readonly findings: readonly LayoutFinding[];
  /** True when the per-view finding cap cut the list short. */
  readonly truncated: boolean;
  /** Custom checks that failed in this view (their other findings still count). */
  readonly custom_errors?: readonly CustomCheckError[];
};

export type LayoutColorScheme = 'light' | 'dark' | 'no-preference';

export type LayoutViewportSpec = {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly mobile: boolean;
};

/** Hash routing / custom apply for app states (spec §4). */
export type LayoutStateDriver = {
  readonly discover?: string;
  readonly apply?: string;
  readonly hash_template?: string;
  readonly dimensions?: Readonly<Record<string, readonly string[]>>;
  /** Reload the page after applying a state, for apps that read their hash/state only on load. */
  readonly reload?: boolean;
};

/** One planned view. viewport null = the device's own size (phones, no override). */
export type LayoutView = {
  readonly page: string;
  readonly viewport: LayoutViewportSpec | null;
  readonly scheme: LayoutColorScheme;
  readonly state: string;
  readonly dims: Readonly<Record<string, string>>;
  /** Human label used in group `where` lists, e.g. "4.30-sign-in.html@360 create/es/dark". */
  readonly label: string;
};

/** A finding placed in the view that produced it. */
export type LocatedFinding = LayoutFinding & {
  readonly page: string;
  readonly where: string;
};

/** Distinct problem across views (spec §6.2). */
export type LayoutGroup = {
  readonly check: LayoutCheckId;
  readonly signature: string;
  readonly message: string;
  readonly count: number;
  readonly pages: readonly string[];
  readonly where: readonly string[];
  readonly rect?: LayoutRect;
};

export type LayoutSummary = {
  readonly problems: number;
  readonly groups: number;
  readonly by_check: Readonly<Partial<Record<LayoutCheckId, number>>>;
};
