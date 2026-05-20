import { describe, it, expect } from 'vitest';
import {
  CAPTURE_KINDS,
  settingKeys,
  validateSettingValue,
  type SettingKey,
  type SettingScope,
  type SettingTypeTag,
} from '@pwa-debug/shared';
import {
  settingsListSchemaHandler,
  settingsListSchemaTool,
} from '../../../src/mcp/tools/settings_list_schema.js';

type WireEntry = {
  readonly key: SettingKey;
  readonly type: SettingTypeTag;
  readonly default: unknown;
  readonly scope: SettingScope;
  readonly description: string;
  readonly enumValues?: readonly string[];
};

const callHandler = async () => {
  const r = await settingsListSchemaHandler();
  expect(r.ok).toBe(true);
  const data = r.data as { schema: readonly WireEntry[] };
  return { response: r, schema: data.schema };
};

describe('settings_list_schema tool', () => {
  it('inputSchema is empty (no args)', () => {
    expect(settingsListSchemaTool.inputSchema).toEqual({});
  });

  it('returns one entry per SettingKey in schema-declaration order', async () => {
    const { schema } = await callHandler();
    const expected = settingKeys();
    expect(schema.map((e) => e.key)).toEqual(expected);
  });

  it('every entry has the wire-safe fields (no validate function)', async () => {
    const { schema } = await callHandler();
    for (const e of schema) {
      expect(typeof e.key).toBe('string');
      expect(['number', 'boolean', 'string[]', 'enum[]']).toContain(e.type);
      expect(['host', 'extension', 'both']).toContain(e.scope);
      expect(typeof e.description).toBe('string');
      expect(e.description.length).toBeGreaterThan(0);
      expect(e.default).not.toBeUndefined();
      // Critically: the non-serializable validate fn must NOT leak onto the wire.
      expect((e as unknown as { validate?: unknown }).validate).toBeUndefined();
    }
  });

  it('enum[] entries (and only those) carry enumValues', async () => {
    const { schema } = await callHandler();
    for (const e of schema) {
      if (e.type === 'enum[]') {
        expect(Array.isArray(e.enumValues)).toBe(true);
        expect((e.enumValues ?? []).length).toBeGreaterThan(0);
      } else {
        expect(e.enumValues).toBeUndefined();
      }
    }
    // capture.enabledKinds is the only enum[] entry in M7 — its enumValues is CAPTURE_KINDS.
    const enabledKinds = schema.find((e) => e.key === 'capture.enabledKinds');
    expect(enabledKinds?.enumValues).toEqual(CAPTURE_KINDS);
  });

  it("every returned default passes its own key's validator (defense-in-depth)", async () => {
    const { schema } = await callHandler();
    for (const e of schema) {
      expect(validateSettingValue(e.key, e.default)).toBe(true);
    }
  });

  it('response is JSON-serializable (no functions, no cycles)', async () => {
    const { response } = await callHandler();
    const json = JSON.stringify(response);
    const round = JSON.parse(json);
    expect(round.ok).toBe(true);
    expect(Array.isArray(round.data.schema)).toBe(true);
    expect(round.data.schema.length).toBe(settingKeys().length);
    expect(Array.isArray(round.next_steps)).toBe(true);
    expect(round.next_steps.length).toBeGreaterThan(0);
  });

  it('tool name and description are populated for the MCP registry', () => {
    expect(settingsListSchemaTool.name).toBe('settings_list_schema');
    expect(settingsListSchemaTool.description.length).toBeGreaterThan(0);
  });
});
