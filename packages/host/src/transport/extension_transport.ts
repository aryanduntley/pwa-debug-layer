import type { IpcServer } from '../mcp/ipc/ipc_server.js';
import type { Transport, TransportConnectionInfo } from './types.js';

/** Expose the native-messaging IPC server as the 'extension' transport. */
export const fromIpcServer = (ipcServer: IpcServer): Transport =>
  Object.freeze({
    kind: 'extension' as const,
    listConnections: (): readonly TransportConnectionInfo[] =>
      ipcServer
        .listConnections()
        .map((c) => Object.freeze({ ...c, kind: 'extension' as const })),
    request: ipcServer.request,
    sendTo: ipcServer.sendTo,
    close: ipcServer.close,
  });
