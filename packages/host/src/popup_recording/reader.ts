// Reader for popup recordings written by recorder.ts. Loads a recording's
// events.jsonl and projects it three ways for popup_replay:
//   - 'flat'    : the raw event sequence (paginated)
//   - 'primary' : only role!=='nested' events (paginated)
//   - 'tree'    : a hierarchy of popup nodes (primary roots, nested children
//                 attached by parentPopupId), each node summarizing its phases
// Pure transforms over the parsed lines; fs reads via host_io.

import { readdir } from 'node:fs/promises';
import { readLines, readJsonOr, xdgConfigPath, type XdgEnv } from '../host_io/host_io.js';
import { RECORDINGS_SUBDIR } from './recorder.js';

export type ReplayMode = 'flat' | 'primary' | 'tree';

type Ev = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

export type RecordingSummary = {
  readonly label: string;
  readonly count?: number;
  readonly startedAt?: number;
  readonly stoppedAt?: number;
};

export type PopupNode = {
  readonly popupId: string;
  readonly role: string;
  readonly library?: string;
  readonly detection?: string;
  readonly host?: unknown;
  readonly parentPopupId: string | null;
  readonly phases: string[];
  readonly children: PopupNode[];
};

export type FlatResult = {
  readonly mode: 'flat' | 'primary';
  readonly total: number;
  readonly offset: number;
  readonly entries: readonly Ev[];
  readonly hasMore: boolean;
};

export type TreeResult = {
  readonly mode: 'tree';
  readonly total: number;
  readonly roots: readonly PopupNode[];
};

const readEvents = async (label: string, env?: XdgEnv): Promise<Ev[]> => {
  const path = xdgConfigPath(`${RECORDINGS_SUBDIR}/${label}/events.jsonl`, env);
  const out: Ev[] = [];
  for await (const line of readLines(path)) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const o: unknown = JSON.parse(t);
      if (o !== null && typeof o === 'object') out.push(o as Ev);
    } catch {
      // skip malformed line
    }
  }
  return out;
};

const buildTree = (events: readonly Ev[]): PopupNode[] => {
  const order: string[] = [];
  const nodes = new Map<string, PopupNode & { phases: string[]; children: PopupNode[] }>();
  for (const e of events) {
    const id = str(e.popupId);
    if (id === undefined) continue;
    let node = nodes.get(id);
    if (node === undefined) {
      const parentRaw = (e as { parentPopupId?: unknown }).parentPopupId;
      const lib = str(e.library);
      const det = str(e.detection);
      const hostVal = (e as { host?: unknown }).host;
      node = {
        popupId: id,
        role: str(e.role) ?? 'primary',
        ...(lib !== undefined ? { library: lib } : {}),
        ...(det !== undefined ? { detection: det } : {}),
        ...(hostVal !== undefined ? { host: hostVal } : {}),
        parentPopupId: typeof parentRaw === 'string' ? parentRaw : null,
        phases: [],
        children: [],
      };
      nodes.set(id, node);
      order.push(id);
    }
    const phase = str(e.phase);
    if (phase !== undefined) node.phases.push(phase);
  }
  const roots: PopupNode[] = [];
  for (const id of order) {
    const node = nodes.get(id)!;
    const parent = node.parentPopupId !== null ? nodes.get(node.parentPopupId) : undefined;
    if (parent !== undefined) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
};

export const readRecording = async (
  label: string,
  mode: ReplayMode,
  opts: { readonly offset?: number; readonly limit?: number },
  env?: XdgEnv,
): Promise<FlatResult | TreeResult> => {
  const events = await readEvents(label, env);
  if (mode === 'tree') {
    return { mode: 'tree', total: events.length, roots: buildTree(events) };
  }
  const filtered =
    mode === 'primary' ? events.filter((e) => str(e.role) !== 'nested') : events;
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(Math.max(1, opts.limit ?? 500), 2000);
  const entries = filtered.slice(offset, offset + limit);
  return {
    mode,
    total: filtered.length,
    offset,
    entries,
    hasMore: offset + limit < filtered.length,
  };
};

export const listRecordings = async (
  env?: XdgEnv,
): Promise<RecordingSummary[]> => {
  const dirPath = xdgConfigPath(RECORDINGS_SUBDIR, env);
  let labels: string[];
  try {
    const dirents = await readdir(dirPath, { withFileTypes: true });
    labels = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: RecordingSummary[] = [];
  for (const label of labels) {
    const meta = await readJsonOr<Record<string, unknown> | null>(
      xdgConfigPath(`${RECORDINGS_SUBDIR}/${label}/meta.json`, env),
      null,
      (raw) => (raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null),
    );
    out.push({
      label,
      ...(meta !== null
        ? {
            ...(typeof meta.count === 'number' ? { count: meta.count } : {}),
            ...(typeof meta.startedAt === 'number' ? { startedAt: meta.startedAt } : {}),
            ...(typeof meta.stoppedAt === 'number' ? { stoppedAt: meta.stoppedAt } : {}),
          }
        : {}),
    });
  }
  return out;
};
