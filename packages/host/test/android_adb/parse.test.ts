import { describe, it, expect } from 'vitest';
import {
  adbPathCandidates,
  classifyAdbFailure,
  parseDevices,
  parseDevtoolsSockets,
  parseForwards,
} from '../../src/android_adb/parse.js';

// Captured from a Galaxy S24 Ultra (Android 16, Chrome 156), adb 1.0.41.
const DEVICES = `List of devices attached
R5CX52E7J8X            device usb:5-1 product:e3quew model:SM_S928U1 device:e3q transport_id:7
emulator-5554          unauthorized transport_id:9
ZY22ABC                offline
XYZ                    recovery

`;

const PROC_NET_UNIX = `Num       RefCount Protocol Flags    Type St Inode Path
0000000000000000: 00000003 00000000 00000000 0001 03 85933
0000000000000000: 00000002 00000000 00010000 0001 01 34935517 @chrome_devtools_remote
0000000000000000: 00000002 00000000 00010000 0001 01 35042897 @stetho_com.google.android.apps.messaging_devtools_remote
0000000000000000: 00000002 00000000 00010000 0001 01 33382876 @stetho_com.google.android.apps.messaging:rcs_devtools_remote
0000000000000000: 00000002 00000000 00010000 0001 01 33382877 @webview_devtools_remote_18468
0000000000000000: 00000002 00000000 00010000 0001 01 33382878 @com.brave.browser_devtools_remote
0000000000000000: 00000003 00000000 00000000 0001 03 33382879 @chrome_devtools_remote
0000000000000000: 00000002 00000000 00010000 0001 01 1 /dev/socket/zygote
`;

const FORWARDS = `R5CX52E7J8X tcp:9223 localabstract:chrome_devtools_remote
R5CX52E7J8X tcp:39339 localabstract:chrome_devtools_remote
emulator-5554 localfilesystem:/tmp/x localabstract:foo
`;

describe('parseDevices', () => {
  it('reads serial, state and -l attributes', () => {
    const d = parseDevices(DEVICES);
    expect(d[0]).toEqual({
      serial: 'R5CX52E7J8X',
      state: 'device',
      rawState: 'device',
      model: 'SM_S928U1',
      product: 'e3quew',
      device: 'e3q',
      transportId: '7',
    });
    expect(d.map((x) => [x.serial, x.state, x.rawState])).toEqual([
      ['R5CX52E7J8X', 'device', 'device'],
      ['emulator-5554', 'unauthorized', 'unauthorized'],
      ['ZY22ABC', 'offline', 'offline'],
      ['XYZ', 'other', 'recovery'],
    ]);
  });

  it('ignores daemon start-up noise and empty output', () => {
    expect(parseDevices('* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n\n')).toEqual([]);
    expect(parseDevices('')).toEqual([]);
  });
});

describe('parseDevtoolsSockets', () => {
  it('finds Chrome, WebView and other browser sockets, drops Stetho and duplicates', () => {
    expect(parseDevtoolsSockets(PROC_NET_UNIX)).toEqual([
      { socket: 'chrome_devtools_remote', kind: 'chrome', package: 'com.android.chrome' },
      { socket: 'com.brave.browser_devtools_remote', kind: 'browser', package: 'com.brave.browser' },
      { socket: 'webview_devtools_remote_18468', kind: 'webview', pid: 18468 },
    ]);
  });

  it('returns nothing when no browser is running', () => {
    expect(parseDevtoolsSockets('Num RefCount\n0000: 00000002 00000000 00010000 0001 01 1 /dev/socket/zygote\n')).toEqual([]);
  });
});

describe('parseForwards', () => {
  it('reads forwards and their local tcp port', () => {
    expect(parseForwards(FORWARDS)).toEqual([
      { serial: 'R5CX52E7J8X', local: 'tcp:9223', remote: 'localabstract:chrome_devtools_remote', localPort: 9223 },
      { serial: 'R5CX52E7J8X', local: 'tcp:39339', remote: 'localabstract:chrome_devtools_remote', localPort: 39339 },
      { serial: 'emulator-5554', local: 'localfilesystem:/tmp/x', remote: 'localabstract:foo' },
    ]);
  });
});

describe('classifyAdbFailure', () => {
  it.each([
    ['error: device unauthorized.\nThis adb server\'s $ADB_VENDOR_KEYS is not set', 'unauthorized'],
    ['error: device offline', 'offline'],
    ['error: more than one device/emulator', 'multiple_devices'],
    ['error: no devices/emulators found', 'no_device'],
    ["error: device 'nope' not found", 'no_device'],
    ['cat: /proc/99999/cmdline: No such file or directory', 'not_found'],
    ['something else', 'failed'],
  ])('%s -> %s', (out, kind) => {
    expect(classifyAdbFailure(out)).toBe(kind);
  });
});

describe('adbPathCandidates', () => {
  it('lists SDK locations per platform, de-duplicated', () => {
    expect(adbPathCandidates({ HOME: '/home/u', ANDROID_HOME: '/opt/sdk', ANDROID_SDK_ROOT: '/opt/sdk' }, 'linux')).toEqual([
      '/opt/sdk/platform-tools/adb',
      '/home/u/Android/Sdk/platform-tools/adb',
    ]);
    expect(adbPathCandidates({ HOME: '/Users/u' }, 'darwin')).toEqual(['/Users/u/Library/Android/sdk/platform-tools/adb']);
    expect(adbPathCandidates({}, 'linux')).toEqual([]);
  });
});
