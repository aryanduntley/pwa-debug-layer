import { describe, it, expect, afterEach } from 'vitest';
import {
  installConsoleCapture,
  type FrameMeta,
  type Disposer,
} from '../../src/captures/capture_console.js';
import { installDomMutationCapture } from '../../src/captures/capture_dom_mutation.js';
import {
  createCsDispatcher,
  type PageEventSwMessage,
} from '../../src/page_bridge/cs_dispatcher.js';
import {
  createEventSink,
  isPageEventSwMessage,
} from '../../src/sw_event_sink/sw_event_sink.js';
import {
  encodeEvent,
  type PageBridgeEventEnvelope,
} from '../../src/page_bridge/protocol.js';
import { attachFrameId } from '../../src/frame_meta/attach_frame_id.js';
import type { CapturedEvent } from '../../src/captures/types.js';

const COALESCE_MS = 4;
const WAIT_MS = COALESCE_MS + 8;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type FrameIdRef = { current: number | undefined };

const buildPipelineWithFrameId = (
  initialFrameId: number | undefined,
): {
  emit: (event: CapturedEvent) => void;
  sink: ReturnType<typeof createEventSink>;
  frameIdRef: FrameIdRef;
} => {
  const sink = createEventSink();
  const frameIdRef: FrameIdRef = { current: initialFrameId };
  const dispatcher = createCsDispatcher({
    forwardEventToSw: (msg: PageEventSwMessage) => {
      if (isPageEventSwMessage(msg)) {
        sink.handle(
          attachFrameId(msg.event as CapturedEvent, frameIdRef.current),
        );
      }
    },
  });
  const emit = (event: CapturedEvent): void => {
    const envelope: PageBridgeEventEnvelope<CapturedEvent> =
      encodeEvent<CapturedEvent>(event);
    dispatcher.handlePageMessage(
      new MessageEvent('message', {
        data: envelope,
        source: window as MessageEventSource,
      }),
    );
  };
  return { emit, sink, frameIdRef };
};

const TOP_FRAME: FrameMeta = {
  frameUrl: 'https://example.com/top',
  frameKey: 'top',
};

const NESTED_FRAME_KEY = 'top/0';
const CROSS_ORIGIN_FRAME_KEY = 'cross_origin/abc-123';

const synthConsoleEvent = (
  frameKey: string,
  frameUrl: string,
  marker: string,
): CapturedEvent =>
  ({
    kind: 'console',
    ts: 1,
    frameUrl,
    frameKey,
    level: 'log',
    args: [marker],
  }) as unknown as CapturedEvent;

const asRecord = (e: CapturedEvent): Record<string, unknown> =>
  e as unknown as Record<string, unknown>;

