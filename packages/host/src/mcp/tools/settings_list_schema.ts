import { z } from 'zod';
import {
  okResponse,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import {
  getSettingEntry,
  settingKeys,
  type SettingKey,
  type SettingScope,
  type SettingTypeTag,
} from '@pwa-debug/shared';

/** Wire-safe shape returned for each schema entry (no validate fn). */
type SchemaEntryWire = {
  readonly key: SettingKey;
  readonly type: SettingTypeTag;
  readonly default: unknown;
  readonly scope: SettingScope;
  readonly description: string;
  readonly enumValues?: readonly string[];
};

const toWire = (key: SettingKey): SchemaEntryWire => {
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

export const settingsListSchemaHandler = async (): Promise<ToolResponse> => {
  const schema = settingKeys().map(toWire);
  return okResponse(
    { schema },
    [
      'Call settings_get({ key }) to read the current value of a single setting, or settings_get({}) to read every value.',
      'Call settings_set({ key, value }) to update a setting. The value MUST match the entry’s "type" tag: number, boolean, string[], or enum[] (subset of enumValues, no duplicates).',
      'Default values are shown under "default". Persistence: ~/.config/pwa-debug/settings.json — survives host restart.',
    ],
  );
};

export const settingsListSchemaTool: ToolDef<Record<string, never>> =
  Object.freeze({
    name: 'settings_list_schema',
    description:
      'Returns every user-tunable host setting as data: key, runtime type tag (number | boolean | string[] | enum[]), default, consuming scope (host | extension | both), human description, and enumValues (for enum[] entries). Order is stable schema-declaration order. Use this BEFORE settings_set so the value shape matches the entry type — settings_set rejects invalid shapes with a schema-contextualized error.',
    inputSchema: {} as Record<string, never>,
    handler: settingsListSchemaHandler,
  });

void z;
