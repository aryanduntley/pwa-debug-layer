import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TransportRouter } from '../transport/types.js';
import type { CdpTransport } from '../transport/cdp_transport.js';
import type { AndroidBridge } from '../android_adb/bridge.js';

import type { CapturesRegistry } from '../captures_in/captures_in.js';
import type { SettingsStore } from '../host_settings/host_settings.js';

/** Attach/detach/list control over CDP page connections (absent in tests that do not need it). */
export type CdpControl = Pick<CdpTransport, 'attach' | 'detach' | 'targets'>;

/** Phone discovery + attach over adb (absent in tests that do not need it). */
export type AndroidControl = Pick<AndroidBridge, 'devices' | 'attach'>;

export type ToolContext = Readonly<{
  /** Every live connection (extension NMH + CDP); IpcServer-shaped. */
  ipcServer: TransportRouter;
  hostVersion: string;
  capturesRegistry: CapturesRegistry;
  settingsStore: SettingsStore;
  cdp?: CdpControl;
  android?: AndroidControl;
}>;

export type ToolResponse = Readonly<{
  ok: boolean;
  data?: unknown;
  error?: string;
  next_steps: readonly string[];
}>;

export type ToolDef<Args extends z.ZodRawShape = z.ZodRawShape> = Readonly<{
  name: string;
  description: string;
  inputSchema: Args;
  handler: (
    args: z.infer<z.ZodObject<Args>>,
    ctx: ToolContext,
  ) => Promise<ToolResponse>;
}>;

export const okResponse = (
  data: unknown,
  next_steps: readonly string[],
): ToolResponse =>
  Object.freeze({ ok: true, data, next_steps: Object.freeze([...next_steps]) });

export const errorResponse = (
  error: string,
  next_steps: readonly string[],
): ToolResponse =>
  Object.freeze({ ok: false, error, next_steps: Object.freeze([...next_steps]) });

export const registerTools = (
  server: McpServer,
  tools: readonly ToolDef[],
  ctx: ToolContext,
): void => {
  for (const tool of tools) {
    // The SDK's registerTool generics are tied to the per-call inputSchema; we
    // erase to `any` here because each ToolDef carries its own typed handler.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown) => {
        const response = await tool.handler(args as never, ctx);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(response, null, 2) },
          ],
          structuredContent: response as unknown as Record<string, unknown>,
        };
      },
    );
  }
};
