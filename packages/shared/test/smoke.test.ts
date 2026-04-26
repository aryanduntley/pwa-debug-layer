import { describe, it, expect } from 'vitest';
import type { HostToExtensionMessage } from '../src/protocol.js';

describe('@pwa-debug/shared smoke', () => {
  it('protocol HostToExtensionMessage accepts a ping variant', () => {
    const msg: HostToExtensionMessage = { kind: 'ping', id: 'smoke' };
    expect(msg.kind).toBe('ping');
    expect(msg.id).toBe('smoke');
  });
});
