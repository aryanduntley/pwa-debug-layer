import { mkdtemp, rm, stat } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createIpcFrameReader,
  encodeIpcEnvelope,
  type IpcEnvelope,
} from '../../../src/mcp/ipc/envelope.js';
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

const connectAndRegister = async (
  socketPath: string,
  extensionId: string,
): Promise<{
  socket: Socket;
  receive: () => Promise<IpcEnvelope>;
  receiveAll: () => readonly IpcEnvelope[];
}> => {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const reader = createIpcFrameReader();
  const inbox: IpcEnvelope[] = [];
  socket.on('data', (chunk) => {
    inbox.push(...reader.push(chunk));
  });
  socket.write(
    encodeIpcEnvelope({ type: 'register', extensionId }),
  );
  return {
    socket,
    receive: async () => {
      await waitFor(() => inbox.length > 0);
      return inbox.shift() as IpcEnvelope;
    },
    receiveAll: () => Object.freeze([...inbox]),
  };
};

describe('createIpcServer', () => {
  let tmp: string;
  let socketPath: string;
  let server: IpcServer | null = null;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pwa-debug-ipc-'));
    socketPath = join(tmp, 'mcp.sock');
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('binds the socket file on listen', async () => {
    server = await createIpcServer({ socketPath });
    const s = await stat(socketPath);
    expect(s.isSocket()).toBe(true);
  });

  it('populates connection map on register handshake', async () => {
    const registered: string[] = [];
    server = await createIpcServer({
      socketPath,
      onRegister: (info) => registered.push(info.extensionId),
    });
    const client = await connectAndRegister(socketPath, 'ext-a');
    await waitFor(() => registered.length === 1);
    expect(registered).toEqual(['ext-a']);
    expect(server.listConnections().map((c) => c.extensionId)).toEqual([
      'ext-a',
    ]);
    client.socket.destroy();
  });

  it('sendTo returns ok:false for unknown extensionId', async () => {
    server = await createIpcServer({ socketPath });
    const result = server.sendTo('nope', { type: 'event' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no connected NMH/);
  });

  it('sendTo writes a framed envelope to the connected client', async () => {
    server = await createIpcServer({ socketPath });
    const client = await connectAndRegister(socketPath, 'ext-a');
    await waitFor(() => server!.listConnections().length === 1);
    const result = server.sendTo('ext-a', {
      type: 'request',
      requestId: 'r1',
      tool: 'session_ping',
    });
    expect(result.ok).toBe(true);
    const env = await client.receive();
    expect(env).toEqual({
      type: 'request',
      requestId: 'r1',
      tool: 'session_ping',
    });
    client.socket.destroy();
  });

  it('request resolves on a matching response envelope', async () => {
    server = await createIpcServer({ socketPath });
    const client = await connectAndRegister(socketPath, 'ext-a');
    await waitFor(() => server!.listConnections().length === 1);
    const promise = server.request('ext-a', {
      type: 'request',
      requestId: 'r1',
      tool: 'session_ping',
    });
    const incoming = await client.receive();
    expect(incoming.type).toBe('request');
    client.socket.write(
      encodeIpcEnvelope({
        type: 'response',
        requestId: 'r1',
        payload: { hostVersion: '1.0.0' },
      }),
    );
    const response = await promise;
    expect(response).toEqual({
      type: 'response',
      requestId: 'r1',
      payload: { hostVersion: '1.0.0' },
    });
    client.socket.destroy();
  });

  it('request rejects after timeoutMs if no response arrives', async () => {
    server = await createIpcServer({ socketPath });
    const client = await connectAndRegister(socketPath, 'ext-a');
    await waitFor(() => server!.listConnections().length === 1);
    await expect(
      server.request(
        'ext-a',
        { type: 'request', requestId: 'r1', tool: 'slow' },
        { timeoutMs: 30 },
      ),
    ).rejects.toThrow(/timed out after 30ms/);
    client.socket.destroy();
  });

  it('request rejects when no connection exists for extensionId', async () => {
    server = await createIpcServer({ socketPath });
    await expect(
      server.request('missing', {
        type: 'request',
        requestId: 'r1',
        tool: 'session_ping',
      }),
    ).rejects.toThrow(/no connected NMH/);
  });

  it('request rejects on duplicate requestId', async () => {
    server = await createIpcServer({ socketPath });
    const client = await connectAndRegister(socketPath, 'ext-a');
    await waitFor(() => server!.listConnections().length === 1);
    const first = server.request(
      'ext-a',
      { type: 'request', requestId: 'r1', tool: 'session_ping' },
      { timeoutMs: 200 },
    );
    await expect(
      server.request('ext-a', {
        type: 'request',
        requestId: 'r1',
        tool: 'session_ping',
      }),
    ).rejects.toThrow(/duplicate requestId/);
    await expect(first).rejects.toThrow(/timed out/);
    client.socket.destroy();
  });

  it('rejects pending requests on disconnect', async () => {
    const disconnected: string[] = [];
    server = await createIpcServer({
      socketPath,
      onDisconnect: (id) => disconnected.push(id),
    });
    const client = await connectAndRegister(socketPath, 'ext-a');
    await waitFor(() => server!.listConnections().length === 1);
    const promise = server.request(
      'ext-a',
      { type: 'request', requestId: 'r1', tool: 'session_ping' },
      { timeoutMs: 5000 },
    );
    client.socket.destroy();
    await expect(promise).rejects.toThrow(/connection closed for ext-a/);
    await waitFor(() => disconnected.length === 1);
    expect(disconnected).toEqual(['ext-a']);
    expect(server.listConnections()).toEqual([]);
  });

  it('replaces prior connection on re-register from same extensionId', async () => {
    server = await createIpcServer({ socketPath });
    const first = await connectAndRegister(socketPath, 'ext-a');
    await waitFor(() => server!.listConnections().length === 1);
    const firstConnectedAt = server.listConnections()[0]?.connectedAt as number;
    await new Promise((r) => setTimeout(r, 5));
    const second = await connectAndRegister(socketPath, 'ext-a');
    await waitFor(
      () =>
        (server!.listConnections()[0]?.connectedAt as number) >
        firstConnectedAt,
    );
    expect(server.listConnections()).toHaveLength(1);
    expect(server.listConnections()[0]?.extensionId).toBe('ext-a');
    second.socket.destroy();
  });

  it('destroys sockets that send envelopes before register', async () => {
    server = await createIpcServer({ socketPath });
    const socket = connect(socketPath);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    socket.write(
      encodeIpcEnvelope({
        type: 'request',
        requestId: 'r1',
        tool: 'x',
      }),
    );
    await closed;
    expect(server.listConnections()).toEqual([]);
  });

  it('updates lastSeenAt on inbound envelopes', async () => {
    server = await createIpcServer({ socketPath });
    const client = await connectAndRegister(socketPath, 'ext-a');
    await waitFor(() => server!.listConnections().length === 1);
    const initial = server.listConnections()[0]?.lastSeenAt as number;
    await new Promise((r) => setTimeout(r, 10));
    client.socket.write(encodeIpcEnvelope({ type: 'event', tool: 'hello' }));
    await waitFor(
      () => (server!.listConnections()[0]?.lastSeenAt as number) > initial,
    );
    client.socket.destroy();
  });

  it('close() unlinks the socket file on POSIX', async () => {
    server = await createIpcServer({ socketPath });
    expect((await stat(socketPath)).isSocket()).toBe(true);
    await server.close();
    server = null;
    await expect(stat(socketPath)).rejects.toThrow(/ENOENT/);
  });
});
