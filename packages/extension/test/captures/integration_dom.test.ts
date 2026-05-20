import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  installConsoleCapture,
  type FrameMeta,
  type Disposer,
} from '../../src/captures/capture_console.js';
import { installFetchCapture } from '../../src/captures/capture_fetch.js';
import { installDomMutationCapture } from '../../src/captures/capture_dom_mutation.js';
import { installLifecycleCapture } from '../../src/captures/capture_lifecycle.js';
import {
  PAGE_EVENT_SW_TAG,
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
import type { CapturedEvent } from '../../src/captures/types.js';

const FRAME: FrameMeta = {
  frameUrl: 'https://example.com/dom',
  frameKey: 'top',
};

const COALESCE_MS = 4;
// Generous margin: full-suite worker load drifts setTimeout enough to
// race the prior `COALESCE_MS + 8` budget on dom_mutation deliveries.
// See M9 T1.
const WAIT_MS = 50;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const buildPipeline = (): {
  emit: (event: CapturedEvent) => void;
  sink: ReturnType<typeof createEventSink>;
  tags: string[];
} => {
  const sink = createEventSink();
  const tags: string[] = [];
  const dispatcher = createCsDispatcher({
    forwardEventToSw: (msg: PageEventSwMessage) => {
      tags.push(msg.tag);
      if (isPageEventSwMessage(msg)) {
        sink.handle(msg.event as CapturedEvent);
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
  return { emit, sink, tags };
};

describe('captures integration: dom_mutation + console + fetch on shared emit', () => {
  let disposers: Disposer[] = [];
  const realFetch = globalThis.fetch;

  afterEach(() => {
    for (const d of disposers) d();
    disposers = [];
    globalThis.fetch = realFetch;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('emits one event per kind with correct tags and no cross-talk', async () => {
    const { emit, sink } = buildPipeline();
    globalThis.fetch = vi.fn(async () =>
      new Response('ok', { status: 200 }),
    ) as typeof globalThis.fetch;

    disposers = [
      installConsoleCapture(emit, FRAME, { now: () => 1 }),
      installFetchCapture(emit, FRAME, { now: () => 1 }),
      installDomMutationCapture(emit, FRAME, { coalesceWindowMs: COALESCE_MS }),
    ];

    console.log('hello');
    await fetch('https://api.example.com/x');
    const div = document.createElement('div');
    div.id = 'integration-dom';
    document.body.appendChild(div);

    await wait(WAIT_MS);

    const stats = sink.getStats();
    expect(stats.perKind['console']).toBe(1);
    expect(stats.perKind['fetch']).toBe(2);
    expect((stats.perKind['dom_mutation'] ?? 0)).toBeGreaterThanOrEqual(1);

    const recent = sink.getRecent({
      kinds: ['console', 'fetch', 'dom_mutation'],
    });
    const consoleEvts = recent.events.filter((e) => e.kind === 'console');
    const fetchEvts = recent.events.filter((e) => e.kind === 'fetch');
    const domEvts = recent.events.filter((e) => e.kind === 'dom_mutation');
    expect(consoleEvts).toHaveLength(1);
    expect(fetchEvts.length).toBeGreaterThanOrEqual(2);
    expect(domEvts.length).toBeGreaterThanOrEqual(1);
    // No cross-tagging
    for (const e of consoleEvts) expect(e.kind).toBe('console');
    for (const e of fetchEvts) expect(e.kind).toBe('fetch');
    for (const e of domEvts) expect(e.kind).toBe('dom_mutation');
  });

  it('id namespaces do not collide: nodeId vs captureId', async () => {
    const { emit, sink } = buildPipeline();
    globalThis.fetch = vi.fn(async () =>
      new Response('a'),
    ) as typeof globalThis.fetch;

    disposers = [
      installFetchCapture(emit, FRAME),
      installDomMutationCapture(emit, FRAME, { coalesceWindowMs: COALESCE_MS }),
    ];

    await fetch('https://api.example.com/a');
    document.body.appendChild(document.createElement('span'));
    document.body.appendChild(document.createElement('span'));
    await wait(WAIT_MS);

    const recent = sink.getRecent({ kinds: ['fetch', 'dom_mutation'] });
    const captureIds = recent.events
      .filter((e) => e.kind === 'fetch')
      .map((e) => (e as { captureId: string }).captureId);
    const nodeIds = recent.events
      .filter((e) => e.kind === 'dom_mutation')
      .flatMap((e) => {
        const evt = e as {
          patches: ReadonlyArray<{
            target: { nodeId: string };
            added?: ReadonlyArray<{ nodeId: string }>;
          }>;
        };
        return evt.patches.flatMap((p) => [
          p.target.nodeId,
          ...(p.added ?? []).map((a) => a.nodeId),
        ]);
      });

    // captureIds look like UUIDs / longer strings; nodeIds look like 'n1','n2',...
    expect(captureIds.every((id) => id.length > 4)).toBe(true);
    expect(nodeIds.every((id) => /^n\d+$/.test(id))).toBe(true);
    // No literal collision
    const captureSet = new Set(captureIds);
    expect(nodeIds.some((id) => captureSet.has(id))).toBe(false);
  });

  it('all events flow through the same emit closure (canonical SW tag)', async () => {
    const { emit, tags } = buildPipeline();
    globalThis.fetch = vi.fn(async () =>
      new Response('ok'),
    ) as typeof globalThis.fetch;

    disposers = [
      installConsoleCapture(emit, FRAME),
      installFetchCapture(emit, FRAME),
      installDomMutationCapture(emit, FRAME, { coalesceWindowMs: COALESCE_MS }),
    ];

    console.log('a');
    await fetch('https://api.example.com/x');
    document.body.appendChild(document.createElement('div'));
    await wait(WAIT_MS);

    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((t) => t === PAGE_EVENT_SW_TAG)).toBe(true);
  });

  it('disposer order restores fetch + console + disconnects MutationObserver', async () => {
    const { emit, sink } = buildPipeline();
    globalThis.fetch = vi.fn(async () =>
      new Response('ok'),
    ) as typeof globalThis.fetch;
    const baselineFetch = globalThis.fetch;
    const baselineLog = console.log;

    disposers = [
      installConsoleCapture(emit, FRAME),
      installFetchCapture(emit, FRAME),
      installDomMutationCapture(emit, FRAME, { coalesceWindowMs: COALESCE_MS }),
    ];

    expect(globalThis.fetch).not.toBe(baselineFetch);
    expect(console.log).not.toBe(baselineLog);

    for (const d of disposers) d();
    disposers = [];

    expect(globalThis.fetch).toBe(baselineFetch);
    expect(console.log).toBe(baselineLog);

    // Post-dispose mutations must NOT reach the sink.
    const beforeStats = sink.getStats();
    document.body.appendChild(document.createElement('section'));
    await wait(WAIT_MS);
    const afterStats = sink.getStats();
    expect(afterStats.perKind['dom_mutation'] ?? 0).toBe(
      beforeStats.perKind['dom_mutation'] ?? 0,
    );
  });
});

describe('captures integration: lifecycle + console + dom_mutation on shared emit', () => {
  let disposers: Disposer[] = [];

  afterEach(() => {
    for (const d of disposers) d();
    disposers = [];
    document.body.innerHTML = '';
    history.replaceState(null, '', '/');
    vi.restoreAllMocks();
  });

  it('emits one event per kind: console + dom_mutation + lifecycle, no cross-tagging', async () => {
    const { emit, sink } = buildPipeline();

    disposers = [
      installConsoleCapture(emit, FRAME, { now: () => 1 }),
      installDomMutationCapture(emit, FRAME, { coalesceWindowMs: COALESCE_MS }),
      installLifecycleCapture(emit, FRAME),
    ];

    console.log('integration-lifecycle');
    document.body.appendChild(document.createElement('div'));
    history.pushState({ a: 1 }, '', '/integration-lifecycle');

    await wait(WAIT_MS);

    const recent = sink.getRecent({
      kinds: ['console', 'dom_mutation', 'lifecycle'],
    });
    const consoleEvts = recent.events.filter((e) => e.kind === 'console');
    const domEvts = recent.events.filter((e) => e.kind === 'dom_mutation');
    const lifecycleEvts = recent.events.filter((e) => e.kind === 'lifecycle');

    expect(consoleEvts).toHaveLength(1);
    expect(domEvts.length).toBeGreaterThanOrEqual(1);
    expect(lifecycleEvts).toHaveLength(1);

    // No cross-tagging.
    for (const e of consoleEvts) expect(e.kind).toBe('console');
    for (const e of domEvts) expect(e.kind).toBe('dom_mutation');
    for (const e of lifecycleEvts) expect(e.kind).toBe('lifecycle');

    // source:'page' present on lifecycle, absent on the other two.
    expect((lifecycleEvts[0] as { source: string }).source).toBe('page');
    expect((consoleEvts[0] as Record<string, unknown>).source).toBeUndefined();
    expect((domEvts[0] as Record<string, unknown>).source).toBeUndefined();
  });

  it('id namespaces do not collide: lifecycle has no captureId/nodeId; subkind discriminates', async () => {
    const { emit, sink } = buildPipeline();

    disposers = [
      installDomMutationCapture(emit, FRAME, { coalesceWindowMs: COALESCE_MS }),
      installLifecycleCapture(emit, FRAME),
    ];

    document.body.appendChild(document.createElement('span'));
    history.pushState({ a: 1 }, '', '/ns-collide');
    await wait(WAIT_MS);

    const recent = sink.getRecent({ kinds: ['dom_mutation', 'lifecycle'] });
    const lifecycleEvts = recent.events.filter((e) => e.kind === 'lifecycle');
    const domEvts = recent.events.filter((e) => e.kind === 'dom_mutation');

    // Lifecycle events carry subkind (discriminator) but not captureId/nodeId.
    for (const e of lifecycleEvts) {
      expect((e as Record<string, unknown>).captureId).toBeUndefined();
      expect((e as Record<string, unknown>).nodeId).toBeUndefined();
      expect(typeof (e as { subkind: string }).subkind).toBe('string');
    }
    // dom_mutation patches carry nodeIds in 'n\d+' shape.
    const nodeIds = domEvts.flatMap((e) => {
      const evt = e as {
        patches: ReadonlyArray<{
          target: { nodeId: string };
          added?: ReadonlyArray<{ nodeId: string }>;
        }>;
      };
      return evt.patches.flatMap((p) => [
        p.target.nodeId,
        ...(p.added ?? []).map((a) => a.nodeId),
      ]);
    });
    expect(nodeIds.every((id) => /^n\d+$/.test(id))).toBe(true);
  });

  it('all events flow through the same emit closure (canonical SW tag)', async () => {
    const { emit, tags } = buildPipeline();

    disposers = [
      installConsoleCapture(emit, FRAME),
      installDomMutationCapture(emit, FRAME, { coalesceWindowMs: COALESCE_MS }),
      installLifecycleCapture(emit, FRAME),
    ];

    console.log('a');
    document.body.appendChild(document.createElement('div'));
    history.pushState({ a: 1 }, '', '/canonical-tag');
    await wait(WAIT_MS);

    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((t) => t === PAGE_EVENT_SW_TAG)).toBe(true);
  });

  it('disposer order restores console.* + disconnects MutationObserver + restores history.pushState/replaceState', async () => {
    const { emit, sink } = buildPipeline();
    const baselineLog = console.log;
    const baselinePush = history.pushState;
    const baselineReplace = history.replaceState;

    disposers = [
      installConsoleCapture(emit, FRAME),
      installDomMutationCapture(emit, FRAME, { coalesceWindowMs: COALESCE_MS }),
      installLifecycleCapture(emit, FRAME),
    ];

    expect(console.log).not.toBe(baselineLog);
    expect(history.pushState).not.toBe(baselinePush);
    expect(history.replaceState).not.toBe(baselineReplace);

    for (const d of disposers) d();
    disposers = [];

    expect(console.log).toBe(baselineLog);
    expect(history.pushState).toBe(baselinePush);
    expect(history.replaceState).toBe(baselineReplace);

    // Post-dispose: nothing reaches the sink for any of the three kinds.
    const beforeStats = sink.getStats();
    console.log('post-dispose');
    document.body.appendChild(document.createElement('section'));
    history.pushState({ z: 9 }, '', '/post-dispose');
    await wait(WAIT_MS);
    const afterStats = sink.getStats();
    expect(afterStats.perKind['console'] ?? 0).toBe(
      beforeStats.perKind['console'] ?? 0,
    );
    expect(afterStats.perKind['dom_mutation'] ?? 0).toBe(
      beforeStats.perKind['dom_mutation'] ?? 0,
    );
    expect(afterStats.perKind['lifecycle'] ?? 0).toBe(
      beforeStats.perKind['lifecycle'] ?? 0,
    );
  });

  it('shadow content mutation produces dom_mutation only — no cross-tag with console / lifecycle', async () => {
    const { emit, sink } = buildPipeline();

    disposers = [
      installConsoleCapture(emit, FRAME, { now: () => 1 }),
      installDomMutationCapture(emit, FRAME, { coalesceWindowMs: COALESCE_MS }),
      installLifecycleCapture(emit, FRAME),
    ];

    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    await wait(WAIT_MS);

    console.log('shadow-integration');
    shadow.appendChild(document.createElement('span'));
    history.pushState({ s: 1 }, '', '/shadow-integration');
    await wait(WAIT_MS);

    const recent = sink.getRecent({
      kinds: ['console', 'dom_mutation', 'lifecycle'],
    });
    const consoleEvts = recent.events.filter((e) => e.kind === 'console');
    const domEvts = recent.events.filter((e) => e.kind === 'dom_mutation');
    const lifecycleEvts = recent.events.filter((e) => e.kind === 'lifecycle');

    expect(consoleEvts.length).toBeGreaterThanOrEqual(1);
    expect(domEvts.length).toBeGreaterThanOrEqual(1);
    expect(lifecycleEvts.length).toBeGreaterThanOrEqual(1);

    const sawShadowSpan = domEvts
      .flatMap(
        (e) =>
          (
            e as {
              patches: ReadonlyArray<{
                kind: string;
                added?: ReadonlyArray<{ tagName: string }>;
              }>;
            }
          ).patches,
      )
      .filter((p) => p.kind === 'childList')
      .some((p) => (p.added ?? []).some((a) => a.tagName === 'SPAN'));
    expect(sawShadowSpan).toBe(true);

    for (const e of consoleEvts) expect(e.kind).toBe('console');
    for (const e of domEvts) expect(e.kind).toBe('dom_mutation');
    for (const e of lifecycleEvts) expect(e.kind).toBe('lifecycle');
  });
});
