import { vi } from 'vitest';

vi.stubGlobal('chrome', {
  runtime: {
    onInstalled: { addListener: vi.fn() },
  },
});
