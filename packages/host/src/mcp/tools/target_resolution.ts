import type { ToolContext } from '../tool_registry.js';

export type ResolvedTarget =
  | { readonly ok: true; readonly extensionId: string }
  | { readonly ok: false; readonly error: string };

/**
 * Pick the connection a tool call goes to. `argId` (the tools' extension_id
 * arg) may name any live connection: an extension id or a CDP connection id.
 */
export const resolveTarget = (
  ctx: ToolContext,
  argId: string | undefined,
): ResolvedTarget => {
  const conns = ctx.ipcServer.listConnections();
  if (argId !== undefined) {
    const found = conns.find((c) => c.extensionId === argId);
    if (!found) {
      return {
        ok: false,
        error: `no connected NMH for extension_id=${argId} (no extension or CDP connection has that id; host_status lists activeConnections)`,
      };
    }
    return { ok: true, extensionId: argId };
  }
  if (conns.length === 0) {
    return { ok: false, error: 'no NMH connected (no extension or CDP connection is live)' };
  }
  if (conns.length > 1) {
    return {
      ok: false,
      error: `multiple NMH connections (${conns.length} live extension/CDP connections); pass extension_id explicitly (an extension id or a CDP connection id from host_status activeConnections)`,
    };
  }
  return { ok: true, extensionId: conns[0]!.extensionId };
};
