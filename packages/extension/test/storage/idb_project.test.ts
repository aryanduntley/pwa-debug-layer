import { describe, it, expect } from 'vitest';
import {
  projectIndexInfo,
  projectStoreInfo,
  projectIdbRecord,
  type IdbStoreView,
} from '../../src/storage/idb_project.js';

describe('projectIndexInfo', () => {
  it('projects a single-keyPath index', () => {
    expect(
      projectIndexInfo({ name: 'by_email', keyPath: 'email', unique: true, multiEntry: false }),
    ).toEqual({ name: 'by_email', keyPath: 'email', unique: true, multiEntry: false });
  });

  it('copies a compound (array) keyPath into a fresh frozen array', () => {
    const source = ['a', 'b'];
    const out = projectIndexInfo({ name: 'compound', keyPath: source, unique: false, multiEntry: true });
    expect(out.keyPath).toEqual(['a', 'b']);
    expect(out.keyPath).not.toBe(source);
    expect(Object.isFrozen(out.keyPath)).toBe(true);
  });
});

describe('projectStoreInfo', () => {
  it('projects a store + its indexes, normalizing null keyPath (out-of-line)', () => {
    const store: IdbStoreView = {
      name: 'items',
      keyPath: null,
      autoIncrement: true,
      indexes: [{ name: 'by_ts', keyPath: 'ts', unique: false, multiEntry: false }],
    };
    expect(projectStoreInfo(store)).toEqual({
      name: 'items',
      keyPath: null,
      autoIncrement: true,
      indexes: [{ name: 'by_ts', keyPath: 'ts', unique: false, multiEntry: false }],
    });
  });

  it('handles a store with no indexes', () => {
    const out = projectStoreInfo({ name: 's', keyPath: 'id', autoIncrement: false, indexes: [] });
    expect(out.indexes).toEqual([]);
  });
});

describe('projectIdbRecord', () => {
  it('projects key + value through the shared serializer', () => {
    const rec = projectIdbRecord(1, { name: 'Ada' });
    expect(rec.key).toBe(1);
    expect(rec.value).toEqual({ name: 'Ada' });
    expect(rec.truncated).toBeUndefined();
  });

  it('flags truncated when a large value exceeds the 16KB serializer cap', () => {
    const big = { blob: 'x'.repeat(20_000) };
    const rec = projectIdbRecord('k', big);
    expect(rec.truncated).toBe(true);
  });

  it('preserves a compound (array) key', () => {
    const rec = projectIdbRecord(['a', 1], { v: true });
    expect(rec.key).toEqual(['a', 1]);
  });
});
