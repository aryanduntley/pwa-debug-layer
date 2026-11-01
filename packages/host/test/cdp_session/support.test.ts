import { describe, it, expect } from 'vitest';
import { TOOLS } from '../../src/mcp/tools/index.js';
import { EXTENSION_ONLY_TOOLS, HOST_LEVEL_TOOLS, cdpSupportOf } from '../../src/cdp_session/support.js';

const names = new Set(TOOLS.map((t) => t.name));

describe('CDP tool support table', () => {
  it('only names registered tools', () => {
    expect([...HOST_LEVEL_TOOLS, ...Object.keys(EXTENSION_ONLY_TOOLS)].filter((n) => !names.has(n))).toEqual([]);
  });

  it('classifies every registered tool', () => {
    const table = Object.fromEntries([...names].map((n) => [n, cdpSupportOf(n)]));
    expect(table['recent_events']).toBe('extension_only');
    expect(table['pdl_android_attach']).toBe('host');
    expect(table['react_tree']).toBe('works');
    expect(table['pdl_tap']).toBe('works');
    expect(Object.values(table).filter((v) => v === 'extension_only')).toHaveLength(1);
  });
});
