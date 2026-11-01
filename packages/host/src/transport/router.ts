import type { IpcEnvelope, IpcRequestEnvelope } from '../mcp/ipc/envelope.js';
import type { IpcSendResult } from '../mcp/ipc/ipc_server.js';
import type {
  Transport,
  TransportConnectionInfo,
  TransportRouter,
} from './types.js';

// Same wording the IPC server has always used, so existing callers and the
// tests that match on it keep working when the id belongs to no transport.
const unknownConnection = (id: string): string => `no connected NMH for ${id}`;

/**
 * Merge every transport's connections and send each call to the transport
 * that currently lists the id. Ownership is looked up per call because
 * connections come and go (NMH respawns, CDP attach/detach).
 */
export const createTransportRouter = (
  transports: readonly Transport[],
): TransportRouter => {
  const owner = (id: string): Transport | undefined =>
    transports.find((t) => t.listConnections().some((c) => c.extensionId === id));

  const listConnections = (): readonly TransportConnectionInfo[] =>
    Object.freeze(transports.flatMap((t) => t.listConnections()));

  const request = (
    id: string,
    env: IpcRequestEnvelope,
    opts?: { readonly timeoutMs?: number },
  ) => {
    const t = owner(id);
    return t !== undefined
      ? t.request(id, env, opts)
      : Promise.reject(new Error(unknownConnection(id)));
  };

  const sendTo = (id: string, env: IpcEnvelope): IpcSendResult => {
    const t = owner(id);
    return t !== undefined
      ? t.sendTo(id, env)
      : Object.freeze({ ok: false as const, error: unknownConnection(id) });
  };

  const close = async (): Promise<void> => {
    await Promise.all(transports.map((t) => t.close()));
  };

  return Object.freeze({ listConnections, request, sendTo, close });
};
