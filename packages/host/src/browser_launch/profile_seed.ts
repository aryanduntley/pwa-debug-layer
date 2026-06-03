/**
 * Pure profile-Preferences seeding for sandbox launches.
 *
 * A fresh Chromium profile (every sandbox-temp dir, and a sandbox-persistent dir
 * on its first launch) starts with Developer Mode OFF. A flatpak Chromium then
 * REFUSES to honor --load-extension for an unpacked extension, so the pwa-debug
 * extension never loads/connects until the user toggles Developer Mode by hand
 * at chrome://extensions (note 318). Chromium reads the profile's
 * <user-data-dir>/Default/Preferences at startup, so writing
 * extensions.ui.developer_mode=true into it BEFORE spawn unblocks --load-extension
 * with no manual step.
 *
 * Pure here: the path derivation and the non-destructive merge. The read/write
 * effect lives at the edge (node_deps.seedDeveloperModeImpl).
 */
import { join } from 'node:path';

/** A loosely-typed Preferences JSON object (Chromium's schema is large + open). */
export type ProfilePreferences = Record<string, unknown>;

/**
 * The profile Preferences file Chromium reads at startup:
 * <user-data-dir>/Default/Preferences. Seeding it before spawn is how a flag we
 * cannot pass on the command line (developer_mode) gets applied on first run.
 */
export const profilePreferencesPath = (userDataDir: string): string =>
  join(userDataDir, 'Default', 'Preferences');

/** Read an object-valued subkey from a prefs object, or {} when absent/non-object. */
const objAt = (obj: ProfilePreferences, key: string): ProfilePreferences => {
  const v = obj[key];
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as ProfilePreferences)
    : {};
};

/**
 * Merge extensions.ui.developer_mode=true into an existing Preferences object
 * (or a fresh one when `existing` is null), preserving every other key. Returns a
 * NEW object — the input is never mutated. Only the developer_mode leaf is forced;
 * any sibling extensions.* / extensions.ui.* settings carry through untouched, so
 * re-seeding a persistent profile that already has real prefs is safe.
 */
export const mergeDeveloperModePref = (
  existing: ProfilePreferences | null,
): ProfilePreferences => {
  const base = existing ?? {};
  const extensions = objAt(base, 'extensions');
  const ui = objAt(extensions, 'ui');
  return {
    ...base,
    extensions: {
      ...extensions,
      ui: { ...ui, developer_mode: true },
    },
  };
};
