import { describe, it, expect, afterEach } from 'vitest';
import { installWalletCapture } from '../../src/captures/capture_wallet.js';
import type { FrameMeta } from '../../src/captures/capture_console.js';
import type { PageErrorCapturedEvent } from '../../src/captures/types.js';

const FRAME: FrameMeta = { frameUrl: 'https://x/', frameKey: 'top' };

const rejectingProvider = (message: string, code?: number): { request: (...a: unknown[]) => Promise<unknown> } => ({
  request: async () => {
    const e = new Error(message) as Error & { code?: number };
    if (code !== undefined) e.code = code;
    throw e;
  },
});

describe('installWalletCapture', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    if (dispose) dispose();
    dispose = undefined;
    try {
      delete (window as unknown as { ethereum?: unknown }).ethereum;
    } catch {
      /* ignore */
    }
  });

  it('emits a wallet_rejection page_error on an EIP-1193 request rejection (code 4001)', async () => {
    const got: PageErrorCapturedEvent[] = [];
    const provider = rejectingProvider('User rejected the request', 4001);
    (window as unknown as { ethereum: unknown }).ethereum = provider;
    dispose = installWalletCapture((e) => got.push(e), FRAME);

    await expect(
      provider.request({ method: 'eth_requestAccounts' }),
    ).rejects.toThrow('User rejected the request');

    expect(got).toHaveLength(1);
    expect(got[0]!.kind).toBe('page_error');
    expect(got[0]!.subkind).toBe('wallet_rejection');
    expect(got[0]!.message).toBe(
      'eth_requestAccounts rejected (code 4001): User rejected the request',
    );
  });

  it('passes successful requests through untouched (no emit)', async () => {
    const got: PageErrorCapturedEvent[] = [];
    const provider = { request: async (): Promise<string> => '0x1' };
    (window as unknown as { ethereum: unknown }).ethereum = provider;
    dispose = installWalletCapture((e) => got.push(e), FRAME);

    await expect(provider.request({ method: 'eth_chainId' })).resolves.toBe('0x1');
    expect(got).toHaveLength(0);
  });

  it('wraps an EIP-6963 announced provider', async () => {
    const got: PageErrorCapturedEvent[] = [];
    dispose = installWalletCapture((e) => got.push(e), FRAME);

    const announced = rejectingProvider('user denied', 4001);
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: { info: {}, provider: announced },
      }),
    );

    await expect(announced.request({ method: 'personal_sign' })).rejects.toThrow(
      'user denied',
    );
    expect(got.some((e) => e.message.includes('personal_sign rejected'))).toBe(true);
    expect(got.some((e) => e.subkind === 'wallet_rejection')).toBe(true);
  });

  it('restores the original request on dispose', () => {
    const original = async (): Promise<string> => 'ok';
    const provider = { request: original } as { request: unknown };
    (window as unknown as { ethereum: unknown }).ethereum = provider;
    const d = installWalletCapture(() => {}, FRAME);
    expect(provider.request).not.toBe(original);
    d();
    expect(provider.request).toBe(original);
  });
});
