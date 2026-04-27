import { describe, it, expect, vi } from 'vitest';

describe('@pwa-debug/host smoke', () => {
  it('main entry imports and exports main + detectMode', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const mod = await import('../src/main.js');
    expect(typeof mod.main).toBe('function');
    expect(typeof mod.detectMode).toBe('function');
    vi.restoreAllMocks();
  });
});
