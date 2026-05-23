import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import type { IpcRequestEnvelope } from '../ipc/envelope.js';
import { resolveTarget } from './target_resolution.js';

const VUE_TREE_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  root_index: z.number().int().nonnegative().optional(),
  depth_limit: z.number().int().positive().max(64).optional(),
  max_nodes: z.number().int().positive().max(5000).optional(),
};

type VueTreeNode = {
  readonly stableId: string;
  readonly displayName: string;
  readonly key?: string;
  readonly hasProps: boolean;
  readonly hasState: boolean;
  readonly children: ReadonlyArray<VueTreeNode>;
};

type VueTreePayload = {
  readonly roots: ReadonlyArray<VueTreeNode>;
  readonly truncated: boolean;
  readonly rootCount: number;
};

const isTreeNode = (v: unknown): v is VueTreeNode => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['stableId'] === 'string' &&
    typeof r['displayName'] === 'string' &&
    typeof r['hasProps'] === 'boolean' &&
    typeof r['hasState'] === 'boolean' &&
    Array.isArray(r['children'])
  );
};

const readPayload = (raw: unknown): VueTreePayload | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r['roots'])) return null;
  if (typeof r['truncated'] !== 'boolean') return null;
  if (typeof r['rootCount'] !== 'number') return null;
  const roots = (r['roots'] as unknown[]).filter(isTreeNode);
  return Object.freeze({
    roots,
    truncated: r['truncated'],
    rootCount: r['rootCount'],
  });
};

export const vueTreeHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension at brave://extensions so Chrome respawns the NMH.',
    ]);
  }

  const wirePayload: Record<string, unknown> = {};
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;
  if (args.root_index !== undefined) wirePayload['root_index'] = args.root_index;
  if (args.depth_limit !== undefined) wirePayload['depth_limit'] = args.depth_limit;
  if (args.max_nodes !== undefined) wirePayload['max_nodes'] = args.max_nodes;

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'vue_tree',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: VUE_TREE_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`vue_tree failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Check the extension service worker console; confirm the SW is connected to the host. If the SW responder is missing the vue_tree handler, the request will time out.',
    ]);
  }

  if (response.error) {
    return errorResponse(`vue_tree nmh error: ${response.error.message}`, [
      "NMH-mode rejected the request. Common causes: no active tab (open an http(s) tab to a Vue page), explicit tab_id not found, page-bridge timeout (page-world script not attached on chrome:// or chrome web store pages), or the page-world vue module threw. Inspect the SW console for [pwa-debug] errors.",
    ]);
  }

  const payload = readPayload(response.payload);
  if (payload === null) {
    return errorResponse(
      'vue_tree returned a malformed payload (missing roots/truncated/rootCount).',
      [
        'The page-world handler returned a shape that does not match VueTreeResult. Check packages/extension/src/vue/serialize_tree.ts and confirm wire JSON encoding preserved the structure.',
      ],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    roots: payload.roots,
    truncated: payload.truncated,
    rootCount: payload.rootCount,
  };

  const nextSteps: string[] = [
    'roots[] contains VueTreeNode { stableId, displayName, key?, hasProps, hasState, children }. Pass a stableId to vue_get_state to fetch the component\'s props + setup() bindings + options-API data. The id format is stable across re-renders that preserve identity — re-call vue_tree to refresh after structural changes; the same id resolves the same component.',
  ];
  if (payload.rootCount === 0) {
    nextSteps.push(
      'rootCount===0 means no Vue app roots detected on the page. Verify the page mounts Vue 3 (a mount container carries __vue_app__) and that app.mount() has run before this call.',
    );
  }
  if (args.root_index !== undefined && args.root_index >= payload.rootCount) {
    nextSteps.push(
      `root_index=${args.root_index} is out of range — only ${payload.rootCount} root(s) exist. Re-call without root_index to see all roots.`,
    );
  }
  if (payload.truncated) {
    nextSteps.push(
      'truncated:true — depth_limit or max_nodes was hit before the full tree was emitted. Re-call with higher depth_limit (default 8) or max_nodes (default 200), or pass a specific root_index to scope the walk.',
    );
  }

  return okResponse(data, nextSteps);
};

export const vueTreeTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'vue_tree',
  description:
    "Return the Vue 3 component tree of the active (or specified) tab as a structured VueTreeNode[]. Each node has { stableId, displayName, key?, hasProps, hasState, children } where stableId is a re-render-stable component identity (path + name + key/index). Args: { extension_id?, tab_id?, root_index?: pick one root (default: all), depth_limit?: max depth (default 8, cap 64), max_nodes?: total cap (default 200, cap 5000) }. Returns { extensionId, tabId, roots, truncated, rootCount }. truncated:true means the walk hit depth_limit or max_nodes; re-call with a tighter root_index or higher caps. Pass any node's stableId to vue_get_state for that component's props/setupState/data. Runs in page-world (MAIN world) via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see which extensions are connected.",
  inputSchema,
  handler: vueTreeHandler,
});
