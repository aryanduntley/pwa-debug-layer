import { describe, it, expect, vi } from 'vitest';
import {
  CDP_BRIDGE_VERSION,
  CDP_EMIT_BINDING,
  CDP_GLOBAL,
  createBindingEmitter,
  createCdpDispatch,
  installCdpBridge,
  type CdpBridgeDeps,
} from '../../src/page_world_cdp/cdp_bridge.js';
import { dispatchPageRequest } from '../../src/page_bridge/page_dispatch.js';
import {
  EXTENSION_PAGE_WORLD_GUARD,
  type PageWorldBootOptions,
} from '../../src/page_world_boot/boot.js';
import type { CapturedEvent } from '../../src/captures/types.js';

const event = { kind: 'console', ts: 1, level: 'log', args: ['hi'] } as unknown as CapturedEvent;

const KINDS = {
  console: true, fetch: true, xhr: true, websocket: true, dom_mutation: true,
  lifecycle: true, library_popup: true, page_error: true, sw_state: false,
};

const fakeDeps = (): CdpBridgeDeps & { readonly bootCalls: PageWorldBootOptions[] } => {
  const bootCalls: PageWorldBootOptions[] = [];
  return {
    bootCalls,
    dispatch: async (req) => ({ ns: 'pwa-debug', dir: 'page->cs', requestId: req.requestId, payload: { tool: req.tool, echo: req.payload } }),
    boot: (opts) => {
      bootCalls.push(opts);
      opts.installRequestChannel();
      return { kinds: opts.captures === false ? null : KINDS, dispose: () => undefined };
    },
  };
};

type Api = { dispatch: (j: string) => Promise<string>; status: () => unknown; version: number };

describe('createBindingEmitter', () => {
  it('sends {v, event} JSON through the binding', () => {
    const binding = vi.fn();
    const e = createBindingEmitter({ [CDP_EMIT_BINDING]: binding }, CDP_EMIT_BINDING);
    e.emit(event);
    expect(JSON.parse(binding.mock.calls[0]![0] as string)).toEqual({ v: CDP_BRIDGE_VERSION, event });
    expect(e.dropped()).toBe(0);
  });

  it('counts and drops when the binding is missing', () => {
    const e = createBindingEmitter({}, CDP_EMIT_BINDING);
    e.emit(event);
    e.emit(event);
    expect(e.dropped()).toBe(2);
  });

  it('picks up a binding added after the emitter was created', () => {
    const win: Record<string, unknown> = {};
    const e = createBindingEmitter(win, CDP_EMIT_BINDING);
    e.emit(event);
    const binding = vi.fn();
    win[CDP_EMIT_BINDING] = binding;
    e.emit(event);
    expect(binding).toHaveBeenCalledOnce();
    expect(e.dropped()).toBe(1);
  });

  it('drops unserialisable events instead of throwing into the page', () => {
    const binding = vi.fn();
    const e = createBindingEmitter({ [CDP_EMIT_BINDING]: binding }, CDP_EMIT_BINDING);
    expect(() => e.emit({ kind: 'console', big: 1n } as unknown as CapturedEvent)).not.toThrow();
    expect(binding).not.toHaveBeenCalled();
    expect(e.dropped()).toBe(1);
  });
});

