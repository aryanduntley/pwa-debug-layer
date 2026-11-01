import { describe, it, expect } from 'vitest';
import { TOOLS } from '../../../src/mcp/tools/index.js';
import { HELP_TOPICS } from '../../../src/help/topics.js';
import { SERVER_INSTRUCTIONS } from '../../../src/help/instructions.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';

const ctx = {} as ToolContext;
const help = TOOLS.find((t) => t.name === 'pdl_help')!;
const toolNames = new Set(TOOLS.map((t) => t.name));

describe('pdl_help registry coverage', () => {
  it('is registered', () => {
    expect(help).toBeDefined();
  });

  it('every tool named in a topic exists in the registry', () => {
    const missing = HELP_TOPICS.flatMap((t) =>
      t.tools.filter((name) => !toolNames.has(name)).map((name) => `${t.id}:${name}`),
    );
    expect(missing).toEqual([]);
  });

  it('every registered tool is covered by at least one topic', () => {
    const covered = new Set(HELP_TOPICS.flatMap((t) => t.tools));
    expect([...toolNames].filter((n) => !covered.has(n))).toEqual([]);
  });

  it('topic ids are unique', () => {
    const ids = HELP_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every tool name mentioned in the server instructions exists', () => {
    const mentioned = SERVER_INSTRUCTIONS.match(/\b(?:pdl|host|session|console|network|error|sw|storage)_[a-z_]+\b/g) ?? [];
    expect(mentioned.filter((n) => !toolNames.has(n))).toEqual([]);
  });
});

describe('pdl_help handler', () => {
  it('returns the overview with no args, counting the whole registry', async () => {
    const r = await help.handler({} as never, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as { toolCount: number }).toolCount).toBe(TOOLS.length);
  });

  it('documents a real tool from its live schema', async () => {
    const r = await help.handler({ tool: 'pdl_navigate' } as never, ctx);
    const data = r.data as { parameters: { name: string; required: boolean }[] };
    expect(data.parameters.find((p) => p.name === 'url')).toMatchObject({ required: true });
  });

  it('documents itself', async () => {
    const r = await help.handler({ tool: 'pdl_help' } as never, ctx);
    const data = r.data as { parameters: { name: string; description?: string }[] };
    expect(data.parameters.map((p) => p.name)).toEqual(['topic', 'tool']);
    expect(data.parameters[0]!.description).toContain('mobile');
  });

  it('returns an error response for an unknown topic', async () => {
    const r = await help.handler({ topic: 'nope' } as never, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown topic: nope');
  });
});
