import { randomUUID } from 'node:crypto';
import {
  createRingBuffer,
  type RingBuffer,
  type RingBufferTailOptions,
} from '../host_buffers/host_buffers.js';
import type { IpcEventEnvelope } from '../mcp/ipc/envelope.js';

export type HostCapturedEvent = {
  readonly ts: number;
  readonly kind: string;
  readonly [key: string]: unknown;
};

export type HostStoredEvent = HostCapturedEvent & {
  readonly receivedAt: number;
  readonly sessionId: string;
  readonly extensionId: string;
  readonly sequenceNumber: number;
};

export type BufferKind =
  | 'console'
  | 'network'
  | 'dom_mutations'
  | 'lifecycle'
  | 'store_change'
  | 'replay'
  | 'library_popup'
  | 'page_error';

export interface CapturesInOptions {
  readonly extensionId: string;
  readonly capacityPerKind?: number;
  readonly getNow?: () => number;
  readonly sessionId?: string;
  /**
   * Optional FIFO-eviction subscriber. Fires once per evicted entry on the
   * matching ring buffer, kind-curried so a single subscriber handles all
   * 4 buckets. Path 11 M8 wires host_archive.bridgeWriterToOnEvict here to
   * spill evictions to disk; tests can pass any sink. Absence preserves
   * the original drop-evicted behavior.
   */
  readonly onEvict?: (kind: BufferKind, evicted: HostStoredEvent) => void;
}

export interface CapturesInReceiveInput {
  readonly events: readonly HostCapturedEvent[];
}

export interface CapturesInStats {
  readonly perKind: Readonly<
    Record<
      BufferKind,
      { readonly received: number; readonly dropped: number; readonly size: number }
    >
  >;
  readonly droppedUnknown: number;
  readonly totals: { readonly received: number; readonly dropped: number };
  readonly sessionId: string;
  readonly extensionId: string;
}

/** Fired once per received+stored event, after it lands in its ring buffer. */
export type CapturesListener = (kind: BufferKind, event: HostStoredEvent) => void;

export interface CapturesIn {
  readonly receive: (input: CapturesInReceiveInput) => void;
  readonly tail: (
    kind: BufferKind,
    opts?: RingBufferTailOptions<HostStoredEvent>,
  ) => HostStoredEvent[];
  readonly buffer: (kind: BufferKind) => RingBuffer<HostStoredEvent>;
  readonly getStats: () => CapturesInStats;
  readonly clear: () => void;
  /**
   * Register a listener fired on every received+stored event (forward-only,
   * after ring-buffer push). Returns an unsubscribe fn. Consumed by popup
   * recording to capture a full-fidelity event stream into memory, immune to
   * ring-buffer eviction during a long session.
   */
  readonly subscribe: (listener: CapturesListener) => () => void;
}

const DEFAULT_CAPACITY_PER_KIND = 5000;

const BUFFER_KINDS: readonly BufferKind[] = [
  'console',
  'network',
  'dom_mutations',
  'lifecycle',
  'store_change',
  'replay',
  'library_popup',
  'page_error',
];

const kindToBucket = (kind: string): BufferKind | undefined => {
  switch (kind) {
    case 'console':
      return 'console';
    case 'fetch':
    case 'xhr':
    case 'websocket':
      return 'network';
    case 'dom_mutation':
      return 'dom_mutations';
    case 'lifecycle':
      return 'lifecycle';
    case 'store_change':
      return 'store_change';
    case 'replay':
      return 'replay';
    case 'library_popup':
      return 'library_popup';
    case 'page_error':
      return 'page_error';
    default:
      return undefined;
  }
};

