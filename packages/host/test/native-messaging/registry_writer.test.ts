import { describe, it, expect } from 'vitest';
import { defaultRegistryJsonPath } from '../../src/native-messaging/registry_writer.js';

describe('defaultRegistryJsonPath', () => {
  it('uses APPDATA when set', () => {
    expect(
      defaultRegistryJsonPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'com.pwa_debug.host'),
    ).toBe('C:\\Users\\u\\AppData\\Roaming/pwa-debug/com.pwa_debug.host.json');
  });

  it('falls back to USERPROFILE/AppData/Roaming when APPDATA unset', () => {
    expect(
      defaultRegistryJsonPath({ USERPROFILE: 'C:\\Users\\u' }, 'com.pwa_debug.host'),
    ).toBe('C:\\Users\\u/AppData/Roaming/pwa-debug/com.pwa_debug.host.json');
  });

  it('throws when both APPDATA and USERPROFILE are unset', () => {
    expect(() => defaultRegistryJsonPath({}, 'x')).toThrow(/APPDATA.*USERPROFILE/);
  });
});
