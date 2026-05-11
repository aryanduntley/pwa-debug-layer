import type { FrameMeta } from '../captures/capture_console.js';
import { deriveFrameKey } from './derive_frame_key.js';

const detectCrossOrigin = (win: Window): boolean => {
  if (win === win.top) return false;
  try {
    void win.parent.location.href;
    return false;
  } catch {
    return true;
  }
};

export const computeFrameMeta = (win: Window = window): FrameMeta => ({
  frameUrl: win.location.href,
  frameKey: deriveFrameKey(win),
  isCrossOrigin: detectCrossOrigin(win),
});
