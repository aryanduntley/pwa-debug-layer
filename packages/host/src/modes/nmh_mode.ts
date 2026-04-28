import { stdin, stdout, stderr } from 'node:process';
import { createFrameReader, frameMessage } from '../native-messaging/framing.js';
import {
  parseIpcEnvelope,
  type IpcEnvelope,
} from '../mcp/ipc/envelope.js';
import { createIpcClient, type IpcClient } from '../mcp/ipc/ipc_client.js';
import { defaultSocketPath } from '../mcp/ipc/socket_path.js';

export type RunNmhInput = {
  readonly origin: string;
};

export const extensionIdFromOrigin = (origin: string): string => {
  const stripped = origin
    .replace(/^chrome-extension:\/\//, '')
    .replace(/\/$/, '');
  if (
    stripped.length === 0 ||
    stripped.includes('/') ||
    stripped.includes(':')
  ) {
    throw new Error(
      `nmh_mode: cannot derive extensionId from origin ${origin}`,
    );
  }
  return stripped;
};

export const runNmhMode = (input: RunNmhInput): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let extensionId: string;
    try {
      extensionId = extensionIdFromOrigin(input.origin);
    } catch (err) {
      reject(err);
      return;
    }
    const socketPath = defaultSocketPath();

    stderr.write(
      `[pwa-debug-host nmh] origin=${input.origin} extensionId=${extensionId} pid=${process.pid}\n`,
    );

    const reader = createFrameReader();
    let settled = false;
    let client: IpcClient | null = null;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      stdin.removeAllListeners('data');
      stdin.removeAllListeners('end');
      stdin.removeAllListeners('error');
      client?.close();
      if (err) reject(err);
      else resolve();
    };

    const onIpcEnvelope = (env: IpcEnvelope): void => {
      try {
        stdout.write(frameMessage(env));
      } catch (err) {
        finish(err as Error);
      }
    };

    const onIpcClose = (): void => {
      stderr.write('[pwa-debug-host nmh] ipc closed; exiting\n');
      finish();
    };

    createIpcClient({
      socketPath,
      extensionId,
      onEnvelope: onIpcEnvelope,
      onClose: onIpcClose,
    })
      .then((c) => {
        client = c;
        stdin.on('data', (chunk: Buffer) => {
          try {
            const arr = new Uint8Array(
              chunk.buffer,
              chunk.byteOffset,
              chunk.byteLength,
            );
            for (const raw of reader.push(arr)) {
              const env = parseIpcEnvelope(raw);
              const result = c.send(env);
              if (!result.ok) {
                finish(
                  new Error(`nmh_mode: ipc send failed: ${result.error}`),
                );
                return;
              }
            }
          } catch (err) {
            finish(err as Error);
          }
        });
        stdin.once('end', () => {
          stderr.write('[pwa-debug-host nmh] stdin EOF\n');
          finish();
        });
        stdin.once('error', (err) => finish(err));
      })
      .catch((err: Error) => {
        stderr.write(
          `[pwa-debug-host nmh] ipc connect failed: ${err.message}\n`,
        );
        finish(err);
      });
  });
