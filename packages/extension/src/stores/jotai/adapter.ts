/**
 * Jotai StoreAdapter — the fourth (and last for Path 4) registered adapter.
 * Projects a Jotai { store, atoms } handoff into the framework-agnostic
 * StoreHandle via a REDUCED, atom-keyed contract:
 *
 *  - getState  — a name-keyed snapshot { [atomName]: store.get(atom) } built
 *    from the exposed atom registry, so path_get drills by atom name
 *    (state.count) rather than the native (un-addressable) atom graph.
 *  - subscribe — subscribes to every named atom and returns a combined
 *    unsubscribe; any atom change fires the 0-arg listener (installStoreSubscription
 *    re-reads the snapshot and diffs).
 *  - dispatch  — { type: atomName, payload } -> store.set(atoms[atomName], payload).
 *    An unknown atom name throws. (No setState/$patch analogue — setting an atom
 *    by name IS the write surface.)
 *
 * The atom-keyed divergence from the path-tree model is intentional and is the
 * only adapter that reshapes state rather than passing a native tree through.
 *
 * Pure: detection-time reads only (delegated to detectJotaiHandoff); dispatch /
 * the snapshot reads run only when invoked.
 */
import type { StoreAdapter, StoreHandle, DetectContext } from '../contract.js';
import {
  detectJotaiHandoff,
  type JotaiDetectScope,
  type JotaiHandoff,
} from './detect.js';

type DispatchAction = { readonly type: string; readonly payload?: unknown };

const toHandle = (handoff: JotaiHandoff): StoreHandle => {
  const { store, atoms } = handoff;
  const entries = Object.entries(atoms);
  return {
    getState: () => {
      const snapshot: Record<string, unknown> = {};
      for (const [name, atom] of entries) snapshot[name] = store.get(atom);
      return snapshot;
    },
    subscribe: (listener: () => void) => {
      const unsubs = entries.map(([, atom]) => store.sub(atom, () => listener()));
      return () => {
        for (const u of unsubs) u();
      };
    },
    dispatch: (action: { readonly type: string }) => {
      const { type, payload } = action as DispatchAction;
      const atom = atoms[type];
      if (atom === undefined) {
        throw new Error(
          `jotai: no atom named "${type}" in the exposed registry. dispatch sets an atom by name: { type: atomName, payload }.`,
        );
      }
      store.set(atom, payload);
      return undefined;
    },
  };
};

const detectJotai = (
  scope: unknown,
  _ctx?: DetectContext,
): StoreHandle | null => {
  const handoff = detectJotaiHandoff(scope as JotaiDetectScope);
  return handoff === null ? null : toHandle(handoff);
};

export const jotaiAdapter: StoreAdapter = Object.freeze({
  framework: 'jotai',
  detect: detectJotai,
});
