import type { Fiber } from './types.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';
import { unkeyedOccurrence } from './unkeyed_occurrence.js';

const HOST_ROOT_TAG = 3;

const segmentFor = (fiber: Fiber): string => {
  const name = extractDisplayName(fiber);
  const key = extractKey(fiber);
  const discriminator = key ?? String(unkeyedOccurrence(fiber));
  return `${name}[${discriminator}]`;
};

export const computeStableId = (fiber: Fiber, rootIndex = 0): string => {
  const segments: string[] = [];

  let cursor: Fiber | null = fiber;
  while (cursor !== null && cursor.tag !== HOST_ROOT_TAG) {
    segments.unshift(segmentFor(cursor));
    cursor = cursor.return;
  }

  segments.unshift(`root${rootIndex}`);
  return segments.join('/');
};