describe('captures integration: multi-frame frameKey + frameId end-to-end', () => {
  let disposers: Disposer[] = [];

  afterEach(() => {
    for (const d of disposers) d();
    disposers = [];
    document.body.innerHTML = '';
  });

  it('top-frame real producers tag every event with frameKey="top" and frameId=0', async () => {
    const { emit, sink, frameIdRef } = buildPipelineWithFrameId(0);
    expect(frameIdRef.current).toBe(0);

    disposers = [
      installConsoleCapture(emit, TOP_FRAME, { now: () => 1 }),
      installDomMutationCapture(emit, TOP_FRAME, {
        coalesceWindowMs: COALESCE_MS,
      }),
    ];

    console.log('top-marker');
    document.body.appendChild(document.createElement('div'));
    await wait(WAIT_MS);

    const recent = sink.getRecent({ kinds: ['console', 'dom_mutation'] });
    expect(recent.events.length).toBeGreaterThanOrEqual(2);
    for (const e of recent.events) {
      const r = asRecord(e);
      expect(r['frameKey']).toBe('top');
      expect(r['frameId']).toBe(0);
      expect(r['frameUrl']).toBe('https://example.com/top');
    }
  });

  it('synthesized same-origin-iframe event preserves frameKey="top/0" and tags frameId=4', () => {
    const { emit, sink, frameIdRef } = buildPipelineWithFrameId(4);
    emit(
      synthConsoleEvent(
        NESTED_FRAME_KEY,
        'https://example.com/iframe',
        'nested-marker',
      ),
    );
    expect(frameIdRef.current).toBe(4);

    const recent = sink.getRecent({ kinds: ['console'] });
    expect(recent.events).toHaveLength(1);
    const r = asRecord(recent.events[0]!);
    expect(r['frameKey']).toBe(NESTED_FRAME_KEY);
    expect(r['frameId']).toBe(4);
    expect(r['frameUrl']).toBe('https://example.com/iframe');
    expect(r['args']).toEqual(['nested-marker']);
  });

  it('synthesized cross-origin event preserves frameKey="cross_origin/..." and tags frameId=7', () => {
    const { emit, sink } = buildPipelineWithFrameId(7);
    emit(
      synthConsoleEvent(
        CROSS_ORIGIN_FRAME_KEY,
        'https://other.example/frame',
        'cross-marker',
      ),
    );

    const recent = sink.getRecent({ kinds: ['console'] });
    expect(recent.events).toHaveLength(1);
    const r = asRecord(recent.events[0]!);
    expect(r['frameKey']).toBe(CROSS_ORIGIN_FRAME_KEY);
    expect(r['frameId']).toBe(7);
    expect(r['frameUrl']).toBe('https://other.example/frame');
  });

  it('mixed-frame run disambiguates events by (frameKey, frameId) tuple', async () => {
    const { emit, sink, frameIdRef } = buildPipelineWithFrameId(0);

    disposers = [installConsoleCapture(emit, TOP_FRAME, { now: () => 1 })];
    console.log('top-mixed');

    frameIdRef.current = 4;
    emit(
      synthConsoleEvent(
        NESTED_FRAME_KEY,
        'https://example.com/iframe',
        'nested-mixed',
      ),
    );

    frameIdRef.current = 7;
    emit(
      synthConsoleEvent(
        CROSS_ORIGIN_FRAME_KEY,
        'https://other.example/frame',
        'cross-mixed',
      ),
    );

    await wait(WAIT_MS);

    const recent = sink.getRecent({ kinds: ['console'] });
    const tuples = recent.events.map((e) => {
      const r = asRecord(e);
      return [r['frameKey'], r['frameId']] as [unknown, unknown];
    });
    expect(tuples).toContainEqual(['top', 0]);
    expect(tuples).toContainEqual([NESTED_FRAME_KEY, 4]);
    expect(tuples).toContainEqual([CROSS_ORIGIN_FRAME_KEY, 7]);

    // Each tuple appears exactly once for the three markers.
    const markerByTuple = new Map<string, string>();
    for (const e of recent.events) {
      const r = asRecord(e);
      const key = `${String(r['frameKey'])}|${String(r['frameId'])}`;
      const args = r['args'] as readonly unknown[];
      markerByTuple.set(key, String(args[0]));
    }
    expect(markerByTuple.get('top|0')).toBe('top-mixed');
    expect(markerByTuple.get(`${NESTED_FRAME_KEY}|4`)).toBe('nested-mixed');
    expect(markerByTuple.get(`${CROSS_ORIGIN_FRAME_KEY}|7`)).toBe('cross-mixed');
  });

  it('shadow DOM mutation in top frame carries frameKey="top" and frameId=0 end-to-end', async () => {
    const { emit, sink } = buildPipelineWithFrameId(0);

    disposers = [
      installDomMutationCapture(emit, TOP_FRAME, {
        coalesceWindowMs: COALESCE_MS,
      }),
    ];

    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    await wait(WAIT_MS);

    shadow.appendChild(document.createElement('span'));
    await wait(WAIT_MS);

    const recent = sink.getRecent({ kinds: ['dom_mutation'] });
    expect(recent.events.length).toBeGreaterThanOrEqual(1);
    const sawShadowSpan = recent.events.some((e) => {
      const evt = e as {
        patches: ReadonlyArray<{
          kind: string;
          added?: ReadonlyArray<{ tagName: string }>;
        }>;
      };
      return evt.patches.some(
        (p) =>
          p.kind === 'childList' &&
          (p.added ?? []).some((a) => a.tagName === 'SPAN'),
      );
    });
    expect(sawShadowSpan).toBe(true);

    for (const e of recent.events) {
      const r = asRecord(e);
      expect(r['frameKey']).toBe('top');
      expect(r['frameId']).toBe(0);
    }
  });
});
