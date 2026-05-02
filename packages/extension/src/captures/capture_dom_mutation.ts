import { createNodeIdAllocator, type NodeIdAllocator } from './node_ids.js';
import { summarizeNode } from './dom_serialize.js';
import type { Disposer, FrameMeta } from './capture_console.js';
import type {
  DomMutationCapturedEvent,
  DomMutationCaptureOptions,
  DomMutationPatch,
  NodeSummary,
} from './types.js';

const DEFAULT_DEPTH_CAP = 3;
const DEFAULT_COALESCE_MS = 16;
const DEFAULT_MAX_PATCHES = 500;

const nodeListSummaries = (
  nodes: NodeList,
  depthCap: number,
  allocator: NodeIdAllocator,
): readonly NodeSummary[] => {
  const out: NodeSummary[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (n !== undefined && n !== null) {
      out.push(summarizeNode(n, depthCap, allocator));
    }
  }
  return out;
};

const recordToPatch = (
  record: MutationRecord,
  depthCap: number,
  allocator: NodeIdAllocator,
): DomMutationPatch | null => {
  if (record.type === 'childList') {
    const target = summarizeNode(record.target, depthCap, allocator);
    const added = nodeListSummaries(record.addedNodes, depthCap, allocator);
    const removed = nodeListSummaries(record.removedNodes, depthCap, allocator);
    if (added.length === 0 && removed.length === 0) return null;
    return { kind: 'childList', target, added, removed };
  }
  if (record.type === 'attributes') {
    const target = summarizeNode(record.target, depthCap, allocator);
    const name = record.attributeName ?? '';
    const oldValue = record.oldValue;
    const newValue =
      record.target.nodeType === 1
        ? (record.target as Element).getAttribute(name)
        : null;
    return { kind: 'attributes', target, name, oldValue, newValue };
  }
  if (record.type === 'characterData') {
    const target = summarizeNode(record.target, depthCap, allocator);
    const oldValue = record.oldValue ?? '';
    const newValue = record.target.nodeValue ?? '';
    return { kind: 'characterData', target, oldValue, newValue };
  }
  return null;
};

export const installDomMutationCapture = (
  emit: (event: DomMutationCapturedEvent) => void,
  frame: FrameMeta,
  opts?: DomMutationCaptureOptions,
): Disposer => {
  if (
    typeof MutationObserver === 'undefined' ||
    typeof document === 'undefined'
  ) {
    return () => {};
  }

  const depthCap = opts?.depthCap ?? DEFAULT_DEPTH_CAP;
  const coalesceWindowMs = opts?.coalesceWindowMs ?? DEFAULT_COALESCE_MS;
  const maxPatchesPerEvent = opts?.maxPatchesPerEvent ?? DEFAULT_MAX_PATCHES;
  const now = (): number => Date.now();

  const allocator = createNodeIdAllocator();
  let pending: DomMutationPatch[] = [];
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const tryEmit = (event: DomMutationCapturedEvent): void => {
    try {
      emit(event);
    } catch {
      // Capture failure must never break the page.
    }
  };

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0 && dropped === 0) return;
    const patches: DomMutationPatch[] =
      dropped > 0 ? [...pending, { kind: 'overflow', dropped }] : pending;
    pending = [];
    dropped = 0;
    tryEmit(
      Object.freeze({
        kind: 'dom_mutation',
        ts: now(),
        frameUrl: frame.frameUrl,
        frameKey: frame.frameKey,
        patches: Object.freeze(patches),
      }) as DomMutationCapturedEvent,
    );
  };

  const scheduleFlush = (): void => {
    if (timer !== null) return;
    timer = setTimeout(flush, coalesceWindowMs);
  };

  const onRecords = (records: readonly MutationRecord[]): void => {
    if (disposed) return;
    for (const record of records) {
      const patch = recordToPatch(record, depthCap, allocator);
      if (patch === null) continue;
      if (pending.length >= maxPatchesPerEvent) {
        dropped += 1;
        continue;
      }
      pending.push(patch);
    }
    if (pending.length === 0 && dropped === 0) return;
    if (dropped > 0 || pending.length >= maxPatchesPerEvent) {
      flush();
      return;
    }
    scheduleFlush();
  };

  const observer = new MutationObserver(onRecords);
  try {
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
    });
  } catch {
    return () => {};
  }

  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = [];
    dropped = 0;
    allocator.dispose();
  };
};
