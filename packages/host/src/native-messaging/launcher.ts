import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type LauncherSpec = {
  readonly nodePath: string;
  readonly mainJsPath: string;
};

export type WrittenLauncher = {
  readonly launcherPath: string;
};

const POSIX_HEADER = [
  '#!/bin/sh',
  '# pwa-debug native messaging host launcher (POSIX).',
  '# Generated at install time. Embeds an absolute node path so spawn works',
  '# under sandboxed/stripped PATH environments (snap, flatpak).',
];

const WINDOWS_HEADER = [
  '@echo off',
  'rem pwa-debug native messaging host launcher (Windows).',
  'rem Generated at install time. Embeds an absolute node.exe path.',
];

export const buildPosixLauncher = (spec: LauncherSpec): string => {
  if (spec.nodePath.includes("'") || spec.mainJsPath.includes("'")) {
    throw new Error(
      'launcher: nodePath/mainJsPath must not contain single quotes (POSIX shell quoting)',
    );
  }
  const lines = [
    ...POSIX_HEADER,
    `exec '${spec.nodePath}' '${spec.mainJsPath}' "$@"`,
    '',
  ];
  return lines.join('\n');
};

export const buildWindowsLauncher = (spec: LauncherSpec): string => {
  if (spec.nodePath.includes('"') || spec.mainJsPath.includes('"')) {
    throw new Error(
      'launcher: nodePath/mainJsPath must not contain double quotes (Windows .bat quoting)',
    );
  }
  const lines = [
    ...WINDOWS_HEADER,
    `"${spec.nodePath}" "${spec.mainJsPath}" %*`,
    '',
  ];
  return lines.join('\r\n');
};

export const defaultLauncherPath = (
  platform: NodeJS.Platform,
  env: { HOME?: string; XDG_CONFIG_HOME?: string; APPDATA?: string },
): string => {
  if (platform === 'win32') {
    if (!env.APPDATA || env.APPDATA.length === 0) {
      throw new Error('launcher: APPDATA env var unset on win32');
    }
    return join(env.APPDATA, 'pwa-debug', 'pwa-debug-host.bat');
  }
  const configHome =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : env.HOME
        ? join(env.HOME, '.config')
        : null;
  if (!configHome) {
    throw new Error('launcher: HOME and XDG_CONFIG_HOME both unset on posix');
  }
  return join(configHome, 'pwa-debug', 'bin', 'pwa-debug-host');
};

export const writeLauncher = async (
  platform: NodeJS.Platform,
  spec: LauncherSpec,
  launcherPath: string,
): Promise<WrittenLauncher> => {
  const body =
    platform === 'win32' ? buildWindowsLauncher(spec) : buildPosixLauncher(spec);
  await mkdir(dirname(launcherPath), { recursive: true });
  const tmp = `${launcherPath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, body, 'utf-8');
  await rename(tmp, launcherPath);
  if (platform !== 'win32') {
    await chmod(launcherPath, 0o755);
  }
  return Object.freeze({ launcherPath });
};