describe('createCdpDispatch', () => {
  const dispatch = createCdpDispatch(fakeDeps().dispatch);

  it('round-trips a request as JSON', async () => {
    const out = JSON.parse(await dispatch(JSON.stringify({ requestId: 'r1', tool: 'session_ping', payload: { a: 1 } })));
    expect(out).toEqual({ ns: 'pwa-debug', dir: 'page->cs', requestId: 'r1', payload: { tool: 'session_ping', echo: { a: 1 } } });
  });

  it('turns invalid JSON into an error envelope', async () => {
    const out = JSON.parse(await dispatch('{nope'));
    expect(out.error.message).toMatch(/not valid JSON/);
  });

  it('requires requestId and tool', async () => {
    const out = JSON.parse(await dispatch(JSON.stringify({ requestId: 'r2' })));
    expect(out).toMatchObject({ requestId: 'r2', error: { message: expect.stringMatching(/required/) } });
  });

  it('turns a dispatcher rejection into an error envelope', async () => {
    const failing = createCdpDispatch(async () => {
      throw new Error('boom');
    });
    const out = JSON.parse(await failing(JSON.stringify({ requestId: 'r3', tool: 't' })));
    expect(out).toMatchObject({ requestId: 'r3', error: { message: 'boom' } });
  });

  it('works with the real page dispatcher (session_ping, unknown tool)', async () => {
    const real = createCdpDispatch(dispatchPageRequest);
    const ping = JSON.parse(await real(JSON.stringify({ requestId: 'p', tool: 'session_ping' })));
    expect(ping.payload).toMatchObject({ readyState: expect.any(String), url: expect.any(String) });
    const unknown = JSON.parse(await real(JSON.stringify({ requestId: 'u', tool: 'no_such_tool' })));
    expect(unknown.error.message).toBe('unknown tool: no_such_tool');
  });
});

describe('installCdpBridge', () => {
  it('defines a frozen, non-enumerable global with version, dispatch and status', async () => {
    const win: Record<string, unknown> = {};
    const status = installCdpBridge(win, fakeDeps());
    expect(status).toMatchObject({ version: CDP_BRIDGE_VERSION, captures: 'installed', kinds: KINDS, alreadyInstalled: false });
    expect(Object.keys(win)).not.toContain(CDP_GLOBAL);
    const api = win[CDP_GLOBAL] as Api;
    expect(Object.isFrozen(api)).toBe(true);
    expect(api.version).toBe(CDP_BRIDGE_VERSION);
    const out = JSON.parse(await api.dispatch(JSON.stringify({ requestId: 'x', tool: 'evaluate' })));
    expect(out.payload.tool).toBe('evaluate');
    expect(() => {
      (win as Record<string, unknown>)[CDP_GLOBAL] = 'clobbered';
    }).toThrow();
  });

  it('wires captures to the binding emitter', () => {
    const binding = vi.fn();
    const win: Record<string, unknown> = { [CDP_EMIT_BINDING]: binding };
    const deps = fakeDeps();
    installCdpBridge(win, deps);
    deps.bootCalls[0]!.emit(event);
    expect(binding).toHaveBeenCalledOnce();
  });

  it('is idempotent: a second injection does not boot again', () => {
    const win: Record<string, unknown> = {};
    const deps = fakeDeps();
    installCdpBridge(win, deps);
    const again = installCdpBridge(win, deps);
    expect(deps.bootCalls).toHaveLength(1);
    expect(again.alreadyInstalled).toBe(true);
  });

  it('skips captures when the extension page-world owns the page', () => {
    const win: Record<string, unknown> = { [EXTENSION_PAGE_WORLD_GUARD]: true };
    const deps = fakeDeps();
    const status = installCdpBridge(win, deps);
    expect(deps.bootCalls[0]!.captures).toBe(false);
    expect(status).toMatchObject({ captures: 'skipped_extension_present', kinds: null });
    expect(win[CDP_GLOBAL]).toBeDefined();
  });

  it('reports dropped events in status', () => {
    const win: Record<string, unknown> = {};
    const deps = fakeDeps();
    installCdpBridge(win, deps);
    deps.bootCalls[0]!.emit(event);
    expect(((win[CDP_GLOBAL] as Api).status() as { dropped: number }).dropped).toBe(1);
  });
});

describe('page-world-cdp entry', () => {
  it('imports, exports bootstrap and installs into the test window', async () => {
    const m = await import('../../src/page-world-cdp.js');
    expect(typeof m.bootstrap).toBe('function');
    const api = (window as unknown as Record<string, unknown>)[CDP_GLOBAL] as Api;
    const ping = JSON.parse(await api.dispatch(JSON.stringify({ requestId: 'e', tool: 'session_ping' })));
    expect(ping.payload.readyState).toBeDefined();
  });
});
