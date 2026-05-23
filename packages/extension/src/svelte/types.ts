/**
 * Svelte introspection vocabulary — deliberately narrow, because Svelte's
 * compiled model exposes far less than React/Vue (see the Path 5 research note).
 * The only generically-available, feature-detectable signal in DEV builds is
 * `el.__svelte_meta`, which carries the SOURCE LOCATION of each rendered
 * element within its component's .svelte file. Svelte is one component per
 * file, so the `file` field is our component identity; there is no persistent
 * component-instance object, hence no state-read vocabulary here.
 */

/** Property the Svelte dev compiler sets on each rendered DOM element. */
export const SVELTE_META_KEY = '__svelte_meta';
/** Global the Svelte 5 dev runtime exposes (presence => Svelte on the page). */
export const SVELTE_GLOBAL_KEY = '__svelte';

/** Source location of a rendered element within its component .svelte file. */
export type SvelteLoc = {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
};

/** Minimal shape of `el.__svelte_meta` this module reads. */
export type SvelteMeta = {
  readonly loc: SvelteLoc;
};

/** Result of probing the page for Svelte. */
export type SvelteDetection = {
  /** True when any Svelte signal was found. */
  readonly present: boolean;
  /**
   * True when dev-only signals (__svelte_meta) are present — introspection
   * needs these. A production Svelte app may be present:true, dev:false, in
   * which case discovery returns nothing.
   */
  readonly dev: boolean;
  /** How many rendered elements carry __svelte_meta (0 in production). */
  readonly metaElementCount: number;
};

/** A discovered Svelte component (identified by its source file). */
export type SvelteComponent = {
  /** The component's .svelte source file — also its stable identity. */
  readonly stableId: string;
  /** Same as stableId; named for parity with react/vue display fields. */
  readonly file: string;
  /** Source location (line/column) of the first rendered element of this file. */
  readonly firstLoc?: { readonly line?: number; readonly column?: number };
  /** How many rendered DOM elements were attributed to this component file. */
  readonly elementCount: number;
};
