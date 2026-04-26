import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

describe('@pwa-debug/extension smoke', () => {
  beforeAll(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
  afterAll(() => vi.restoreAllMocks());

  it('page-world entry imports and exports bootstrap()', async () => {
    const m = await import('../src/page-world.js');
    expect(typeof m.bootstrap).toBe('function');
  });
  it('content-script entry imports and exports bootstrap()', async () => {
    const m = await import('../src/content-script.js');
    expect(typeof m.bootstrap).toBe('function');
  });
  it('service-worker entry imports and exports bootstrap()', async () => {
    const m = await import('../src/service-worker.js');
    expect(typeof m.bootstrap).toBe('function');
  });
});
