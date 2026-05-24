import { describe, it, expect } from 'vitest';
import {
  deriveExtensionIdFromKey,
  deriveBundledExtensionId,
} from '../../src/extension_identity/extension_id.js';

// The pinned key shipped in packages/extension/manifest.json and the id Chrome
// derives from it. This is the contract: change the key here only if the real
// manifest key changes, and the id must track it.
const PINNED_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqORD1iZOB89zzCoA/bffPsUqxFXaeDCtN7U898HfmCvswf8UmSUTnUNkqtP8xNRY5Hl4MairGQHlMg295rRl+Z53XjjfFBGsoYT/l3DfrDcZPF2/hCRecxovaQSjF2O+lR2w/ysIqSpxANiHZNiVkHxNfqbsXOvOcc5RoU9drdMcOPNthogRO6lII7Cwss6tbq07LBW4drSmvGF09Xcj2G5xvlQNyJRjWVJm0RXMVrAo1kr49ELXdmnMTUv2zNijvX4u7ZYFnakoKYXBLNi3XW4df2bT04v32jCmwMhuKWHBzz2nKhVYmN6EycJCXP951zYfTgf2fmtXtkXxR9M2hwIDAQAB';
const PINNED_ID = 'hbfmkcdpaobbhkknplcbihmfcicfcbod';

describe('deriveExtensionIdFromKey', () => {
  it('reproduces the id Chrome derives from the pinned manifest key', () => {
    expect(deriveExtensionIdFromKey(PINNED_KEY)).toBe(PINNED_ID);
  });

  it('is deterministic and 32 chars in the a-p alphabet', () => {
    const id = deriveExtensionIdFromKey(PINNED_KEY);
    expect(id).toBe(deriveExtensionIdFromKey(PINNED_KEY));
    expect(id).toMatch(/^[a-p]{32}$/);
  });
});

describe('deriveBundledExtensionId', () => {
  const read = (content: string) => async () => content;

  it('reads a manifest key and derives its id', async () => {
    const id = await deriveBundledExtensionId(
      '/ext/manifest.json',
      read(JSON.stringify({ name: 'x', key: PINNED_KEY })),
    );
    expect(id).toBe(PINNED_ID);
  });

  it('returns null when the manifest has no key (unkeyed = path-derived id)', async () => {
    const id = await deriveBundledExtensionId(
      '/ext/manifest.json',
      read(JSON.stringify({ name: 'x' })),
    );
    expect(id).toBeNull();
  });

  it('returns null when the manifest is unreadable', async () => {
    const id = await deriveBundledExtensionId('/ext/manifest.json', async () => {
      throw new Error('ENOENT');
    });
    expect(id).toBeNull();
  });

  it('returns null when the manifest is not valid JSON', async () => {
    const id = await deriveBundledExtensionId('/ext/manifest.json', read('{ not json'));
    expect(id).toBeNull();
  });
});
