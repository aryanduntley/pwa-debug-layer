import { describe, it, expect } from 'vitest';
import {
  findAdb,
  forwardSocket,
  listDevices,
  listSockets,
  removeForward,
  removeReverse,
  reversePort,
  type AdbContext,
} from '../../src/android_adb/adb.js';
import type { AdbDeps, AdbRunResult } from '../../src/android_adb/node_deps.js';

type Script = (args: readonly string[]) => Partial<AdbRunResult>;

const ctx = (script: Script) => {
  const calls: string[][] = [];
  const deps: AdbDeps = {
    which: async () => null,
    fileExists: async () => false,
    run: async (_p, args) => {
      calls.push([...args]);
      return { code: 0, stdout: '', stderr: '', ...script(args) };
    },
    env: {},
    platform: 'linux',
  };
  const adb: AdbContext = { adbPath: '/sdk/adb', deps };
  return { adb, calls };
};

describe('findAdb', () => {
  const base: AdbDeps = { which: async () => null, fileExists: async () => false, run: async () => ({ code: 0, stdout: '', stderr: '' }), env: { HOME: '/home/u' }, platform: 'linux' };

  it('prefers PATH', async () => {
    expect(await findAdb({ ...base, which: async () => '/usr/bin/adb' })).toEqual({ ok: true, value: '/usr/bin/adb' });
  });

  it('falls back to the SDK location', async () => {
    const r = await findAdb({ ...base, fileExists: async (p) => p === '/home/u/Android/Sdk/platform-tools/adb' });
    expect(r).toEqual({ ok: true, value: '/home/u/Android/Sdk/platform-tools/adb' });
  });

  it('reports not_installed', async () => {
    expect(await findAdb(base)).toMatchObject({ ok: false, kind: 'not_installed' });
  });
});

describe('adb operations', () => {
  it('lists devices', async () => {
    const { adb, calls } = ctx(() => ({ stdout: 'List of devices attached\nR5 device model:SM\n' }));
    expect(await listDevices(adb)).toMatchObject({ ok: true, value: [{ serial: 'R5', state: 'device', model: 'SM' }] });
    expect(calls).toEqual([['devices', '-l']]);
  });

  it('classifies a failing command from stderr', async () => {
    const { adb } = ctx(() => ({ code: 1, stderr: 'error: device unauthorized.' }));
    expect(await listSockets(adb, 'R5')).toMatchObject({ ok: false, kind: 'unauthorized' });
  });

  it('resolves WebView sockets to their app package', async () => {
    const { adb } = ctx((args) =>
      args.includes('/proc/net/unix')
        ? { stdout: '0: 00000002 0 00010000 0001 01 1 @webview_devtools_remote_4242\n0: 00000002 0 00010000 0001 01 2 @chrome_devtools_remote\n' }
        : args.includes('/proc/4242/cmdline')
          ? { stdout: 'com.example.app\0\0' }
          : {},
    );
    const r = await listSockets(adb, 'R5');
    expect(r).toEqual({
      ok: true,
      value: [
        { socket: 'chrome_devtools_remote', kind: 'chrome', package: 'com.android.chrome' },
        { socket: 'webview_devtools_remote_4242', kind: 'webview', pid: 4242, package: 'com.example.app' },
      ],
    });
  });

  it('reuses an existing forward for the same device and socket', async () => {
    const { adb, calls } = ctx((args) =>
      args[0] === 'forward' && args[1] === '--list'
        ? { stdout: 'OTHER tcp:1111 localabstract:chrome_devtools_remote\nR5 tcp:9223 localabstract:chrome_devtools_remote\n' }
        : {},
    );
    expect(await forwardSocket(adb, 'R5', 'chrome_devtools_remote')).toEqual({ ok: true, value: { port: 9223, reused: true } });
    expect(calls).toHaveLength(1);
  });

  it('allocates a free port with tcp:0 when no forward exists', async () => {
    const { adb, calls } = ctx((args) => (args.includes('tcp:0') ? { stdout: '39339\n' } : { stdout: '' }));
    expect(await forwardSocket(adb, 'R5', 'chrome_devtools_remote')).toEqual({ ok: true, value: { port: 39339, reused: false } });
    expect(calls[1]).toEqual(['-s', 'R5', 'forward', 'tcp:0', 'localabstract:chrome_devtools_remote']);
  });

  it('fails when adb prints no port', async () => {
    const { adb } = ctx((args) => (args.includes('tcp:0') ? { stdout: 'weird' } : {}));
    expect(await forwardSocket(adb, 'R5', 'x')).toMatchObject({ ok: false, kind: 'failed' });
  });

  it('removes forwards and adds/removes reverses with the right arguments', async () => {
    const { adb, calls } = ctx(() => ({}));
    await removeForward(adb, 'R5', 9223);
    await reversePort(adb, 'R5', 5173);
    await removeReverse(adb, 'R5', 5173);
    expect(calls).toEqual([
      ['-s', 'R5', 'forward', '--remove', 'tcp:9223'],
      ['-s', 'R5', 'reverse', 'tcp:5173', 'tcp:5173'],
      ['-s', 'R5', 'reverse', '--remove', 'tcp:5173'],
    ]);
  });
});
