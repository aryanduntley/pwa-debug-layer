import { describe, it, expect, vi } from 'vitest';

describe('@pwa-debug/host smoke', () => {
  it('main entry imports and exports main()', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mod = await import('../src/main.js');
    expect(typeof mod.main).toBe('function');
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
