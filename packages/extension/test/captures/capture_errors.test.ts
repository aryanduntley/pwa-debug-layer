import { describe, it, expect, afterEach } from 'vitest';
import { installErrorCapture } from '../../src/captures/capture_errors.js';
import type { FrameMeta } from '../../src/captures/capture_console.js';
import type { PageErrorCapturedEvent } from '../../src/captures/types.js';

const FRAME: FrameMeta = { frameUrl: 'https://x/', frameKey: 'top' };

const rejectionEvent = (reason: unknown): Event => {
  const ev = new Event('unhandledrejection');
  (ev as unknown as { reason: unknown }).reason = reason;
  return ev;
};

describe('installErrorCapture', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    if (dispose) dispose();
    dispose = undefined;
  });

  it("emits a page_error on a window 'error' event with name/source", () => {
    const got: PageErrorCapturedEvent[] = [];
    dispose = installErrorCapture((e) => got.push(e), FRAME);
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'boom',
        error: new Error('boom'),
        filename: 'https://x/app.js',
        lineno: 10,
        colno: 5,
      }),
    );
    expect(got).toHaveLength(1);
    expect(got[0]!.kind).toBe('page_error');
    expect(got[0]!.subkind).toBe('error');
    expect(got[0]!.message).toBe('boom');
    expect(got[0]!.name).toBe('Error');
    expect(got[0]!.source).toBe('https://x/app.js:10:5');
    expect(got[0]!.frameKey).toBe('top');
  });

  it("emits a page_error on an 'unhandledrejection' with the reason message", () => {
    const got: PageErrorCapturedEvent[] = [];
    dispose = installErrorCapture((e) => got.push(e), FRAME);
    window.dispatchEvent(rejectionEvent(new Error('user rejected')));
    expect(got).toHaveLength(1);
    expect(got[0]!.subkind).toBe('unhandledrejection');
    expect(got[0]!.message).toBe('user rejected');
  });

  it('unwraps non-Error rejection reasons (string / object message)', () => {
    const got: PageErrorCapturedEvent[] = [];
    dispose = installErrorCapture((e) => got.push(e), FRAME);
    window.dispatchEvent(rejectionEvent('plain string reason'));
    window.dispatchEvent(rejectionEvent({ message: 'object message' }));
    expect(got.map((e) => e.message)).toEqual([
      'plain string reason',
      'object message',
    ]);
  });

  it('stops emitting after dispose', () => {
    const got: PageErrorCapturedEvent[] = [];
    const d = installErrorCapture((e) => got.push(e), FRAME);
    d();
    window.dispatchEvent(rejectionEvent(new Error('after dispose')));
    expect(got).toHaveLength(0);
  });
});
