/**
 * Solid introspection vocabulary — the most constrained of the four frameworks
 * (see Path 5 research note). Solid has no virtual DOM, no persisted component
 * tree, and no DOM->component back-pointer; components are functions that run
 * once. So WITHOUT the @solid-devtools plugin (window.__SOLID_DEVTOOLS__), only
 * DETECTION and DOM-level (element) matching are possible — matches cannot be
 * attributed to components, and there is no state read.
 */

/** Global the @solid-devtools runtime installs (presence => deep tools viable). */
export const SOLID_DEVTOOLS_KEY = '__SOLID_DEVTOOLS__';
/** Global Solid's hydration runtime sets. */
export const SOLID_HYDRATION_KEY = '_$HY';
/** Prefix Solid uses for delegated-event expando props on DOM nodes ($$click). */
export const SOLID_DELEGATED_PREFIX = '$$';

export type SolidDetection = {
  /** True when any Solid signal was found. */
  readonly present: boolean;
  /** True when the @solid-devtools hook is installed (deep introspection viable). */
  readonly devtoolsHook: boolean;
  /** True when Solid's hydration global is present. */
  readonly hydration: boolean;
  /** How many elements carry $$-prefixed delegated-event props (heuristic). */
  readonly delegatedEventCount: number;
};

/** An element-level Solid text match (NOT a component — Solid exposes none). */
export type SolidTextMatch = {
  /** A CSS-ish locator for the matched element. */
  readonly locator: string;
  readonly tag: string;
  readonly matchedText: string;
};

/** An element-level Solid role match. */
export type SolidRoleMatch = {
  readonly locator: string;
  readonly tag: string;
  readonly role: string;
  readonly name?: string;
};
