const DEFAULT_MAX_BYTES = 16_384;

export type SerializedTag =
  | { readonly __type: 'DOMNode'; readonly nodeName: string; readonly id?: string }
  | { readonly __type: 'Function'; readonly name?: string }
  | { readonly __type: 'Promise' }
  | {
      readonly __type: 'Error';
      readonly name: string;
      readonly message: string;
      readonly stack?: string;
    }
  | { readonly __type: 'Cycle' }
  | {
      readonly __type: 'Truncated';
      readonly approxSize: number;
      readonly max: number;
    };

export type SerializeOptions = {
  readonly maxBytes?: number;
};

export type SerializeResult = {
  readonly serialized: readonly unknown[];
  readonly truncated: boolean;
};

const tagDomNode = (n: Node): SerializedTag => {
  const el = n as Element;
  const id = typeof el.id === 'string' && el.id.length > 0 ? el.id : undefined;
  return id === undefined
    ? { __type: 'DOMNode', nodeName: n.nodeName }
    : { __type: 'DOMNode', nodeName: n.nodeName, id };
};

const tagError = (e: Error): SerializedTag =>
  e.stack === undefined
    ? { __type: 'Error', name: e.name, message: e.message }
    : { __type: 'Error', name: e.name, message: e.message, stack: e.stack };

export const serializeValue = (
  value: unknown,
  seen: WeakSet<object>,
): unknown => {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'undefined') return undefined;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value) ? value : String(value);
  if (t === 'bigint') return `${(value as bigint).toString()}n`;
  if (t === 'symbol') return (value as symbol).toString();
  if (t === 'function') {
    const name = (value as { name?: string }).name;
    return name !== undefined && name.length > 0
      ? { __type: 'Function' as const, name }
      : { __type: 'Function' as const };
  }
  if (t !== 'object') return String(value);

  const obj = value as object;
  if (seen.has(obj)) return { __type: 'Cycle' as const };
  seen.add(obj);

  if (typeof Node !== 'undefined' && obj instanceof Node) return tagDomNode(obj);
  if (obj instanceof Error) return tagError(obj);
  if (typeof Promise !== 'undefined' && obj instanceof Promise) {
    return { __type: 'Promise' as const };
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => serializeValue(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    out[key] = serializeValue((obj as Record<string, unknown>)[key], seen);
  }
  return out;
};

const approxByteSize = (v: unknown): number => {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

export const serializeArgs = (
  args: readonly unknown[],
  opts?: SerializeOptions,
): SerializeResult => {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  let truncated = false;
  const serialized = args.map((arg) => {
    const walked = serializeValue(arg, new WeakSet<object>());
    const size = approxByteSize(walked);
    if (size > maxBytes) {
      truncated = true;
      return {
        __type: 'Truncated' as const,
        approxSize: size,
        max: maxBytes,
      };
    }
    return walked;
  });
  return { serialized, truncated };
};
