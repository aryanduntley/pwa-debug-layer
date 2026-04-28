import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type IpcEnvelope,
} from '../../../src/mcp/ipc/envelope.js';
import { createIpcClient } from '../../../src/mcp/ipc/ipc_client.js';
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

describe('createIpcClient', () => {
  let tmp: string;
  let socketPath: string;
  let server: IpcServer | null = null;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pwa-debug-ipc-client-'));
    socketPath = join(tmp, 'mcp.sock');
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('connects and registers automatically', async () => {
    const registered: string[] = [];
    server = await createIpcServer({
      socketPath,
      onRegister: (info) => registered.push(info.extensionId),
    });
    const client = await createIpcClient({
      socketPath,
      extensionId: 'ext-a',
      onEnvelope: () => {},
    });
    await waitFor(() => registered.length === 1);
    expect(registered).toEqual(['ext-a']);
    expect(server.listConnections().map((c) => c.extensionId)).toEqual([
      'ext-a',
    ]);
    client.close();
  });

  it('dispatches inbound envelopes to onEnvelope', async () => {
    server = await createIpcServer({ socketPath });
    const inbox: IpcEnvelope[] = [];
    const client = await createIpcClient({
      socketPath,
      extensionId: 'ext-a',
      onEnvelope: (env) => inbox.push(env),
    });
    await waitFor(() => server!.listConnections().length === 1);
    server.sendTo('ext-a', {
      type: 'request',
      requestId: 'r1',
      tool: 'session_ping',
    });
    await waitFor(() => inbox.length === 1);
    expect(inbox[0]).toEqual({
      type: 'request',
      requestId: 'r1',
      tool: 'session_ping',
    });
    client.close();
  });

  it('send writes a framed envelope to the server', async () => {
    const events: { id: string; env: IpcEnvelope }[] = [];
    server = await createIpcServer({
      socketPath,
      onEvent: (id, env) => events.push({ id, env }),
    });
    const client = await createIpcClient({
      socketPath,
      extensionId: 'ext-a',
      onEnvelope: () => {},
    });
    await waitFor(() => server!.listConnections().length === 1);
    const result = client.send({
      type: 'event',
      tool: 'sw_hello',
      payload: { v: '1.0.0' },
    });
    expect(result.ok).toBe(true);
    await waitFor(() => events.length === 1);
    expect(events[0]?.env).toEqual({
      type: 'event',
      tool: 'sw_hello',
      payload: { v: '1.0.0' },
    });
    client.close();
  });

  it('send returns ok:false after close', async () => {
    server = await createIpcServer({ socketPath });
    const client = await createIpcClient({
      socketPath,
      extensionId: 'ext-a',
      onEnvelope: () => {},
    });
    await waitFor(() => server!.listConnections().length === 1);
    client.close();
    await new Promise((r) => setTimeout(r, 10));
    const result = client.send({ type: 'event' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/socket destroyed/);
  });

  it('fires onClose with hadError=false on graceful close', async () => {
    server = await createIpcServer({ socketPath });
    let closedWith: boolean | null = null;
    const client = await createIpcClient({
      socketPath,
      extensionId: 'ext-a',
      onEnvelope: () => {},
      onClose: (hadError) => {
        closedWith = hadError;
      },
    });
    await waitFor(() => server!.listConnections().length === 1);
    client.close();
    await waitFor(() => closedWith !== null);
    expect(closedWith).toBe(false);
  });

  it('rejects the factory when connect fails (ENOENT)', async () => {
    const bogusPath = join(tmp, 'does-not-exist.sock');
    await expect(
      createIpcClient({
        socketPath: bogusPath,
        extensionId: 'ext-a',
        onEnvelope: () => {},
      }),
    ).rejects.toThrow(/ENOENT/);
  });

  it('fires onClose when the server closes the underlying connection', async () => {
    server = await createIpcServer({ socketPath });
    let closed = false;
    const client = await createIpcClient({
      socketPath,
      extensionId: 'ext-a',
      onEnvelope: () => {},
      onClose: () => {
        closed = true;
      },
    });
    await waitFor(() => server!.listConnections().length === 1);
    await server.close();
    server = null;
    await waitFor(() => closed);
    expect(client.send({ type: 'event' }).ok).toBe(false);
  });
});
