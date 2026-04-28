import { createConnection } from 'node:net';
import {
  createIpcFrameReader,
  encodeIpcEnvelope,
  type IpcEnvelope,
} from './envelope.js';
import type { IpcSendResult } from './ipc_server.js';

export type IpcClientOptions = {
  readonly socketPath: string;
  readonly extensionId: string;
  readonly onEnvelope: (env: IpcEnvelope) => void;
  readonly onClose?: (hadError: boolean) => void;
};

export type IpcClient = {
  readonly send: (env: IpcEnvelope) => IpcSendResult;
  readonly close: () => void;
};

export const createIpcClient = async (
  opts: IpcClientOptions,
): Promise<IpcClient> => {
  const reader = createIpcFrameReader();
  const socket = createConnection(opts.socketPath);

  await new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      socket.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      socket.off('connect', onConnect);
      reject(err);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });

  socket.write(
    encodeIpcEnvelope({ type: 'register', extensionId: opts.extensionId }),
  );

  socket.on('data', (chunk: Buffer) => {
    let envelopes: readonly IpcEnvelope[];
    try {
      envelopes = reader.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const env of envelopes) {
      opts.onEnvelope(env);
    }
  });

  socket.on('error', () => {
    // 'close' will follow with hadError=true.
  });

  socket.on('close', (hadError: boolean) => {
    opts.onClose?.(hadError);
  });

  const send = (env: IpcEnvelope): IpcSendResult => {
    if (socket.destroyed) {
      return Object.freeze({
        ok: false as const,
        error: 'ipc client: socket destroyed',
      });
    }
    try {
      socket.write(encodeIpcEnvelope(env));
      return Object.freeze({ ok: true as const });
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: (err as Error).message,
      });
    }
  };

  const close = (): void => {
    socket.destroy();
  };

  return Object.freeze({ send, close });
};
