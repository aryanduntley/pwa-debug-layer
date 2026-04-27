import { describe, it, expect } from 'vitest';
import { respondToMessage } from '../../src/modes/nmh_mode.js';

const ctx = { hostVersion: 'test-1.2.3', pid: 4242 } as const;

describe('respondToMessage', () => {
  it('responds to a well-formed ping with pong + metadata', () => {
    const r = respondToMessage({ kind: 'ping', id: 'abc' }, ctx);
    expect(r).toEqual({ kind: 'pong', echo: 'abc', hostVersion: 'test-1.2.3', pid: 4242 });
  });

  it('returns error envelope when message is not an object', () => {
    expect(respondToMessage(null, ctx)).toEqual({ kind: 'error', reason: 'message-not-object' });
    expect(respondToMessage('hi', ctx)).toEqual({ kind: 'error', reason: 'message-not-object' });
    expect(respondToMessage(7, ctx)).toEqual({ kind: 'error', reason: 'message-not-object' });
  });

  it('returns error envelope on unknown kind', () => {
    expect(respondToMessage({ kind: 'frobnicate' }, ctx)).toEqual({
      kind: 'error',
      reason: 'unknown-kind',
      got: 'frobnicate',
    });
  });

  it('returns error envelope when ping is missing id', () => {
    expect(respondToMessage({ kind: 'ping' }, ctx)).toEqual({
      kind: 'error',
      reason: 'unknown-kind',
      got: 'ping',
    });
  });

  it('returns error envelope when ping id is not a string', () => {
    expect(respondToMessage({ kind: 'ping', id: 42 }, ctx)).toEqual({
      kind: 'error',
      reason: 'unknown-kind',
      got: 'ping',
    });
  });
});
