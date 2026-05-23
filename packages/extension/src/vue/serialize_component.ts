/**
 * Page-world Vue single-component serializer — parity with
 * react/serialize_component, over Vue's ComponentInternalInstance. Projects a
 * resolved instance's identity (stable id, display name, key) plus its props,
 * setup() bindings (setupState), and options-API data, each run through the
 * shared 16KB-capped serializeArgs so vue.* never duplicates serialization.
 *
 * Pure: reads instance fields only; the caller resolves the instance from a
 * stable id (resolveStableId) before handing it here.
 */
import { computeStableId } from './compute_stable_id.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';
import { serializeArgs } from '../captures/serialize.js';
import type { ComponentInternalInstance } from './types.js';

export type VueComponentInfo = {
  readonly stableId: string;
  readonly displayName: string;
  readonly key?: string;
  readonly props?: unknown;
  readonly setupState?: unknown;
  readonly data?: unknown;
  readonly truncated?: boolean;
};

export type SerializeVueComponentOptions = {
  readonly includeProps?: boolean;
  readonly includeState?: boolean;
};

const serializeField = (
  value: unknown,
): { readonly value: unknown; readonly truncated: boolean } => {
  const r = serializeArgs([value]);
  return { value: r.serialized[0], truncated: r.truncated };
};

/** True when v is a non-null object with at least one own enumerable key. */
const hasEntries = (v: unknown): boolean =>
  v !== null && typeof v === 'object' && Object.keys(v as object).length > 0;

/**
 * Serialize one Vue component instance. props are included unless
 * includeProps === false; setupState + data are included unless
 * includeState === false. Empty surfaces are omitted entirely. `truncated` is
 * set when any included field hit the serializer's size cap.
 */
export const serializeVueComponent = (
  instance: ComponentInternalInstance,
  rootIndex = 0,
  options: SerializeVueComponentOptions = {},
): VueComponentInfo => {
  const includeProps = options.includeProps !== false;
  const includeState = options.includeState !== false;

  const stableId = computeStableId(instance, rootIndex);
  const displayName = extractDisplayName(instance);
  const key = extractKey(instance);

  let props: unknown;
  let propsTruncated = false;
  if (includeProps && hasEntries(instance.props)) {
    const ser = serializeField(instance.props);
    props = ser.value;
    propsTruncated = ser.truncated;
  }

  let setupState: unknown;
  let setupTruncated = false;
  if (includeState && hasEntries(instance.setupState)) {
    const ser = serializeField(instance.setupState);
    setupState = ser.value;
    setupTruncated = ser.truncated;
  }

  let data: unknown;
  let dataTruncated = false;
  if (includeState && hasEntries(instance.data)) {
    const ser = serializeField(instance.data);
    data = ser.value;
    dataTruncated = ser.truncated;
  }

  const truncated = propsTruncated || setupTruncated || dataTruncated;

  return {
    stableId,
    displayName,
    ...(key !== undefined ? { key } : {}),
    ...(props !== undefined ? { props } : {}),
    ...(setupState !== undefined ? { setupState } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
};
