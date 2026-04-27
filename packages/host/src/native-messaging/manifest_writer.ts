import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  BrowserInstall,
  BrowserName,
  InstallKind,
} from './browser_paths.js';
import type { RegistryGateway } from './registry_writer.js';

export type HostManifestJson = {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly type: 'stdio';
  readonly allowed_origins: readonly string[];
};

export type ManifestWriteResult = {
  readonly browser: BrowserName;
  readonly kind: InstallKind;
  readonly manifestPath: string;
  readonly registrySubkey?: string;
};

export type ManifestInstallOptions = {
  readonly registryJsonPath?: string;
  readonly registry?: RegistryGateway;
};

const extensionIdToOrigin = (id: string): string => `chrome-extension://${id}/`;

export const buildHostManifest = (input: {
  readonly name: string;
  readonly description: string;
  readonly hostBinaryPath: string;
  readonly allowedExtensionIds: readonly string[];
}): HostManifestJson => {
  if (input.allowedExtensionIds.length === 0) {
    throw new Error('manifest_writer: allowedExtensionIds is empty; Chrome rejects manifests with no allowed_origins');
  }
  const origins = Object.freeze(
    [...new Set(input.allowedExtensionIds.map(extensionIdToOrigin))].sort(),
  );
  return Object.freeze({
    name: input.name,
    description: input.description,
    path: input.hostBinaryPath,
    type: 'stdio',
    allowed_origins: origins,
  });
};

const manifestFilename = (manifestName: string): string => `${manifestName}.json`;

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, body, 'utf-8');
  await rename(tmp, path);
};

const unlinkIfExists = async (path: string): Promise<boolean> => {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
};

const requireRegistryOptions = (
  installs: readonly BrowserInstall[],
  options: ManifestInstallOptions,
): { jsonPath: string; gateway: RegistryGateway } => {
  if (!options.registryJsonPath) {
    throw new Error(
      'manifest_writer: registryJsonPath is required when any install.kind === "registry"',
    );
  }
  if (!options.registry) {
    throw new Error(
      'manifest_writer: registry gateway is required when any install.kind === "registry"',
    );
  }
  void installs;
  return { jsonPath: options.registryJsonPath, gateway: options.registry };
};

export const installManifestForBrowsers = async (
  manifest: HostManifestJson,
  installs: readonly BrowserInstall[],
  options: ManifestInstallOptions = {},
): Promise<readonly ManifestWriteResult[]> => {
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const out: ManifestWriteResult[] = [];

  let registryJsonPathWritten = false;
  for (const install of installs) {
    if (install.kind === 'registry') {
      const { jsonPath, gateway } = requireRegistryOptions(installs, options);
      if (!registryJsonPathWritten) {
        await writeAtomic(jsonPath, body);
        registryJsonPathWritten = true;
      }
      await gateway.setDefault(install.registryHive, install.registrySubkey, jsonPath);
      out.push(
        Object.freeze({
          browser: install.browser,
          kind: 'registry' as const,
          manifestPath: jsonPath,
          registrySubkey: install.registrySubkey,
        }),
      );
      continue;
    }
    const path = join(install.manifestDir, manifestFilename(manifest.name));
    await writeAtomic(path, body);
    out.push(
      Object.freeze({
        browser: install.browser,
        kind: install.kind,
        manifestPath: path,
      }),
    );
  }
  return Object.freeze(out);
};

export const uninstallManifestForBrowsers = async (
  manifestName: string,
  installs: readonly BrowserInstall[],
  options: ManifestInstallOptions = {},
): Promise<readonly ManifestWriteResult[]> => {
  const out: ManifestWriteResult[] = [];

  for (const install of installs) {
    if (install.kind === 'registry') {
      const { gateway } = requireRegistryOptions(installs, options);
      await gateway.removeKey(install.registryHive, install.registrySubkey);
      out.push(
        Object.freeze({
          browser: install.browser,
          kind: 'registry' as const,
          manifestPath: options.registryJsonPath ?? '',
          registrySubkey: install.registrySubkey,
        }),
      );
      continue;
    }
    const path = join(install.manifestDir, manifestFilename(manifestName));
    if (await unlinkIfExists(path)) {
      out.push(
        Object.freeze({
          browser: install.browser,
          kind: install.kind,
          manifestPath: path,
        }),
      );
    }
  }

  if (options.registryJsonPath) {
    const anyRegistry = installs.some((i) => i.kind === 'registry');
    if (anyRegistry) {
      await unlinkIfExists(options.registryJsonPath);
    }
  }

  return Object.freeze(out);
};
