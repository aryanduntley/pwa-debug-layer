import type {
  IpcEnvelope,
  IpcRequestEnvelope,
  IpcResponseEnvelope,
} from '../mcp/ipc/envelope.js';
import type { IpcConnectionInfo, IpcSendResult } from '../mcp/ipc/ipc_server.js';

/** Which transport owns a connection. */
export type TransportKind = 'extension' | 'cdp';

/**
 * A live connection as tools see it. `extensionId` keeps its historical name
 * but is the connection id for every kind (CDP connections use a 'cdp:' id).
 */
export type TransportConnectionInfo = IpcConnectionInfo & {
  readonly kind: TransportKind;
  readonly label?: string;
};

type RequestFn = (
  connectionId: string,
  env: IpcRequestEnvelope,
  opts?: { readonly timeoutMs?: number },
) => Promise<IpcResponseEnvelope>;

type SendToFn = (connectionId: string, env: IpcEnvelope) => IpcSendResult;

/** What every transport implements so the router can merge and dispatch. */
export type Transport = {
  readonly kind: TransportKind;
  readonly listConnections: () => readonly TransportConnectionInfo[];
  readonly request: RequestFn;
  readonly sendTo: SendToFn;
  readonly close: () => Promise<void>;
};

/**
 * IpcServer-shaped surface over every transport. ToolContext.ipcServer holds
 * one, so tool handlers call the same request/listConnections as before.
 */
export type TransportRouter = {
  readonly listConnections: () => readonly TransportConnectionInfo[];
  readonly request: RequestFn;
  readonly sendTo: SendToFn;
  readonly close: () => Promise<void>;
};