export const createCapturesIn = (opts: CapturesInOptions): CapturesIn => {
  const extensionId = opts.extensionId;
  const capacity = opts.capacityPerKind ?? DEFAULT_CAPACITY_PER_KIND;
  const getNow = opts.getNow ?? Date.now;
  const sessionId = opts.sessionId ?? randomUUID();

  const onEvict = opts.onEvict;
  const makeBuffer = (kind: BufferKind): RingBuffer<HostStoredEvent> =>
    onEvict
      ? createRingBuffer<HostStoredEvent>({
          capacity,
          onEvict: (evicted) => onEvict(kind, evicted),
        })
      : createRingBuffer<HostStoredEvent>({ capacity });

  const buffers: Record<BufferKind, RingBuffer<HostStoredEvent>> = {
    console: makeBuffer('console'),
    network: makeBuffer('network'),
    dom_mutations: makeBuffer('dom_mutations'),
    lifecycle: makeBuffer('lifecycle'),
    store_change: makeBuffer('store_change'),
    replay: makeBuffer('replay'),
    library_popup: makeBuffer('library_popup'),
    page_error: makeBuffer('page_error'),
  };

  const received: Record<BufferKind, number> = {
    console: 0,
    network: 0,
    dom_mutations: 0,
    lifecycle: 0,
    store_change: 0,
    replay: 0,
    library_popup: 0,
    page_error: 0,
  };
  const dropped: Record<BufferKind, number> = {
    console: 0,
    network: 0,
    dom_mutations: 0,
    lifecycle: 0,
    store_change: 0,
    replay: 0,
    library_popup: 0,
    page_error: 0,
  };
  const sequence: Record<BufferKind, number> = {
    console: 0,
    network: 0,
    dom_mutations: 0,
    lifecycle: 0,
    store_change: 0,
    replay: 0,
    library_popup: 0,
    page_error: 0,
  };
  let droppedUnknown = 0;
  const listeners = new Set<CapturesListener>();

  const subscribe = (listener: CapturesListener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const receive = (input: CapturesInReceiveInput): void => {
    for (const event of input.events) {
      if (event === null || typeof event !== 'object') {
        droppedUnknown++;
        continue;
      }
      const e = event as Record<string, unknown>;
      if (typeof e.kind !== 'string') {
        droppedUnknown++;
        continue;
      }
      const bucket = kindToBucket(e.kind);
      if (bucket === undefined) {
        droppedUnknown++;
        continue;
      }
      if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) {
        dropped[bucket]++;
        continue;
      }
      sequence[bucket]++;
      const stored: HostStoredEvent = {
        ...(event as HostCapturedEvent),
        receivedAt: getNow(),
        sessionId,
        extensionId,
        sequenceNumber: sequence[bucket],
      };
      buffers[bucket].push(stored);
      received[bucket]++;
      for (const listener of listeners) {
        try {
          listener(bucket, stored);
        } catch {
          // A faulty subscriber must never break intake.
        }
      }
    }
  };

  const tail = (
    kind: BufferKind,
    tailOpts?: RingBufferTailOptions<HostStoredEvent>,
  ): HostStoredEvent[] => buffers[kind].tail(tailOpts);

  const buffer = (kind: BufferKind): RingBuffer<HostStoredEvent> =>
    buffers[kind];

  const getStats = (): CapturesInStats => {
    const perKindEntries = BUFFER_KINDS.map(
      (k): [BufferKind, { received: number; dropped: number; size: number }] => [
        k,
        Object.freeze({
          received: received[k],
          dropped: dropped[k],
          size: buffers[k].size(),
        }),
      ],
    );
    const perKind = Object.freeze(
      Object.fromEntries(perKindEntries) as Record<
        BufferKind,
        { received: number; dropped: number; size: number }
      >,
    );
    let totalReceived = 0;
    let totalDropped = droppedUnknown;
    for (const k of BUFFER_KINDS) {
      totalReceived += received[k];
      totalDropped += dropped[k];
    }
    return Object.freeze({
      perKind,
      droppedUnknown,
      totals: Object.freeze({ received: totalReceived, dropped: totalDropped }),
      sessionId,
      extensionId,
    });
  };

  const clear = (): void => {
    for (const k of BUFFER_KINDS) {
      buffers[k].clear();
      received[k] = 0;
      dropped[k] = 0;
      sequence[k] = 0;
    }
    droppedUnknown = 0;
  };

  return Object.freeze({ receive, tail, buffer, getStats, clear, subscribe });
};

