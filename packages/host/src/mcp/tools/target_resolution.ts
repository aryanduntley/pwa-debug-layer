import type { ToolContext } from '../tool_registry.js';

export type ResolvedTarget =
  | { readonly ok: true; readonly extensionId: string }
  | { readonly ok: false; readonly error: string };

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
        error: `no connected NMH for extension_id=${argId}`,
      };
    }
    return { ok: true, extensionId: argId };
  }
  if (conns.length === 0) {
    return { ok: false, error: 'no NMH connected' };
  }
  if (conns.length > 1) {
    return {
      ok: false,
      error: `multiple NMH connections (${conns.length}); pass extension_id explicitly`,
    };
  }
  return { ok: true, extensionId: conns[0]!.extensionId };
};
