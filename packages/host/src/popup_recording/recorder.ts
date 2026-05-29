// Intent-driven popup recording (Path 6 M-D). A bounded, AI-triggered capture:
// start subscribes to the extension's captures intake and buffers every
// library_popup event (primary + nested, in arrival order) IN MEMORY — immune
// to ring-buffer eviction during a long session — until stop persists the
// stream to <config>/pwa-debug/popup-recordings/<label>/events.jsonl (+ meta).
// Forward-only: only events received between start and stop are recorded. The
// long-lived MCP host owns the active-recording state (lost on host restart,
// which is fine for a session-scoped intent). Side effects (fs) at the edges.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CapturesIn, HostStoredEvent } from '../captures_in/captures_in.js';
import { atomicWriteJson, xdgConfigPath, type XdgEnv } from '../host_io/host_io.js';

export const RECORDINGS_SUBDIR = 'popup-recordings';

export type RecordingStatus = {
  readonly active: boolean;
  readonly label?: string;
  readonly startedAt?: number;
  readonly count?: number;
};

export type StopResult = {
  readonly label: string;
  readonly path: string;
  readonly dir: string;
  readonly count: number;
  readonly startedAt: number;
  readonly stoppedAt: number;
};

type Active = {
  readonly label: string;
  readonly startedAt: number;
  readonly events: HostStoredEvent[];
  readonly unsubscribe: () => void;
};

// Per-extension active recording (module state in the long-lived MCP host).
const active = new Map<string, Active>();

/** Sanitize a label into one safe path segment. */
export const sanitizeLabel = (label: string): string => {
  const cleaned = label
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'recording';
};

export const isRecording = (extensionId: string): boolean =>
  active.has(extensionId);

export const recordingStatus = (extensionId: string): RecordingStatus => {
  const rec = active.get(extensionId);
  if (rec === undefined) return { active: false };
  return {
    active: true,
    label: rec.label,
    startedAt: rec.startedAt,
    count: rec.events.length,
  };
};

/**
 * Start a recording: subscribe to the extension's captures intake and buffer
 * every library_popup event until stop. Idempotent — returns the in-progress
 * status if one is already active for this extension.
 */
export const startRecording = (
  captures: CapturesIn,
  extensionId: string,
  label: string,
  startedAt: number,
): RecordingStatus => {
  const existing = active.get(extensionId);
  if (existing !== undefined) {
    return {
      active: true,
      label: existing.label,
      startedAt: existing.startedAt,
      count: existing.events.length,
    };
  }
  const events: HostStoredEvent[] = [];
  const unsubscribe = captures.subscribe((kind, event) => {
    if (kind === 'library_popup') events.push(event);
  });
  active.set(extensionId, { label, startedAt, events, unsubscribe });
  return { active: true, label, startedAt, count: 0 };
};

const eventsPath = (label: string, env?: XdgEnv): string =>
  xdgConfigPath(`${RECORDINGS_SUBDIR}/${label}/events.jsonl`, env);

const metaPath = (label: string, env?: XdgEnv): string =>
  xdgConfigPath(`${RECORDINGS_SUBDIR}/${label}/meta.json`, env);

/**
 * Stop a recording: unsubscribe, write the buffered events to events.jsonl
 * (overwriting any prior file for this label) + meta.json, clear state, and
 * return the path + count. Returns undefined when no recording is active.
 */
export const stopRecording = async (
  extensionId: string,
  stoppedAt: number,
  env?: XdgEnv,
): Promise<StopResult | undefined> => {
  const rec = active.get(extensionId);
  if (rec === undefined) return undefined;
  rec.unsubscribe();
  active.delete(extensionId);

  const path = eventsPath(rec.label, env);
  await mkdir(dirname(path), { recursive: true });
  const body =
    rec.events.length === 0
      ? ''
      : `${rec.events.map((e) => JSON.stringify(e)).join('\n')}\n`;
  await writeFile(path, body, { encoding: 'utf-8', mode: 0o600 });
  await atomicWriteJson(metaPath(rec.label, env), {
    label: rec.label,
    extensionId,
    startedAt: rec.startedAt,
    stoppedAt,
    count: rec.events.length,
  });

  return {
    label: rec.label,
    path,
    dir: dirname(path),
    count: rec.events.length,
    startedAt: rec.startedAt,
    stoppedAt,
  };
};
