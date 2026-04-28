import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type IpcEnvelope,
  type IpcRequestEnvelope,
} from '../../../src/mcp/ipc/envelope.js';
import {
  createIpcClient,
  type IpcClient,
} from '../../../src/mcp/ipc/ipc_client.js';
import {
  createIpcServer,
  type IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('mcp_ipc end-to-end (createIpcServer + createIpcClient)', () => {
  let tmp: string;
  let socketPath: string;
  let server: IpcServer | null = null;
  let client: IpcClient | null = null;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pwa-debug-ipc-e2e-'));
    socketPath = join(tmp, 'mcp.sock');
  });

  afterEach(async () => {
    if (client) {
      client.close();
      client = null;
    }
    if (server) {
      await server.close();
      server = null;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('routes a request → response round-trip when the client replies via send()', async () => {
    server = await createIpcServer({ socketPath });
    client = await createIpcClient({
      socketPath,
      extensionId: 'ext-a',
      onEnvelope: (env) => {
        if (env.type === 'request') {
          client!.send({
            type: 'response',
            requestId: env.requestId,
            payload: {
              echoedTool: env.tool,
              echoedRequestId: env.requestId,
            },
          });
        }
      },
    });
    await waitFor(() => server!.listConnections().length === 1);

    const response = await server.request('ext-a', {
      type: 'request',
      requestId: 'rt-1',
      tool: 'session_ping',
    });

    expect(response.type).toBe('response');
    expect(response.requestId).toBe('rt-1');
    expect(response.payload).toEqual({
      echoedTool: 'session_ping',
      echoedRequestId: 'rt-1',
    });
    expect(response.error).toBeUndefined();
  });

  it('correlates many concurrent requests over a single connection', async () => {
    server = await createIpcServer({ socketPath });
    client = await createIpcClient({
      socketPath,
      extensionId: 'ext-a',
      onEnvelope: (env) => {
        if (env.type === 'request') {
          // Stagger replies to verify correlation works regardless of order.
          const delay = env.requestId === 'r-2' ? 20 : 5;
          setTimeout(() => {
            client!.send({
              type: 'response',
              requestId: env.requestId,
              payload: { id: env.requestId },
            });
          }, delay);
        }
      },
    });
    await waitFor(() => server!.listConnections().length === 1);

    const reqs = ['r-1', 'r-2', 'r-3'].map((id) =>
      server!.request('ext-a', {
        type: 'request',
        requestId: id,
        tool: 'session_ping',
      } satisfies IpcRequestEnvelope),
    );
    const responses = await Promise.all(reqs);
    expect(responses.map((r) => r.requestId)).toEqual(['r-1', 'r-2', 'r-3']);
    expect(responses.map((r) => (r.payload as { id: string }).id)).toEqual([
      'r-1',
      'r-2',
      'r-3',
    ]);
  });

  it('forwards client-emitted events to onEvent on the server', async () => {
    const events: IpcEnvelope[] = [];
    server = await createIpcServer({
      socketPath,
      onEvent: (_id, env) => events.push(env),
    });
    client = await createIpcClient({
      socketPath,
      extensionId: 'ext-a',
      onEnvelope: () => {},
    });
    await waitFor(() => server!.listConnections().length === 1);

    client.send({ type: 'event', tool: 'sw_hello', payload: { v: '1.0.0' } });
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({
      type: 'event',
      tool: 'sw_hello',
      payload: { v: '1.0.0' },
    });
  });

  it('listConnections() reflects connect → disconnect lifecycle', async () => {
    const disconnected: string[] = [];
    server = await createIpcServer({
      socketPath,
      onDisconnect: (id) => disconnected.push(id),
    });
    expect(server.listConnections()).toEqual([]);

    client = await createIpcClient({
      socketPath,
      extensionId: 'ext-a',
      onEnvelope: () => {},
    });
    await waitFor(() => server!.listConnections().length === 1);
    expect(server.listConnections()[0]?.extensionId).toBe('ext-a');

    client.close();
    client = null;
    await waitFor(() => disconnected.length === 1);
    expect(disconnected).toEqual(['ext-a']);
    expect(server.listConnections()).toEqual([]);
  });

  it('client.onClose fires when the server closes, and subsequent send fails', async () => {
    server = await createIpcServer({ socketPath });
    let closeCount = 0;
    client = await createIpcClient({
      socketPath,
      extensionId: 'ext-a',
      onEnvelope: () => {},
      onClose: () => {
        closeCount += 1;
      },
    });
    await waitFor(() => server!.listConnections().length === 1);

    await server.close();
    server = null;

    await waitFor(() => closeCount === 1);
    const sendResult = client.send({ type: 'event' });
    expect(sendResult.ok).toBe(false);
  });
});
