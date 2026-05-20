import { z } from 'zod';
import {
  errorResponse,
  okResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import {
  getSettingEntry,
  settingKeys,
  type SettingKey,
} from '@pwa-debug/shared';

const isKnownKey = (k: string): k is SettingKey =>
  (settingKeys() as readonly string[]).includes(k);

const wireEntry = (key: SettingKey) => {
  const e = getSettingEntry(key);
  return {
    key: e.key,
    type: e.type,
    default: e.default,
    scope: e.scope,
    description: e.description,
    ...(e.enumValues ? { enumValues: e.enumValues } : {}),
  };
};

const inputSchema = {
  key: z.string().optional(),
};

export const settingsGetHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  if (args.key === undefined) {
    return okResponse({ values: ctx.settingsStore.getAll() }, [
      'Call settings_get({ key }) for a single setting, or settings_list_schema for the typed schema.',
      'Persistence: ~/.config/pwa-debug/settings.json — survives host restart.',
    ]);
  }
  if (!isKnownKey(args.key)) {
    return errorResponse(`unknown setting key: '${args.key}'`, [
      'Call settings_list_schema to see the valid key set + each entry’s expected type.',
    ]);
  }
  return okResponse(
    {
      key: args.key,
      value: ctx.settingsStore.getSetting(args.key),
      entry: wireEntry(args.key),
    },
    [
      'Call settings_set({ key, value }) to update. value must match entry.type (number | boolean | string[] | enum[] subset).',
    ],
  );
};

export const settingsGetTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'settings_get',
  description:
    'Reads host settings. Omit key to receive every value. Provide key to receive { value, entry } where entry is the wire-safe schema metadata (type, default, scope, description, enumValues). Unknown keys return an error referencing settings_list_schema.',
  inputSchema,
  handler: settingsGetHandler,
});
