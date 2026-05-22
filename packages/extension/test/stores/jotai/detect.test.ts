import { describe, it, expect } from 'vitest';
import { detectJotaiHandoff } from '../../../src/stores/jotai/detect.js';

const makeStore = () => ({
  get: () => undefined,
  set: () => undefined,
  sub: () => () => undefined,
});

describe('detectJotaiHandoff', () => {
  it('returns null when __pwaDebug_jotai is absent or malformed', () => {
    expect(detectJotaiHandoff({})).toBeNull();
    expect(detectJotaiHandoff({ __pwaDebug_jotai: 42 })).toBeNull();
    expect(detectJotaiHandoff({ __pwaDebug_jotai: null })).toBeNull();
    // store missing sub
    expect(
      detectJotaiHandoff({
        __pwaDebug_jotai: { store: { get: () => 0, set: () => undefined }, atoms: {} },
      }),
    ).toBeNull();
    // atoms missing
    expect(detectJotaiHandoff({ __pwaDebug_jotai: { store: makeStore() } })).toBeNull();
  });

  it('returns the handoff when store + atoms are well-formed', () => {
    const handoff = { store: makeStore(), atoms: { count: {} } };
    const detected = detectJotaiHandoff({ __pwaDebug_jotai: handoff });
    expect(detected).not.toBeNull();
    expect(detected?.atoms).toBe(handoff.atoms);
  });

  it('rejects a Redux/Zustand/Pinia-shaped store (no { store, atoms } wrapper)', () => {
    expect(
      detectJotaiHandoff({
        __pwaDebug_jotai: {
          getState: () => ({}),
          subscribe: () => () => undefined,
          dispatch: () => undefined,
        },
      }),
    ).toBeNull();
  });
});
