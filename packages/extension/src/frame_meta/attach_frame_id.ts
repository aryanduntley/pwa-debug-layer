import type { CapturedEvent } from '../captures/types.js';

export const attachFrameId = (
  event: CapturedEvent,
  frameId: number | undefined,
): CapturedEvent => {
  if (frameId === undefined) return event;
  return { ...event, frameId } as CapturedEvent;
};
