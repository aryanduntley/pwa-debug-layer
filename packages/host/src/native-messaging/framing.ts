const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export type FrameReader = {
  readonly push: (chunk: Uint8Array) => unknown[];
  readonly bufferedBytes: () => number;
};

export const frameMessage = (value: unknown): Uint8Array => {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error('framing: value is not JSON-serializable');
  }
  const body = new TextEncoder().encode(json);
  if (body.byteLength > MAX_MESSAGE_BYTES) {
    throw new Error(
      `framing: message body ${body.byteLength}B exceeds max ${MAX_MESSAGE_BYTES}B`,
    );
  }
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, true);
  out.set(body, 4);
  return out;
};

export const createFrameReader = (): FrameReader => {
  let buf = new Uint8Array(0);

  const push = (chunk: Uint8Array): unknown[] => {
    if (chunk.byteLength === 0) return [];

    const merged = new Uint8Array(buf.byteLength + chunk.byteLength);
    merged.set(buf, 0);
    merged.set(chunk, buf.byteLength);

    const out: unknown[] = [];
    let offset = 0;

    while (merged.byteLength - offset >= 4) {
      const view = new DataView(merged.buffer, merged.byteOffset + offset, 4);
      const len = view.getUint32(0, true);
      if (len > MAX_MESSAGE_BYTES) {
        throw new Error(
          `framing: incoming length ${len} exceeds max ${MAX_MESSAGE_BYTES}`,
        );
      }
      if (merged.byteLength - offset < 4 + len) break;
      const body = merged.subarray(offset + 4, offset + 4 + len);
      const json = new TextDecoder('utf-8', { fatal: true }).decode(body);
      out.push(JSON.parse(json));
      offset += 4 + len;
    }

    buf =
      offset < merged.byteLength
        ? merged.slice(offset)
        : new Uint8Array(0);
    return out;
  };

  return {
    push,
    bufferedBytes: () => buf.byteLength,
  };
};
