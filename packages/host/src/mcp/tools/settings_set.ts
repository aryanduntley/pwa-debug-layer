import { z } from 'zod';
import {
  errorResponse,
  okResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import {
  settingKeys,
  type SettingKey,
} from '@pwa-debug/shared';

const isKnownKey = (k: string): k is SettingKey =>
  (settingKeys() as readonly string[]).includes(k);

const LIST_SCHEMA_HINT =
  'Call settings_list_schema to see the expected type tag (number | boolean | string[] | enum[]) and enumValues for this key.';

const inputSchema = {
  key: z.string(),
  value: z.unknown(),
};

export const settingsSetHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  if (!isKnownKey(args.key)) {
    return errorResponse(`unknown setting key: '${args.key}'`, [
      LIST_SCHEMA_HINT,
    ]);
  }
  // The store re-validates at runtime via validateSettingValue; the cast here
  // is the bridge from MCP-layer unknown to the per-key typed setSetting.
  const result = await ctx.settingsStore.setSetting(args.key, args.value as never);
  if (!result.ok) {
    return errorResponse(result.error, [LIST_SCHEMA_HINT]);
  }
  return okResponse(
    {
      key: args.key,
      value: ctx.settingsStore.getSetting(args.key),
    },
    [
      'Persisted to ~/.config/pwa-debug/settings.json — survives host restart.',
      'In-process subscribers (capture pipeline once T4 lands, ext_settings_cache once T3 lands) are notified immediately.',
    ],
  );
};

export const settingsSetTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'settings_set',
  description:
    'Writes a single host setting. Validates the value against the per-key schema validator (rejects with a schema-contextualized error). On accept: atomic-persists to ~/.config/pwa-debug/settings.json and notifies in-process subscribers. Unknown keys and invalid values are rejected with a next_step pointing at settings_list_schema.',
  inputSchema,
  handler: settingsSetHandler,
});
