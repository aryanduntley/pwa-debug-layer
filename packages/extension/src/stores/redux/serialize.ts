/**
 * Thin adapter that wraps captures/serialize's array-shaped serializeArgs for
 * single-value Redux state slices. Reuses the same 16KB cap, cycle protection,
 * DOM/Error/function tagging, so redux.* tools never duplicate serialization
 * logic that already lives in captures.
 */
import { serializeArgs } from '../../captures/serialize.js';

export type SerializedStoreValue = {
  readonly value: unknown;
  readonly truncated: boolean;
};

export const serializeStoreValue = (value: unknown): SerializedStoreValue => {
  const r = serializeArgs([value]);
  return { value: r.serialized[0], truncated: r.truncated };
};
