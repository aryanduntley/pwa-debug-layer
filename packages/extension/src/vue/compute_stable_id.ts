import type { ComponentInternalInstance } from './types.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';
import { unkeyedOccurrence } from './unkeyed_occurrence.js';

const segmentFor = (instance: ComponentInternalInstance): string => {
  const name = extractDisplayName(instance);
  const key = extractKey(instance);
  const discriminator = key ?? String(unkeyedOccurrence(instance));
  return `${name}[${discriminator}]`;
};

/**
 * Path-based stable id for a Vue component instance, resilient across
 * re-renders: `root{i}/Name[disc]/…` walking up `instance.parent` to the root
 * component. Mirrors react computeStableId, but the root component itself is
 * the first child segment (Vue has no HostRoot wrapper above it), so the root
 * App resolves to `root{i}/App[0]`.
 */
export const computeStableId = (
  instance: ComponentInternalInstance,
  rootIndex = 0,
): string => {
  const segments: string[] = [];
  let cursor: ComponentInternalInstance | null = instance;
  while (cursor !== null) {
    segments.unshift(segmentFor(cursor));
    cursor = cursor.parent;
  }
  segments.unshift(`root${rootIndex}`);
  return segments.join('/');
};
