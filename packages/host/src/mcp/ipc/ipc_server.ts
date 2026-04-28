import { unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import {
  createIpcFrameReader,
  encodeIpcEnvelope,
  type IpcEnvelope,
  type IpcEventEnvelope,
  type IpcRequestEnvelope,
  type IpcResponseEnvelope,
} from './envelope.js';

export type IpcConnectionInfo = {
  readonly extensionId: string;
  readonly connectedAt: number;
  readonly lastSeenAt: number;
};

export type IpcSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export type IpcServerOptions = {
  readonly socketPath: string;
  readonly onRegister?: (info: IpcConnectionInfo) => void;
  readonly onRequest?: (extensionId: string, env: IpcRequestEnvelope) => void;
  readonly onEvent?: (extensionId: string, env: IpcEventEnvelope) => void;
  readonly onDisconnect?: (extensionId: string) => void;
  readonly defaultRequestTimeoutMs?: number;
};

export type IpcServer = {
  readonly close: () => Promise<void>;
  readonly sendTo: (extensionId: string, env: IpcEnvelope) => IpcSendResult;
  readonly request: (
    extensionId: string,
    env: IpcRequestEnvelope,
    opts?: { readonly timeoutMs?: number },
  ) => Promise<IpcResponseEnvelope>;
  readonly listConnections: () => readonly IpcConnectionInfo[];
};

type Conn = {
  readonly extensionId: string;
  readonly socket: Socket;
  readonly connectedAt: number;
  lastSeenAt: number;
};

type Pending = {
  readonly extensionId: string;
  readonly resolve: (env: IpcResponseEnvelope) => void;
  readonly reject: (err: Error) => void;
  readonly timeoutHandle: NodeJS.Timeout;
};

const DEFAULT_TIMEOUT_MS = 5000;

const snapshotConn = (c: Conn): IpcConnectionInfo =>
  Object.freeze({
    extensionId: c.extensionId,
    connectedAt: c.connectedAt,
    lastSeenAt: c.lastSeenAt,
  });

export const createIpcServer = async (
  opts: IpcServerOptions,
): Promise<IpcServer> => {
  const connections = new Map<string, Conn>();
  const pending = new Map<string, Pending>();
  const defaultTimeout = opts.defaultRequestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const rejectPendingFor = (extensionId: string, reason: string): void => {
    for (const [reqId, p] of pending) {
      if (p.extensionId === extensionId) {
        clearTimeout(p.timeoutHandle);
        pending.delete(reqId);
        p.reject(new Error(reason));
      }
    }
  };

  const handleSocket = (socket: Socket): void => {
    let registeredId: string | null = null;
    const reader = createIpcFrameReader();

    const onData = (chunk: Buffer): void => {
      let envelopes: readonly IpcEnvelope[];
      try {
        envelopes = reader.push(chunk);
      } catch (err) {
        socket.destroy(err as Error);
        return;
      }
      for (const env of envelopes) {
        if (env.type === 'register') {
          if (registeredId !== null) continue;
          const prior = connections.get(env.extensionId);
          if (prior) {
            connections.delete(env.extensionId);
            rejectPendingFor(
              env.extensionId,
              `ipc server: connection replaced for ${env.extensionId}`,
            );
            prior.socket.destroy();
          }
          registeredId = env.extensionId;
          const now = Date.now();
          const conn: Conn = {
            extensionId: env.extensionId,
            socket,
            connectedAt: now,
            lastSeenAt: now,
          };
          connections.set(env.extensionId, conn);
          opts.onRegister?.(snapshotConn(conn));
          continue;
        }
        if (registeredId === null) {
          socket.destroy(
            new Error('ipc server: client sent envelope before register'),
          );
          return;
        }
        const conn = connections.get(registeredId);
        if (!conn) continue;
        conn.lastSeenAt = Date.now();
        if (env.type === 'response') {
          const p = pending.get(env.requestId);
          if (p && p.extensionId === registeredId) {
            clearTimeout(p.timeoutHandle);
            pending.delete(env.requestId);
            p.resolve(env);
          }
        } else if (env.type === 'request') {
          opts.onRequest?.(registeredId, env);
        } else if (env.type === 'event') {
          opts.onEvent?.(registeredId, env);
        }
      }
    };

    const onClose = (): void => {
      if (registeredId === null) return;
      const conn = connections.get(registeredId);
      if (conn && conn.socket === socket) {
        connections.delete(registeredId);
        rejectPendingFor(
          registeredId,
          `ipc server: connection closed for ${registeredId}`,
        );
        opts.onDisconnect?.(registeredId);
      }
    };

    socket.on('data', onData);
    socket.on('close', onClose);
    socket.on('error', () => {
      // 'close' will follow; intentional no-op to avoid uncaught error events.
    });
  };

  const server: Server = createServer(handleSocket);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(opts.socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const sendTo = (extensionId: string, env: IpcEnvelope): IpcSendResult => {
    const conn = connections.get(extensionId);
    if (!conn) {
      return Object.freeze({
        ok: false as const,
        error: `no connected NMH for ${extensionId}`,
      });
    }
    try {
      conn.socket.write(encodeIpcEnvelope(env));
      return Object.freeze({ ok: true as const });
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: (err as Error).message,
      });
    }
  };

  const request = (
    extensionId: string,
    env: IpcRequestEnvelope,
    o?: { readonly timeoutMs?: number },
  ): Promise<IpcResponseEnvelope> => {
    const timeoutMs = o?.timeoutMs ?? defaultTimeout;
    return new Promise<IpcResponseEnvelope>((resolve, reject) => {
      if (pending.has(env.requestId)) {
        reject(
          new Error(`ipc server: duplicate requestId ${env.requestId}`),
        );
        return;
      }
      const sendResult = sendTo(extensionId, env);
      if (!sendResult.ok) {
        reject(new Error(sendResult.error));
        return;
      }
      const timeoutHandle = setTimeout(() => {
        pending.delete(env.requestId);
        reject(
          new Error(
            `ipc server: request ${env.requestId} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      pending.set(
        env.requestId,
        Object.freeze({ extensionId, resolve, reject, timeoutHandle }),
      );
    });
  };

  const listConnections = (): readonly IpcConnectionInfo[] =>
    Object.freeze(Array.from(connections.values(), snapshotConn));

  const close = async (): Promise<void> => {
    for (const [, p] of pending) {
      clearTimeout(p.timeoutHandle);
      p.reject(new Error('ipc server: closed'));
    }
    pending.clear();
    for (const conn of connections.values()) {
      conn.socket.destroy();
    }
    connections.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    if (process.platform !== 'win32') {
      try {
        await unlink(opts.socketPath);
      } catch {
        // socket file may already be gone
      }
    }
  };

  return Object.freeze({ close, sendTo, request, listConnections });
};
