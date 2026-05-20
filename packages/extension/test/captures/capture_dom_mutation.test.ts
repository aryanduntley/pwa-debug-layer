import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDomMutationCapture } from '../../src/captures/capture_dom_mutation.js';
import type { FrameMeta } from '../../src/captures/capture_console.js';
import type {
  DomMutationCapturedEvent,
  DomMutationPatch,
} from '../../src/captures/types.js';

const FRAME: FrameMeta = {
  frameUrl: 'https://example.com/dom',
  frameKey: 'top',
};

const COALESCE_MS = 8;
// Generous margin over the coalesce timer — full-suite worker load can
// drift setTimeout by 10-20ms on slow CI / busy local runs, which raced
// the prior `COALESCE_MS + 8` budget into intermittent dom_mutation
// flakes. See M9 T1.
const WAIT_MS = 50;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const flushed = async (): Promise<void> => {
  await wait(WAIT_MS);
};

describe('installDomMutationCapture', () => {
  let received: DomMutationCapturedEvent[];
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    received = [];
    document.body.innerHTML = '';
    dispose = installDomMutationCapture(
      (e) => {
        received.push(e);
      },
      FRAME,
      { coalesceWindowMs: COALESCE_MS },
    );
  });

  afterEach(() => {
    if (dispose) dispose();
    document.body.innerHTML = '';
  });

  it('emits a childList patch when a node is appended', async () => {
    const div = document.createElement('div');
    div.id = 'added';
    document.body.appendChild(div);
    await flushed();

    expect(received).toHaveLength(1);
    const evt = received[0]!;
    expect(evt.kind).toBe('dom_mutation');
    expect(evt.frameUrl).toBe(FRAME.frameUrl);
    expect(evt.patches).toHaveLength(1);
    const patch = evt.patches[0] as Extract<
      DomMutationPatch,
      { kind: 'childList' }
    >;
    expect(patch.kind).toBe('childList');
    expect(patch.added).toHaveLength(1);
    expect(patch.added[0]!.tagName).toBe('DIV');
    expect(patch.added[0]!.attrs).toEqual({ id: 'added' });
    expect(patch.removed).toHaveLength(0);
  });

  it('emits a childList patch when a node is removed', async () => {
    const div = document.createElement('div');
    div.id = 'tmp';
    document.body.appendChild(div);
    await flushed();
    received.length = 0;

    document.body.removeChild(div);
    await flushed();

    expect(received).toHaveLength(1);
    const patch = received[0]!.patches[0] as Extract<
      DomMutationPatch,
      { kind: 'childList' }
    >;
    expect(patch.kind).toBe('childList');
    expect(patch.removed).toHaveLength(1);
    expect(patch.removed[0]!.tagName).toBe('DIV');
    expect(patch.added).toHaveLength(0);
  });

  it('emits an attributes patch with oldValue=null + newValue when setting a fresh attr', async () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    await flushed();
    received.length = 0;

    div.setAttribute('data-x', '1');
    await flushed();

    const patch = received[0]!.patches[0] as Extract<
      DomMutationPatch,
      { kind: 'attributes' }
    >;
    expect(patch.kind).toBe('attributes');
    expect(patch.name).toBe('data-x');
    expect(patch.oldValue).toBeNull();
    expect(patch.newValue).toBe('1');
  });

  it('emits an attributes patch with newValue=null when removing an attr', async () => {
    const div = document.createElement('div');
    div.setAttribute('data-x', '1');
    document.body.appendChild(div);
    await flushed();
    received.length = 0;

    div.removeAttribute('data-x');
    await flushed();

    const patch = received[0]!.patches[0] as Extract<
      DomMutationPatch,
      { kind: 'attributes' }
    >;
    expect(patch.kind).toBe('attributes');
    expect(patch.name).toBe('data-x');
    expect(patch.oldValue).toBe('1');
    expect(patch.newValue).toBeNull();
  });

  it('emits a characterData patch with oldValue + newValue', async () => {
    const text = document.createTextNode('before');
    document.body.appendChild(text);
    await flushed();
    received.length = 0;

    text.data = 'after';
    await flushed();

    const patch = received[0]!.patches[0] as Extract<
      DomMutationPatch,
      { kind: 'characterData' }
    >;
    expect(patch.kind).toBe('characterData');
    expect(patch.oldValue).toBe('before');
    expect(patch.newValue).toBe('after');
  });

  it('coalesces multiple mutations within the window into one event', async () => {
    for (let i = 0; i < 5; i += 1) {
      const div = document.createElement('div');
      div.id = `c${i}`;
      document.body.appendChild(div);
    }
    await flushed();

    expect(received).toHaveLength(1);
    const evt = received[0]!;
    expect(evt.patches.length).toBeGreaterThanOrEqual(5);
    const childListPatches = evt.patches.filter((p) => p.kind === 'childList');
    expect(childListPatches.length).toBeGreaterThanOrEqual(5);
  });

  it('respects depth cap: depthCap=0 marks the target summary truncated', async () => {
    if (dispose) dispose();
    received = [];
    dispose = installDomMutationCapture(
      (e) => {
        received.push(e);
      },
      FRAME,
      { coalesceWindowMs: COALESCE_MS, depthCap: 0 },
    );

    const div = document.createElement('div');
    document.body.appendChild(div);
    await flushed();

    const patch = received[0]!.patches[0] as Extract<
      DomMutationPatch,
      { kind: 'childList' }
    >;
    expect(patch.target.truncated).toBe(true);
    expect(patch.added[0]!.truncated).toBe(true);
  });

  it('truncates summaries when childCount exceeds the per-node max', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    await flushed();
    received.length = 0;

    for (let i = 0; i < 50; i += 1) {
      parent.appendChild(document.createElement('span'));
    }
    await flushed();

    const merged = received.flatMap((e) => e.patches);
    const targetSummary = merged
      .filter((p): p is Extract<DomMutationPatch, { kind: 'childList' }> =>
        p.kind === 'childList',
      )
      .map((p) => p.target)
      .find((s) => s.tagName === 'DIV' && (s.childCount ?? 0) > 32);
    expect(targetSummary).toBeDefined();
    expect(targetSummary!.truncated).toBe(true);
    expect(targetSummary!.childCount).toBeGreaterThan(32);
  });

  it('disposer drops pending patches + disconnects the observer', async () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    // Dispose BEFORE the coalesce timer fires.
    dispose!();
    dispose = undefined;
    await flushed();

    expect(received).toHaveLength(0);

    // After dispose, further mutations must not produce events.
    document.body.appendChild(document.createElement('span'));
    await flushed();
    expect(received).toHaveLength(0);
  });

  it('emits a dom_mutation event for content added inside an open shadow root', async () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    await flushed();
    received.length = 0;

    const span = document.createElement('span');
    shadow.appendChild(span);
    await flushed();

    expect(received.length).toBeGreaterThanOrEqual(1);
    const event = received[0]!;
    expect(event.kind).toBe('dom_mutation');
    const sawSpan = event.patches
      .filter((p): p is Extract<DomMutationPatch, { kind: 'childList' }> =>
        p.kind === 'childList',
      )
      .some((p) => p.added.some((a) => a.tagName === 'SPAN'));
    expect(sawSpan).toBe(true);
  });

  it('emits a dom_mutation event for content added inside a nested shadow root', async () => {
    const outer = document.createElement('div');
    const outerShadow = outer.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    const innerShadow = inner.attachShadow({ mode: 'open' });
    outerShadow.appendChild(inner);
    document.body.appendChild(outer);
    await flushed();
    received.length = 0;

    const p = document.createElement('p');
    innerShadow.appendChild(p);
    await flushed();

    const sawP = received
      .flatMap((e) => e.patches)
      .filter((pa): pa is Extract<DomMutationPatch, { kind: 'childList' }> =>
        pa.kind === 'childList',
      )
      .some((pa) => pa.added.some((a) => a.tagName === 'P'));
    expect(sawP).toBe(true);
  });

  it('picks up shadows attached after install and captures their content mutations', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await flushed();
    received.length = 0;

    const shadow = host.attachShadow({ mode: 'open' });
    // Trigger a host mutation so attachShadowObserver's host observer rescans.
    host.appendChild(document.createElement('em'));
    await flushed();
    received.length = 0;

    const span = document.createElement('span');
    shadow.appendChild(span);
    await flushed();

    const sawSpan = received
      .flatMap((e) => e.patches)
      .filter((p): p is Extract<DomMutationPatch, { kind: 'childList' }> =>
        p.kind === 'childList',
      )
      .some((p) => p.added.some((a) => a.tagName === 'SPAN'));
    expect(sawSpan).toBe(true);
  });

  it('disposer disconnects shadow observers — post-dispose shadow mutations do not emit', async () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    await flushed();
    shadow.appendChild(document.createElement('span'));
    await flushed();
    expect(received.length).toBeGreaterThan(0);

    dispose!();
    dispose = undefined;
    received.length = 0;

    shadow.appendChild(document.createElement('em'));
    await flushed();
    expect(received).toHaveLength(0);
  });
});
