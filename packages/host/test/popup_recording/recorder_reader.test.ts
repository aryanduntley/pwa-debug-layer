import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapturesIn } from '../../src/captures_in/captures_in.js';
import {
  startRecording,
  stopRecording,
  recordingStatus,
  isRecording,
} from '../../src/popup_recording/recorder.js';
import { readRecording, listRecordings } from '../../src/popup_recording/reader.js';
import type { FlatResult, TreeResult } from '../../src/popup_recording/reader.js';

let dir: string;
let env: { XDG_CONFIG_HOME: string };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwa-rec-'));
  env = { XDG_CONFIG_HOME: dir };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const popup = (
  popupId: string,
  role: 'primary' | 'nested',
  parentPopupId: string | null,
  phase: string,
): Record<string, unknown> => ({
  kind: 'library_popup',
  ts: 1,
  frameUrl: 'https://x/',
  frameKey: 'top',
  popupId,
  role,
  parentPopupId,
  phase,
  library: 'walletconnect',
  detection: 'shadow',
  host: { tagName: 'W3M-MODAL' },
});

describe('popup recording — recorder + reader', () => {
  it('records the live library_popup stream and projects it three ways', async () => {
    const captures = createCapturesIn({ extensionId: 'aaa' });
    const started = startRecording(captures, 'aaa', 'test-rec', 1000);
    expect(started.active).toBe(true);
    expect(isRecording('aaa')).toBe(true);

    // Primary + nested popup events are recorded; the console event is ignored.
    captures.receive({
      events: [
        popup('P', 'primary', null, 'appeared'),
        popup('N1', 'nested', 'P', 'appeared'),
        { kind: 'console', ts: 1, frameKey: 'top', level: 'error', args: ['x'] },
        popup('P', 'primary', null, 'disappeared'),
      ],
    });
    expect(recordingStatus('aaa').count).toBe(3);

    const stop = await stopRecording('aaa', 2000, env);
    expect(stop).toBeDefined();
    expect(stop!.count).toBe(3);
    expect(isRecording('aaa')).toBe(false);

    const flat = (await readRecording('test-rec', 'flat', {}, env)) as FlatResult;
    expect(flat.mode).toBe('flat');
    expect(flat.total).toBe(3);

    const primary = (await readRecording('test-rec', 'primary', {}, env)) as FlatResult;
    expect(primary.total).toBe(2); // both P events; N1 (nested) excluded

    const tree = (await readRecording('test-rec', 'tree', {}, env)) as TreeResult;
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.popupId).toBe('P');
    expect(tree.roots[0]!.children.map((c) => c.popupId)).toEqual(['N1']);

    const recs = await listRecordings(env);
    expect(recs.some((r) => r.label === 'test-rec' && r.count === 3)).toBe(true);
  });

  it('status is inactive and stop is a no-op when not recording', async () => {
    expect(recordingStatus('zzz')).toEqual({ active: false });
    expect(await stopRecording('zzz', 1, env)).toBeUndefined();
  });

  it('start is idempotent while a recording is active', async () => {
    const captures = createCapturesIn({ extensionId: 'bbb' });
    startRecording(captures, 'bbb', 'first', 1);
    const again = startRecording(captures, 'bbb', 'second', 2);
    expect(again.label).toBe('first'); // returns the in-progress one
    await stopRecording('bbb', 3, env);
  });
});
