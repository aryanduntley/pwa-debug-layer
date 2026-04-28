import { vi } from 'vitest';

vi.stubGlobal('chrome', {
  runtime: {
    id: 'test-extension-id-aabbccddeeff00112233445566778899',
    onInstalled: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
    connectNative: vi.fn().mockReturnValue({
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    }),
    getManifest: vi.fn().mockReturnValue({ version: '0.0.0-test' }),
    lastError: undefined,
  },
  tabs: {
    query: vi.fn().mockResolvedValue([{ id: 7, active: true }]),
    sendMessage: vi.fn().mockResolvedValue({
      payload: {
        url: 'https://test.example/',
        title: 'Test Page',
        readyState: 'complete',
      },
    }),
  },
});
