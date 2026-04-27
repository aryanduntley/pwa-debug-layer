import Registry from 'winreg';
import { join } from 'node:path';

export type RegistryGateway = {
  readonly setDefault: (
    hive: 'HKCU',
    subkey: string,
    valueData: string,
  ) => Promise<void>;
  readonly removeKey: (hive: 'HKCU', subkey: string) => Promise<void>;
};

const ensureLeadingBackslash = (key: string): string =>
  key.startsWith('\\') ? key : `\\${key}`;

export const defaultRegistryGateway = (): RegistryGateway =>
  Object.freeze({
    setDefault: (hive, subkey, valueData) =>
      new Promise((resolve, reject) => {
        const reg = new Registry({ hive, key: ensureLeadingBackslash(subkey) });
        reg.create((createErr) => {
          if (createErr) return reject(createErr);
          reg.set('', Registry.REG_SZ, valueData, (setErr) => {
            if (setErr) return reject(setErr);
            resolve();
          });
        });
      }),
    removeKey: (hive, subkey) =>
      new Promise((resolve, reject) => {
        const reg = new Registry({ hive, key: ensureLeadingBackslash(subkey) });
        reg.keyExists((existsErr, exists) => {
          if (existsErr) return reject(existsErr);
          if (!exists) return resolve();
          reg.destroy((destroyErr) => {
            if (destroyErr) return reject(destroyErr);
            resolve();
          });
        });
      }),
  });

export const defaultRegistryJsonPath = (
  env: { APPDATA?: string; USERPROFILE?: string },
  manifestName: string,
): string => {
  const appdata =
    env.APPDATA && env.APPDATA.length > 0
      ? env.APPDATA
      : env.USERPROFILE && env.USERPROFILE.length > 0
        ? join(env.USERPROFILE, 'AppData', 'Roaming')
        : null;
  if (!appdata) {
    throw new Error('registry_writer: APPDATA and USERPROFILE both unset on win32');
  }
  return join(appdata, 'pwa-debug', `${manifestName}.json`);
};