export const CAPTURES_EVENT_TOOL = 'captures' as const;

export interface CapturesIntakeEventPayload {
  readonly events: readonly HostCapturedEvent[];
}

export interface CapturesRegistryOptions {
  readonly capacityPerKind?: number;
  readonly getNow?: () => number;
  /**
   * Optional host-process session id shared across every CapturesIn the
   * registry creates. M8 mints one hostSessionId at boot and passes it
   * here so the on-disk archive (also keyed by sessionId) matches the
   * cursors the tail tools encode. Absence falls back to the per-instance
   * randomUUID default (one fresh sessionId per extension), which is the
   * pre-M8 behavior.
   */
  readonly sessionId?: string;
  /**
   * Shared FIFO-eviction subscriber forwarded to every CapturesIn the
   * registry creates. M8 wires host_archive.bridgeWriterToOnEvict here so
   * evictions across all attached extensions spill to one writer (and
   * therefore one on-disk session subtree). Absence preserves silent
   * drop-on-eviction.
   */
  readonly onEvict?: (kind: BufferKind, evicted: HostStoredEvent) => void;
}

export interface CapturesRegistry {
  readonly getOrCreate: (extensionId: string) => CapturesIn;
  readonly get: (extensionId: string) => CapturesIn | undefined;
  readonly list: () => readonly { readonly extensionId: string; readonly captures: CapturesIn }[];
  readonly clear: () => void;
}

export interface CapturesEventDispatchHooks {
  readonly onMismatch?: (message: string) => void;
  readonly onInvalid?: (message: string) => void;
}

export const createCapturesRegistry = (
  opts: CapturesRegistryOptions = {},
): CapturesRegistry => {
  const map = new Map<string, CapturesIn>();

  const getOrCreate = (extensionId: string): CapturesIn => {
    const existing = map.get(extensionId);
    if (existing !== undefined) return existing;
    const created = createCapturesIn({
      extensionId,
      ...(opts.capacityPerKind !== undefined && { capacityPerKind: opts.capacityPerKind }),
      ...(opts.getNow !== undefined && { getNow: opts.getNow }),
      ...(opts.sessionId !== undefined && { sessionId: opts.sessionId }),
      ...(opts.onEvict !== undefined && { onEvict: opts.onEvict }),
    });
    map.set(extensionId, created);
    return created;
  };

  const get = (extensionId: string): CapturesIn | undefined => map.get(extensionId);

  const list = (): readonly { readonly extensionId: string; readonly captures: CapturesIn }[] =>
    Object.freeze(
      Array.from(map.entries(), ([extensionId, captures]) =>
        Object.freeze({ extensionId, captures }),
      ),
    );

  const clear = (): void => {
    map.clear();
  };

  return Object.freeze({ getOrCreate, get, list, clear });
};

const isIntakePayload = (v: unknown): v is CapturesIntakeEventPayload => {
  if (v === null || typeof v !== 'object') return false;
  return Array.isArray((v as { events?: unknown }).events);
};

export const dispatchCapturesEvent = (
  registry: CapturesRegistry,
  extensionId: string,
  env: IpcEventEnvelope,
  hooks?: CapturesEventDispatchHooks,
): void => {
  if (env.tool !== CAPTURES_EVENT_TOOL) return;
  if (env.extensionId !== undefined && env.extensionId !== extensionId) {
    hooks?.onMismatch?.(
      `dispatchCapturesEvent: envelope.extensionId=${env.extensionId} does not match connection.extensionId=${extensionId}; dropping`,
    );
    return;
  }
  if (!isIntakePayload(env.payload)) {
    hooks?.onInvalid?.(
      `dispatchCapturesEvent: invalid intake payload from ${extensionId}; dropping`,
    );
    return;
  }
  registry.getOrCreate(extensionId).receive({ events: env.payload.events });
};
