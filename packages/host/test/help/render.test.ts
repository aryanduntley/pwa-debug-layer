import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  describeParams,
  renderOverview,
  renderTopic,
  renderToolHelp,
  resolveHelp,
} from '../../src/help/render.js';
import type { HelpToolEntry, HelpTopic } from '../../src/help/types.js';

const TOOLS: readonly HelpToolEntry[] = [
  {
    name: 'pdl_click',
    description: 'Click an element. Fires the full pointer chain.',
    inputSchema: {
      selector: z.string().min(1).optional(),
      nth: z.number().int().nonnegative().optional(),
      framework: z.enum(['react', 'vue']).optional(),
    },
  },
  {
    name: 'pdl_navigate',
    description: 'Navigate a tab to a URL. Waits for load.',
    inputSchema: {
      url: z.string().min(1).describe('target URL'),
      timeout_ms: z.number().optional(),
    },
  },
];

const TOPICS: readonly HelpTopic[] = [
  {
    id: 'control',
    title: 'Driving the page: navigation and interaction',
    summary: 'Navigate and click yourself.',
    guide: ['You control the page.'],
    tools: ['pdl_navigate', 'pdl_click', 'pdl_missing'],
  },
  {
    id: 'mobile',
    title: 'Phones',
    summary: 'Android phones today.',
    guide: ['Use chrome://inspect/#devices.'],
    tools: ['pdl_click'],
  },
];

describe('describeParams', () => {
  it('derives type, required, enum values and descriptions from zod', () => {
    const params = describeParams({
      url: z.string().describe('target URL'),
      n: z.number().int().optional(),
      ratio: z.number(),
      mode: z.enum(['a', 'b']).optional(),
      list: z.array(z.string()).optional(),
      filter: z.object({ since: z.string(), limit: z.number() }).optional(),
      flag: z.boolean().default(false),
    });
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    expect(byName.url).toEqual({ name: 'url', type: 'string', required: true, description: 'target URL' });
    expect(byName.n).toMatchObject({ type: 'integer', required: false });
    expect(byName.ratio).toMatchObject({ type: 'number', required: true });
    expect(byName.mode).toMatchObject({ type: 'enum', values: ['a', 'b'], required: false });
    expect(byName.list).toMatchObject({ type: 'string[]' });
    expect(byName.filter).toMatchObject({ type: 'object { since, limit }' });
    expect(byName.flag).toMatchObject({ type: 'boolean', required: false });
  });

  it('returns an empty list for a tool with no parameters', () => {
    expect(describeParams({})).toEqual([]);
  });
});

describe('renderOverview', () => {
  it('lists capabilities, workflow, usage and every topic', () => {
    const r = renderOverview(TOPICS, 2);
    expect(r.ok).toBe(true);
    const data = r.data as Record<string, unknown>;
    expect(data.toolCount).toBe(2);
    expect((data.topics as { id: string }[]).map((t) => t.id)).toEqual(['control', 'mobile']);
    expect((data.capabilities as string[]).length).toBeGreaterThan(0);
    expect((data.how_to_use_help as string[]).join(' ')).toContain('pdl_help({ tool');
  });
});

describe('renderTopic', () => {
  it('returns the guide and summaries of registered tools only', () => {
    const r = renderTopic(TOPICS[0]!, TOOLS);
    const data = r.data as { guide: string[]; tools: { name: string; summary: string }[] };
    expect(data.guide).toEqual(['You control the page.']);
    expect(data.tools).toEqual([
      { name: 'pdl_navigate', summary: 'Navigate a tab to a URL.' },
      { name: 'pdl_click', summary: 'Click an element.' },
    ]);
  });
});

describe('renderToolHelp', () => {
  it('returns description, parameters and covering topics', () => {
    const r = renderToolHelp(TOOLS[0]!, TOPICS);
    const data = r.data as { tool: string; parameters: { name: string }[]; topics: string[] };
    expect(data.tool).toBe('pdl_click');
    expect(data.parameters.map((p) => p.name)).toEqual(['selector', 'nth', 'framework']);
    expect(data.topics).toEqual(['control', 'mobile']);
    expect(r.next_steps[0]).toContain('"control"');
  });
});

describe('resolveHelp', () => {
  it('returns the overview with no arguments or blank arguments', () => {
    expect((resolveHelp({}, TOPICS, TOOLS).data as { title: string }).title).toContain('pwa-debug');
    expect((resolveHelp({ topic: '  ' }, TOPICS, TOOLS).data as { title: string }).title).toContain('pwa-debug');
  });

  it('resolves a topic case-insensitively', () => {
    const r = resolveHelp({ topic: 'MOBILE' }, TOPICS, TOOLS);
    expect((r.data as { topic: string }).topic).toBe('mobile');
  });

  it('resolves a tool case-insensitively and prefers tool over topic', () => {
    const r = resolveHelp({ topic: 'mobile', tool: 'PDL_NAVIGATE' }, TOPICS, TOOLS);
    expect((r.data as { tool: string }).tool).toBe('pdl_navigate');
  });

  it('suggests close topics for an unknown topic', () => {
    const r = resolveHelp({ topic: 'android' }, TOPICS, TOOLS);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown topic: android');
    expect(r.next_steps[0]).toContain('mobile');
  });

  it('matches an unknown topic against titles', () => {
    const r = resolveHelp({ topic: 'navigation' }, TOPICS, TOOLS);
    expect(r.next_steps[0]).toContain('control');
  });

  it('suggests close tools for an unknown tool', () => {
    const r = resolveHelp({ tool: 'click' }, TOPICS, TOOLS);
    expect(r.ok).toBe(false);
    expect(r.next_steps[0]).toContain('pdl_click');
  });

  it('lists all topics when nothing is similar', () => {
    const r = resolveHelp({ topic: 'zzzz' }, TOPICS, TOOLS);
    expect(r.next_steps[0]).toBe('Topics: control, mobile.');
  });
});
