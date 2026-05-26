/**
 * Page-world Jotai dev-store atom enumeration (M44) — turns a bare Jotai
 * createStore() instance into the wrapped { store, atoms } shape the adapter
 * already expects, WITHOUT the explicit window.__pwaDebug_jotai handoff.
 *
 * A bare Jotai store ({ get, set, sub }) carries no name->atom registry, so the
 * adapter's name-keyed snapshot has nothing to project. Some Jotai versions'
 * DEV builds expose a mounted-atom iterator we can read instead:
 *   - jotai 2.6–2.11: store.dev4_get_mounted_atoms()
 *   - jotai 2.0–2.5:  store.dev_get_mounted_atoms()
 * Both yield the live atom objects. We enumerate them and key each by its
 * atom.debugLabel (set by the user or jotai's babel/swc devtools plugin), with a
 * synthesized `atom{N}` fallback for unlabeled atoms, producing exactly the
 * Record<name, atom> the existing adapter reshapes through.
 *
 * IMPORTANT — version reality (M44 live-verify, note #258): jotai >=2.12 REMOVED
 * these dev iterators; the store keeps mounted atoms in a non-iterable WeakMap
 * (INTERNAL_*Rev3 building blocks), so atoms cannot be enumerated from a bare
 * store at all. On those versions buildHandoffFromDevStore returns null and
 * detection falls back to the explicit window.__pwaDebug_jotai handoff. This is
 * by design, not a gap: pwa-debug assumes the agent has the app's SOURCE, where
 * the atom set is fully visible — so reconstructing it from a running store is a
 * non-goal. This path is a best-effort convenience for jotai 2.0–2.11; the
 * always-correct mechanism is store discovery (./discover) + the handoff.
 *
 * Pure: duck-typed reads + the store's own dev iterator only. No DOM, no chrome.*.
 */
import { isJotaiStore, type JotaiStore, type JotaiHandoff } from './detect.js';

/** Jotai's version-specific mounted-atom iterators, present only in dev builds. */
type DevStore = {
  readonly dev4_get_mounted_atoms?: () => Iterable<unknown>;
  readonly dev_get_mounted_atoms?: () => Iterable<unknown>;
};

/**
 * Resolve the store's mounted-atom iterable across Jotai dev API versions
 * (dev4_ for >=2.6, dev_ for 2.0–2.5). Returns null when neither is present —
 * i.e. a production build with no introspection surface.
 */
const mountedAtoms = (store: JotaiStore): Iterable<unknown> | null => {
  const s = store as unknown as DevStore;
  if (typeof s.dev4_get_mounted_atoms === 'function') {
    return s.dev4_get_mounted_atoms();
  }
  if (typeof s.dev_get_mounted_atoms === 'function') {
    return s.dev_get_mounted_atoms();
  }
  return null;
};

/** The human name an atom advertises via debugLabel, or null when unlabeled. */
const atomLabel = (atom: unknown): string | null => {
  if (atom === null || typeof atom !== 'object') return null;
  const label = (atom as { debugLabel?: unknown }).debugLabel;
  return typeof label === 'string' && label.length > 0 ? label : null;
};

/**
 * Build the wrapped { store, atoms } handoff from a bare Jotai store by
 * enumerating its mounted atoms via the dev API. Atoms are keyed by debugLabel,
 * falling back to a synthesized `atom{index}` name (and the same fallback when a
 * label collides, so every atom stays addressable). Returns null when the
 * candidate is not a Jotai store or exposes no dev atom iterator (production
 * build) — leaving the caller to fall through to other detection paths.
 */
export const buildHandoffFromDevStore = (
  candidate: unknown,
): JotaiHandoff | null => {
  if (!isJotaiStore(candidate)) return null;
  const iterable = mountedAtoms(candidate);
  if (iterable === null) return null;
  const atoms: Record<string, unknown> = {};
  let index = 0;
  for (const atom of iterable) {
    const label = atomLabel(atom);
    const name = label !== null && !(label in atoms) ? label : `atom${index}`;
    atoms[name] = atom;
    index += 1;
  }
  return Object.freeze({ store: candidate, atoms: Object.freeze(atoms) });
};
