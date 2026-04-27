import { vi } from 'vitest';

vi.stubGlobal('chrome', {
  runtime: {
    id: 'test-extension-id-aabbccddeeff00112233445566778899',
    onInstalled: { addListener: vi.fn() },
    connectNative: vi.fn().mockReturnValue({
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    }),
    lastError: undefined,
  },
});
