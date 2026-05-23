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

const SVELTE_COMPONENTS_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
};

type SvelteComponent = {
  readonly stableId: string;
  readonly file: string;
  readonly firstLoc?: { readonly line?: number; readonly column?: number };
  readonly elementCount: number;
};

type SvelteComponentsPayload = {
  readonly present: boolean;
  readonly dev: boolean;
  readonly metaElementCount: number;
  readonly components: ReadonlyArray<SvelteComponent>;
  readonly scopeUrl: string;
};

const readPayload = (raw: unknown): SvelteComponentsPayload | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r['present'] !== 'boolean' ||
    typeof r['dev'] !== 'boolean' ||
    typeof r['metaElementCount'] !== 'number' ||
    !Array.isArray(r['components'])
  ) {
    return null;
  }
  return r as unknown as SvelteComponentsPayload;
};

export const svelteComponentsMcpHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension at brave://extensions.',
    ]);
  }

  const wirePayload: Record<string, unknown> = {};
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'svelte_components',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: SVELTE_COMPONENTS_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`svelte_components failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the svelte_components handler is wired in the SW.',
    ]);
  }

  if (response.error) {
    return errorResponse(`svelte_components nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab or page-bridge timeout (page-world not attached on chrome:// pages).',
    ]);
  }

  const payload = readPayload(response.payload);
  if (payload === null) {
    return errorResponse(
      'svelte_components returned a malformed payload.',
      [
        'The page-world handler did not match the expected shape. Check packages/extension/src/svelte/discover.ts.',
      ],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    present: payload.present,
    dev: payload.dev,
    metaElementCount: payload.metaElementCount,
    components: payload.components,
  };

  const nextSteps: string[] = [
    'components[] contains { stableId, file, firstLoc?, elementCount }. Svelte is one component per .svelte file, so the file path IS the component identity (stableId). Feed a file into svelte_find_by_text/role results to cross-reference. NOTE: Svelte exposes no component-instance object, so there is no svelte_get_state — props/state are not generically readable.',
  ];
  if (!payload.present) {
    nextSteps.push(
      'present:false — no Svelte detected. Verify the page actually runs Svelte.',
    );
  } else if (!payload.dev) {
    nextSteps.push(
      'present:true but dev:false — this looks like a PRODUCTION Svelte build. Component discovery relies on the dev-only __svelte_meta tags, which production strips, so components[] is empty. Introspection requires a dev build.',
    );
  }

  return okResponse(data, nextSteps);
};

export const svelteComponentsTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'svelte_components',
  description:
    "List the Svelte components rendered on the active (or specified) tab. Args: { extension_id?, tab_id? }. Returns { extensionId, tabId, present, dev, metaElementCount, components: { stableId, file, firstLoc?, elementCount }[] }. Svelte compiles components to closures with no instance tree, so discovery uses the dev-only __svelte_meta source tags: each component == one .svelte file (the file path is its stableId), and elementCount is how many rendered elements belong to it. dev:false means a production build (no __svelte_meta) → components is empty. There is NO svelte_get_state (Svelte exposes no readable instance/state). Use svelte_find_by_text / svelte_find_by_role to locate components by content. Runs in page-world via the page-bridge — no CDP. CALL host_status FIRST.",
  inputSchema,
  handler: svelteComponentsMcpHandler,
});
