// Unified locator wire types for the Path 7 pdl_* action tools.
//
// A Locator picks ONE resolution strategy by field precedence:
//   selector > role > text > stableId
// Role/text/selector resolve framework-agnostically (dom_aria predicates + DOM);
// `framework` only changes how a stableId is interpreted.

/**
 * Which framework's identity scheme a `stableId` locator is read under.
 * Informational for role/text/selector locators. Defaults to 'dom'.
 */
export type LocatorFramework = 'react' | 'vue' | 'svelte' | 'solid' | 'dom';

/** Unified locator accepted by every pdl_* action tool. */
export type Locator = {
  readonly framework?: LocatorFramework;
  readonly selector?: string;
  readonly role?: string;
  /** Narrows a role match by accessible-name substring. */
  readonly name?: string;
  readonly text?: string;
  /** When true, `text` must match the element's trimmed text exactly. */
  readonly exact?: boolean;
  readonly stableId?: string;
  /** Pick the i-th match (0-based) when more than one resolves. */
  readonly nth?: number;
  /** Error instead of defaulting to the first match when >1 resolve. */
  readonly requireUnique?: boolean;
};

/**
 * Discriminated result of resolveLocator. `ok:true` carries the selected
 * element, the total match count, and a human-readable description; `ok:false`
 * carries an error (not-found / ambiguous / svelte-not-element / invalid).
 */
export type LocatorResult =
  | {
      readonly ok: true;
      readonly element: Element;
      readonly matchCount: number;
      readonly describedBy: string;
    }
  | { readonly ok: false; readonly error: string; readonly matchCount: number };
