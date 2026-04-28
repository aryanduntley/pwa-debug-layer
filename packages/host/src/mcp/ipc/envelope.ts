import { createFrameReader, frameMessage } from '../../native-messaging/framing.js';

export type IpcRegisterEnvelope = {
  readonly type: 'register';
  readonly extensionId: string;
};

export type IpcRequestEnvelope = {
  readonly type: 'request';
  readonly requestId: string;
  readonly tool: string;
  readonly extensionId?: string;
  readonly payload?: unknown;
};

export type IpcResponseEnvelope = {
  readonly type: 'response';
  readonly requestId: string;
  readonly payload?: unknown;
  readonly error?: { readonly message: string };
};

export type IpcEventEnvelope = {
  readonly type: 'event';
  readonly extensionId?: string;
  readonly tool?: string;
  readonly payload?: unknown;
};

export type IpcEnvelope =
  | IpcRegisterEnvelope
  | IpcRequestEnvelope
  | IpcResponseEnvelope
  | IpcEventEnvelope;

export type IpcFrameReader = {
  readonly push: (chunk: Uint8Array) => readonly IpcEnvelope[];
  readonly bufferedBytes: () => number;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object';

const isOptionalString = (v: unknown): v is string | undefined =>
  v === undefined || typeof v === 'string';

const isErrorField = (v: unknown): v is { message: string } | undefined => {
  if (v === undefined) return true;
  return isRecord(v) && typeof v['message'] === 'string';
};

export const parseIpcEnvelope = (value: unknown): IpcEnvelope => {
  if (!isRecord(value)) {
    throw new Error('ipc envelope: root is not an object');
  }
  const type = value['type'];
  if (type === 'register') {
    if (typeof value['extensionId'] !== 'string') {
      throw new Error('ipc envelope: register.extensionId is not a string');
    }
    return Object.freeze({ type, extensionId: value['extensionId'] });
  }
  if (type === 'request') {
    if (typeof value['requestId'] !== 'string') {
      throw new Error('ipc envelope: request.requestId is not a string');
    }
    if (typeof value['tool'] !== 'string') {
      throw new Error('ipc envelope: request.tool is not a string');
    }
    if (!isOptionalString(value['extensionId'])) {
      throw new Error('ipc envelope: request.extensionId must be string or absent');
    }
    return Object.freeze({
      type,
      requestId: value['requestId'],
      tool: value['tool'],
      ...(value['extensionId'] !== undefined && { extensionId: value['extensionId'] }),
      ...('payload' in value && { payload: value['payload'] }),
    });
  }
  if (type === 'response') {
    if (typeof value['requestId'] !== 'string') {
      throw new Error('ipc envelope: response.requestId is not a string');
    }
    if (!isErrorField(value['error'])) {
      throw new Error('ipc envelope: response.error must be { message: string } or absent');
    }
    return Object.freeze({
      type,
      requestId: value['requestId'],
      ...('payload' in value && { payload: value['payload'] }),
      ...(value['error'] !== undefined && {
        error: Object.freeze({ message: (value['error'] as { message: string }).message }),
      }),
    });
  }
  if (type === 'event') {
    if (!isOptionalString(value['extensionId'])) {
      throw new Error('ipc envelope: event.extensionId must be string or absent');
    }
    if (!isOptionalString(value['tool'])) {
      throw new Error('ipc envelope: event.tool must be string or absent');
    }
    return Object.freeze({
      type,
      ...(value['extensionId'] !== undefined && { extensionId: value['extensionId'] }),
      ...(value['tool'] !== undefined && { tool: value['tool'] }),
      ...('payload' in value && { payload: value['payload'] }),
    });
  }
  throw new Error(`ipc envelope: unknown type ${JSON.stringify(type)}`);
};

export const encodeIpcEnvelope = (env: IpcEnvelope): Uint8Array => frameMessage(env);

export const createIpcFrameReader = (): IpcFrameReader => {
  const inner = createFrameReader();
  return Object.freeze({
    push: (chunk: Uint8Array): readonly IpcEnvelope[] =>
      Object.freeze(inner.push(chunk).map(parseIpcEnvelope)),
    bufferedBytes: (): number => inner.bufferedBytes(),
  });
};
