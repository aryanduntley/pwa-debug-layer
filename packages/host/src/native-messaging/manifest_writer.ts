import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstalledBrowser } from './browser_paths.js';

export type HostManifestJson = {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly type: 'stdio';
  readonly allowed_origins: readonly string[];
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
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, body, 'utf-8');
  await rename(tmp, path);
};

export const writeHostManifestForBrowsers = async (
  manifest: HostManifestJson,
  browsers: readonly InstalledBrowser[],
): Promise<readonly string[]> => {
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const written: string[] = [];
  for (const browser of browsers) {
    const path = join(browser.manifestDir, manifestFilename(manifest.name));
    await writeAtomic(path, body);
    written.push(path);
  }
  return written;
};

export const removeHostManifestForBrowsers = async (
  manifestName: string,
  browsers: readonly InstalledBrowser[],
): Promise<readonly string[]> => {
  const removed: string[] = [];
  for (const browser of browsers) {
    const path = join(browser.manifestDir, manifestFilename(manifestName));
    try {
      await unlink(path);
      removed.push(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return removed;
};
