import { stdin, stdout, stderr } from 'node:process';
import { createFrameReader, frameMessage } from '../native-messaging/framing.js';

const HOST_VERSION = '0.0.0-m3';
const UNSOLICITED_DELAY_MS = 5000;

export type RunNmhInput = {
  readonly origin: string;
  readonly manifestPath: string;
};

export const respondToMessage = (
  msg: unknown,
  ctx: { readonly hostVersion: string; readonly pid: number },
): unknown => {
  if (typeof msg !== 'object' || msg === null) {
    return { kind: 'error', reason: 'message-not-object' };
  }
  const m = msg as { kind?: unknown; id?: unknown };
  if (m.kind === 'ping' && typeof m.id === 'string') {
    return {
      kind: 'pong',
      echo: m.id,
      hostVersion: ctx.hostVersion,
      pid: ctx.pid,
    };
  }
  return { kind: 'error', reason: 'unknown-kind', got: m.kind };
};

export const runNmhMode = (input: RunNmhInput): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    stderr.write(
      `[pwa-debug-host nmh] origin=${input.origin} manifest=${input.manifestPath} pid=${process.pid}\n`,
    );

    const reader = createFrameReader();
    const ctx = { hostVersion: HOST_VERSION, pid: process.pid };

    const writeFrame = (value: unknown): void => {
      stdout.write(frameMessage(value));
    };

    const onData = (chunk: Buffer): void => {
      try {
        const arr = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for (const msg of reader.push(arr)) {
          writeFrame(respondToMessage(msg, ctx));
        }
      } catch (err) {
        reject(err);
      }
    };

    stdin.on('data', onData);
    stdin.once('end', () => {
      stderr.write('[pwa-debug-host nmh] stdin EOF\n');
      resolve();
    });
    stdin.once('error', reject);

    setTimeout(() => {
      try {
        writeFrame({
          kind: 'hello',
          at: new Date().toISOString(),
          source: 'unsolicited-push',
          hostVersion: HOST_VERSION,
        });
      } catch (err) {
        reject(err);
      }
    }, UNSOLICITED_DELAY_MS);
  });
