#!/usr/bin/env node
import { createReadStream, readdirSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, renameSync, readFileSync, watch, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stderr, stdin, stdout } from 'node:process';
import { createConnection, createServer } from 'node:net';
import { join, dirname, basename, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, access, appendFile, chmod, stat, unlink, readdir, constants, cp } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createInterface } from 'node:readline';
import require$$0 from 'util';
import require$$1 from 'path';
import require$$2 from 'child_process';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const frameMessage = (value) => {
    const json = JSON.stringify(value);
    if (json === undefined) {
        throw new Error('framing: value is not JSON-serializable');
    }
    const body = new TextEncoder().encode(json);
    if (body.byteLength > MAX_MESSAGE_BYTES) {
        throw new Error(`framing: message body ${body.byteLength}B exceeds max ${MAX_MESSAGE_BYTES}B`);
    }
    const out = new Uint8Array(4 + body.byteLength);
    new DataView(out.buffer).setUint32(0, body.byteLength, true);
    out.set(body, 4);
    return out;
};
const createFrameReader = () => {
    let buf = new Uint8Array(0);
    const push = (chunk) => {
        if (chunk.byteLength === 0)
            return [];
        const merged = new Uint8Array(buf.byteLength + chunk.byteLength);
        merged.set(buf, 0);
        merged.set(chunk, buf.byteLength);
        const out = [];
        let offset = 0;
        while (merged.byteLength - offset >= 4) {
            const view = new DataView(merged.buffer, merged.byteOffset + offset, 4);
            const len = view.getUint32(0, true);
            if (len > MAX_MESSAGE_BYTES) {
                throw new Error(`framing: incoming length ${len} exceeds max ${MAX_MESSAGE_BYTES}`);
            }
            if (merged.byteLength - offset < 4 + len)
                break;
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

const isRecord = (v) => v !== null && typeof v === 'object';
const isOptionalString = (v) => v === undefined || typeof v === 'string';
const isErrorField = (v) => {
    if (v === undefined)
        return true;
    return isRecord(v) && typeof v['message'] === 'string';
};
const parseIpcEnvelope = (value) => {
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
                error: Object.freeze({ message: value['error'].message }),
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
const encodeIpcEnvelope = (env) => frameMessage(env);
const createIpcFrameReader = () => {
    const inner = createFrameReader();
    return Object.freeze({
        push: (chunk) => Object.freeze(inner.push(chunk).map(parseIpcEnvelope)),
        bufferedBytes: () => inner.bufferedBytes(),
    });
};

const createIpcClient = async (opts) => {
    const reader = createIpcFrameReader();
    const socket = createConnection(opts.socketPath);
    await new Promise((resolve, reject) => {
        const onConnect = () => {
            socket.off('error', onError);
            resolve();
        };
        const onError = (err) => {
            socket.off('connect', onConnect);
            reject(err);
        };
        socket.once('connect', onConnect);
        socket.once('error', onError);
    });
    socket.write(encodeIpcEnvelope({ type: 'register', extensionId: opts.extensionId }));
    socket.on('data', (chunk) => {
        let envelopes;
        try {
            envelopes = reader.push(chunk);
        }
        catch {
            socket.destroy();
            return;
        }
        for (const env of envelopes) {
            opts.onEnvelope(env);
        }
    });
    socket.on('error', () => {
        // 'close' will follow with hadError=true.
    });
    socket.on('close', (hadError) => {
        opts.onClose?.(hadError);
    });
    const send = (env) => {
        if (socket.destroyed) {
            return Object.freeze({
                ok: false,
                error: 'ipc client: socket destroyed',
            });
        }
        try {
            socket.write(encodeIpcEnvelope(env));
            return Object.freeze({ ok: true });
        }
        catch (err) {
            return Object.freeze({
                ok: false,
                error: err.message,
            });
        }
    };
    const close = () => {
        socket.destroy();
    };
    return Object.freeze({ send, close });
};

const PIPE_NAME = 'pwa-debug-mcp';
const posixRunRoot = (env) => {
    if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0) {
        return join(env.XDG_CONFIG_HOME, 'pwa-debug', 'run');
    }
    if (env.HOME) {
        return join(env.HOME, '.config', 'pwa-debug', 'run');
    }
    throw new Error('socket_path: cannot resolve run dir; HOME and XDG_CONFIG_HOME are both unset');
};
const defaultSocketPath = (env = process.env, platform = process.platform) => {
    // Confinement-stable override. Baked into the NMH launcher at install time
    // with the host's REAL (unconfined) socket path. snap/flatpak remap
    // XDG_CONFIG_HOME/HOME inside the sandbox, so an NMH that re-derived the
    // socket from XDG would target a confined path the MCP host never listens on
    // ('Native host has exited'). When this is set it wins, so the sandboxed NMH
    // connects to the exact socket the host owns. Unset on native installs ->
    // the XDG resolution below applies unchanged.
    if (env.PWA_DEBUG_SOCKET && env.PWA_DEBUG_SOCKET.length > 0) {
        return env.PWA_DEBUG_SOCKET;
    }
    if (platform === 'win32')
        return `\\\\.\\pipe\\${PIPE_NAME}`;
    return join(posixRunRoot(env), 'mcp.sock');
};
const socketParentDir = (socketPath, platform = process.platform) => {
    if (platform === 'win32')
        return null;
    return dirname(socketPath);
};

const extensionIdFromOrigin = (origin) => {
    const stripped = origin
        .replace(/^chrome-extension:\/\//, '')
        .replace(/\/$/, '');
    if (stripped.length === 0 ||
        stripped.includes('/') ||
        stripped.includes(':')) {
        throw new Error(`nmh_mode: cannot derive extensionId from origin ${origin}`);
    }
    return stripped;
};
const runNmhMode = (input) => new Promise((resolve, reject) => {
    let extensionId;
    try {
        extensionId = extensionIdFromOrigin(input.origin);
    }
    catch (err) {
        reject(err);
        return;
    }
    const socketPath = defaultSocketPath();
    stderr.write(`[pwa-debug-host nmh] origin=${input.origin} extensionId=${extensionId} pid=${process.pid}\n`);
    const reader = createFrameReader();
    let settled = false;
    let client = null;
    const finish = (err) => {
        if (settled)
            return;
        settled = true;
        stdin.removeAllListeners('data');
        stdin.removeAllListeners('end');
        stdin.removeAllListeners('error');
        client?.close();
        if (err)
            reject(err);
        else
            resolve();
    };
    const onIpcEnvelope = (env) => {
        try {
            stdout.write(frameMessage(env));
        }
        catch (err) {
            finish(err);
        }
    };
    const onIpcClose = () => {
        stderr.write('[pwa-debug-host nmh] ipc closed; exiting\n');
        finish();
    };
    createIpcClient({
        socketPath,
        extensionId,
        onEnvelope: onIpcEnvelope,
        onClose: onIpcClose,
    })
        .then((c) => {
        client = c;
        stdin.on('data', (chunk) => {
            try {
                const arr = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                for (const raw of reader.push(arr)) {
                    const env = parseIpcEnvelope(raw);
                    const result = c.send(env);
                    if (!result.ok) {
                        finish(new Error(`nmh_mode: ipc send failed: ${result.error}`));
                        return;
                    }
                }
            }
            catch (err) {
                finish(err);
            }
        });
        stdin.once('end', () => {
            stderr.write('[pwa-debug-host nmh] stdin EOF\n');
            finish();
        });
        stdin.once('error', (err) => finish(err));
    })
        .catch((err) => {
        stderr.write(`[pwa-debug-host nmh] ipc connect failed: ${err.message}\n`);
        finish(err);
    });
});

var util;
(function (util) {
    util.assertEqual = (_) => { };
    function assertIs(_arg) { }
    util.assertIs = assertIs;
    function assertNever(_x) {
        throw new Error();
    }
    util.assertNever = assertNever;
    util.arrayToEnum = (items) => {
        const obj = {};
        for (const item of items) {
            obj[item] = item;
        }
        return obj;
    };
    util.getValidEnumValues = (obj) => {
        const validKeys = util.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
        const filtered = {};
        for (const k of validKeys) {
            filtered[k] = obj[k];
        }
        return util.objectValues(filtered);
    };
    util.objectValues = (obj) => {
        return util.objectKeys(obj).map(function (e) {
            return obj[e];
        });
    };
    util.objectKeys = typeof Object.keys === "function" // eslint-disable-line ban/ban
        ? (obj) => Object.keys(obj) // eslint-disable-line ban/ban
        : (object) => {
            const keys = [];
            for (const key in object) {
                if (Object.prototype.hasOwnProperty.call(object, key)) {
                    keys.push(key);
                }
            }
            return keys;
        };
    util.find = (arr, checker) => {
        for (const item of arr) {
            if (checker(item))
                return item;
        }
        return undefined;
    };
    util.isInteger = typeof Number.isInteger === "function"
        ? (val) => Number.isInteger(val) // eslint-disable-line ban/ban
        : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
    function joinValues(array, separator = " | ") {
        return array.map((val) => (typeof val === "string" ? `'${val}'` : val)).join(separator);
    }
    util.joinValues = joinValues;
    util.jsonStringifyReplacer = (_, value) => {
        if (typeof value === "bigint") {
            return value.toString();
        }
        return value;
    };
})(util || (util = {}));
var objectUtil;
(function (objectUtil) {
    objectUtil.mergeShapes = (first, second) => {
        return {
            ...first,
            ...second, // second overwrites first
        };
    };
})(objectUtil || (objectUtil = {}));
const ZodParsedType = util.arrayToEnum([
    "string",
    "nan",
    "number",
    "integer",
    "float",
    "boolean",
    "date",
    "bigint",
    "symbol",
    "function",
    "undefined",
    "null",
    "array",
    "object",
    "unknown",
    "promise",
    "void",
    "never",
    "map",
    "set",
]);
const getParsedType = (data) => {
    const t = typeof data;
    switch (t) {
        case "undefined":
            return ZodParsedType.undefined;
        case "string":
            return ZodParsedType.string;
        case "number":
            return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
        case "boolean":
            return ZodParsedType.boolean;
        case "function":
            return ZodParsedType.function;
        case "bigint":
            return ZodParsedType.bigint;
        case "symbol":
            return ZodParsedType.symbol;
        case "object":
            if (Array.isArray(data)) {
                return ZodParsedType.array;
            }
            if (data === null) {
                return ZodParsedType.null;
            }
            if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
                return ZodParsedType.promise;
            }
            if (typeof Map !== "undefined" && data instanceof Map) {
                return ZodParsedType.map;
            }
            if (typeof Set !== "undefined" && data instanceof Set) {
                return ZodParsedType.set;
            }
            if (typeof Date !== "undefined" && data instanceof Date) {
                return ZodParsedType.date;
            }
            return ZodParsedType.object;
        default:
            return ZodParsedType.unknown;
    }
};

const ZodIssueCode = util.arrayToEnum([
    "invalid_type",
    "invalid_literal",
    "custom",
    "invalid_union",
    "invalid_union_discriminator",
    "invalid_enum_value",
    "unrecognized_keys",
    "invalid_arguments",
    "invalid_return_type",
    "invalid_date",
    "invalid_string",
    "too_small",
    "too_big",
    "invalid_intersection_types",
    "not_multiple_of",
    "not_finite",
]);
class ZodError extends Error {
    get errors() {
        return this.issues;
    }
    constructor(issues) {
        super();
        this.issues = [];
        this.addIssue = (sub) => {
            this.issues = [...this.issues, sub];
        };
        this.addIssues = (subs = []) => {
            this.issues = [...this.issues, ...subs];
        };
        const actualProto = new.target.prototype;
        if (Object.setPrototypeOf) {
            // eslint-disable-next-line ban/ban
            Object.setPrototypeOf(this, actualProto);
        }
        else {
            this.__proto__ = actualProto;
        }
        this.name = "ZodError";
        this.issues = issues;
    }
    format(_mapper) {
        const mapper = _mapper ||
            function (issue) {
                return issue.message;
            };
        const fieldErrors = { _errors: [] };
        const processError = (error) => {
            for (const issue of error.issues) {
                if (issue.code === "invalid_union") {
                    issue.unionErrors.map(processError);
                }
                else if (issue.code === "invalid_return_type") {
                    processError(issue.returnTypeError);
                }
                else if (issue.code === "invalid_arguments") {
                    processError(issue.argumentsError);
                }
                else if (issue.path.length === 0) {
                    fieldErrors._errors.push(mapper(issue));
                }
                else {
                    let curr = fieldErrors;
                    let i = 0;
                    while (i < issue.path.length) {
                        const el = issue.path[i];
                        const terminal = i === issue.path.length - 1;
                        if (!terminal) {
                            curr[el] = curr[el] || { _errors: [] };
                            // if (typeof el === "string") {
                            //   curr[el] = curr[el] || { _errors: [] };
                            // } else if (typeof el === "number") {
                            //   const errorArray: any = [];
                            //   errorArray._errors = [];
                            //   curr[el] = curr[el] || errorArray;
                            // }
                        }
                        else {
                            curr[el] = curr[el] || { _errors: [] };
                            curr[el]._errors.push(mapper(issue));
                        }
                        curr = curr[el];
                        i++;
                    }
                }
            }
        };
        processError(this);
        return fieldErrors;
    }
    static assert(value) {
        if (!(value instanceof ZodError)) {
            throw new Error(`Not a ZodError: ${value}`);
        }
    }
    toString() {
        return this.message;
    }
    get message() {
        return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
    }
    get isEmpty() {
        return this.issues.length === 0;
    }
    flatten(mapper = (issue) => issue.message) {
        const fieldErrors = {};
        const formErrors = [];
        for (const sub of this.issues) {
            if (sub.path.length > 0) {
                const firstEl = sub.path[0];
                fieldErrors[firstEl] = fieldErrors[firstEl] || [];
                fieldErrors[firstEl].push(mapper(sub));
            }
            else {
                formErrors.push(mapper(sub));
            }
        }
        return { formErrors, fieldErrors };
    }
    get formErrors() {
        return this.flatten();
    }
}
ZodError.create = (issues) => {
    const error = new ZodError(issues);
    return error;
};

const errorMap = (issue, _ctx) => {
    let message;
    switch (issue.code) {
        case ZodIssueCode.invalid_type:
            if (issue.received === ZodParsedType.undefined) {
                message = "Required";
            }
            else {
                message = `Expected ${issue.expected}, received ${issue.received}`;
            }
            break;
        case ZodIssueCode.invalid_literal:
            message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
            break;
        case ZodIssueCode.unrecognized_keys:
            message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
            break;
        case ZodIssueCode.invalid_union:
            message = `Invalid input`;
            break;
        case ZodIssueCode.invalid_union_discriminator:
            message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
            break;
        case ZodIssueCode.invalid_enum_value:
            message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
            break;
        case ZodIssueCode.invalid_arguments:
            message = `Invalid function arguments`;
            break;
        case ZodIssueCode.invalid_return_type:
            message = `Invalid function return type`;
            break;
        case ZodIssueCode.invalid_date:
            message = `Invalid date`;
            break;
        case ZodIssueCode.invalid_string:
            if (typeof issue.validation === "object") {
                if ("includes" in issue.validation) {
                    message = `Invalid input: must include "${issue.validation.includes}"`;
                    if (typeof issue.validation.position === "number") {
                        message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
                    }
                }
                else if ("startsWith" in issue.validation) {
                    message = `Invalid input: must start with "${issue.validation.startsWith}"`;
                }
                else if ("endsWith" in issue.validation) {
                    message = `Invalid input: must end with "${issue.validation.endsWith}"`;
                }
                else {
                    util.assertNever(issue.validation);
                }
            }
            else if (issue.validation !== "regex") {
                message = `Invalid ${issue.validation}`;
            }
            else {
                message = "Invalid";
            }
            break;
        case ZodIssueCode.too_small:
            if (issue.type === "array")
                message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
            else if (issue.type === "string")
                message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
            else if (issue.type === "number")
                message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
            else if (issue.type === "bigint")
                message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
            else if (issue.type === "date")
                message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
            else
                message = "Invalid input";
            break;
        case ZodIssueCode.too_big:
            if (issue.type === "array")
                message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
            else if (issue.type === "string")
                message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
            else if (issue.type === "number")
                message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
            else if (issue.type === "bigint")
                message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
            else if (issue.type === "date")
                message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
            else
                message = "Invalid input";
            break;
        case ZodIssueCode.custom:
            message = `Invalid input`;
            break;
        case ZodIssueCode.invalid_intersection_types:
            message = `Intersection results could not be merged`;
            break;
        case ZodIssueCode.not_multiple_of:
            message = `Number must be a multiple of ${issue.multipleOf}`;
            break;
        case ZodIssueCode.not_finite:
            message = "Number must be finite";
            break;
        default:
            message = _ctx.defaultError;
            util.assertNever(issue);
    }
    return { message };
};

let overrideErrorMap = errorMap;
function getErrorMap() {
    return overrideErrorMap;
}

const makeIssue = (params) => {
    const { data, path, errorMaps, issueData } = params;
    const fullPath = [...path, ...(issueData.path || [])];
    const fullIssue = {
        ...issueData,
        path: fullPath,
    };
    if (issueData.message !== undefined) {
        return {
            ...issueData,
            path: fullPath,
            message: issueData.message,
        };
    }
    let errorMessage = "";
    const maps = errorMaps
        .filter((m) => !!m)
        .slice()
        .reverse();
    for (const map of maps) {
        errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
    }
    return {
        ...issueData,
        path: fullPath,
        message: errorMessage,
    };
};
function addIssueToContext(ctx, issueData) {
    const overrideMap = getErrorMap();
    const issue = makeIssue({
        issueData: issueData,
        data: ctx.data,
        path: ctx.path,
        errorMaps: [
            ctx.common.contextualErrorMap, // contextual error map is first priority
            ctx.schemaErrorMap, // then schema-bound map if available
            overrideMap, // then global override map
            overrideMap === errorMap ? undefined : errorMap, // then global default map
        ].filter((x) => !!x),
    });
    ctx.common.issues.push(issue);
}
class ParseStatus {
    constructor() {
        this.value = "valid";
    }
    dirty() {
        if (this.value === "valid")
            this.value = "dirty";
    }
    abort() {
        if (this.value !== "aborted")
            this.value = "aborted";
    }
    static mergeArray(status, results) {
        const arrayValue = [];
        for (const s of results) {
            if (s.status === "aborted")
                return INVALID;
            if (s.status === "dirty")
                status.dirty();
            arrayValue.push(s.value);
        }
        return { status: status.value, value: arrayValue };
    }
    static async mergeObjectAsync(status, pairs) {
        const syncPairs = [];
        for (const pair of pairs) {
            const key = await pair.key;
            const value = await pair.value;
            syncPairs.push({
                key,
                value,
            });
        }
        return ParseStatus.mergeObjectSync(status, syncPairs);
    }
    static mergeObjectSync(status, pairs) {
        const finalObject = {};
        for (const pair of pairs) {
            const { key, value } = pair;
            if (key.status === "aborted")
                return INVALID;
            if (value.status === "aborted")
                return INVALID;
            if (key.status === "dirty")
                status.dirty();
            if (value.status === "dirty")
                status.dirty();
            if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
                finalObject[key.value] = value.value;
            }
        }
        return { status: status.value, value: finalObject };
    }
}
const INVALID = Object.freeze({
    status: "aborted",
});
const DIRTY = (value) => ({ status: "dirty", value });
const OK = (value) => ({ status: "valid", value });
const isAborted = (x) => x.status === "aborted";
const isDirty = (x) => x.status === "dirty";
const isValid = (x) => x.status === "valid";
const isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

var errorUtil;
(function (errorUtil) {
    errorUtil.errToObj = (message) => typeof message === "string" ? { message } : message || {};
    // biome-ignore lint:
    errorUtil.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

class ParseInputLazyPath {
    constructor(parent, value, path, key) {
        this._cachedPath = [];
        this.parent = parent;
        this.data = value;
        this._path = path;
        this._key = key;
    }
    get path() {
        if (!this._cachedPath.length) {
            if (Array.isArray(this._key)) {
                this._cachedPath.push(...this._path, ...this._key);
            }
            else {
                this._cachedPath.push(...this._path, this._key);
            }
        }
        return this._cachedPath;
    }
}
const handleResult = (ctx, result) => {
    if (isValid(result)) {
        return { success: true, data: result.value };
    }
    else {
        if (!ctx.common.issues.length) {
            throw new Error("Validation failed but no issues detected.");
        }
        return {
            success: false,
            get error() {
                if (this._error)
                    return this._error;
                const error = new ZodError(ctx.common.issues);
                this._error = error;
                return this._error;
            },
        };
    }
};
function processCreateParams(params) {
    if (!params)
        return {};
    const { errorMap, invalid_type_error, required_error, description } = params;
    if (errorMap && (invalid_type_error || required_error)) {
        throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
    }
    if (errorMap)
        return { errorMap: errorMap, description };
    const customMap = (iss, ctx) => {
        const { message } = params;
        if (iss.code === "invalid_enum_value") {
            return { message: message ?? ctx.defaultError };
        }
        if (typeof ctx.data === "undefined") {
            return { message: message ?? required_error ?? ctx.defaultError };
        }
        if (iss.code !== "invalid_type")
            return { message: ctx.defaultError };
        return { message: message ?? invalid_type_error ?? ctx.defaultError };
    };
    return { errorMap: customMap, description };
}
class ZodType {
    get description() {
        return this._def.description;
    }
    _getType(input) {
        return getParsedType(input.data);
    }
    _getOrReturnCtx(input, ctx) {
        return (ctx || {
            common: input.parent.common,
            data: input.data,
            parsedType: getParsedType(input.data),
            schemaErrorMap: this._def.errorMap,
            path: input.path,
            parent: input.parent,
        });
    }
    _processInputParams(input) {
        return {
            status: new ParseStatus(),
            ctx: {
                common: input.parent.common,
                data: input.data,
                parsedType: getParsedType(input.data),
                schemaErrorMap: this._def.errorMap,
                path: input.path,
                parent: input.parent,
            },
        };
    }
    _parseSync(input) {
        const result = this._parse(input);
        if (isAsync(result)) {
            throw new Error("Synchronous parse encountered promise.");
        }
        return result;
    }
    _parseAsync(input) {
        const result = this._parse(input);
        return Promise.resolve(result);
    }
    parse(data, params) {
        const result = this.safeParse(data, params);
        if (result.success)
            return result.data;
        throw result.error;
    }
    safeParse(data, params) {
        const ctx = {
            common: {
                issues: [],
                async: params?.async ?? false,
                contextualErrorMap: params?.errorMap,
            },
            path: params?.path || [],
            schemaErrorMap: this._def.errorMap,
            parent: null,
            data,
            parsedType: getParsedType(data),
        };
        const result = this._parseSync({ data, path: ctx.path, parent: ctx });
        return handleResult(ctx, result);
    }
    "~validate"(data) {
        const ctx = {
            common: {
                issues: [],
                async: !!this["~standard"].async,
            },
            path: [],
            schemaErrorMap: this._def.errorMap,
            parent: null,
            data,
            parsedType: getParsedType(data),
        };
        if (!this["~standard"].async) {
            try {
                const result = this._parseSync({ data, path: [], parent: ctx });
                return isValid(result)
                    ? {
                        value: result.value,
                    }
                    : {
                        issues: ctx.common.issues,
                    };
            }
            catch (err) {
                if (err?.message?.toLowerCase()?.includes("encountered")) {
                    this["~standard"].async = true;
                }
                ctx.common = {
                    issues: [],
                    async: true,
                };
            }
        }
        return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result)
            ? {
                value: result.value,
            }
            : {
                issues: ctx.common.issues,
            });
    }
    async parseAsync(data, params) {
        const result = await this.safeParseAsync(data, params);
        if (result.success)
            return result.data;
        throw result.error;
    }
    async safeParseAsync(data, params) {
        const ctx = {
            common: {
                issues: [],
                contextualErrorMap: params?.errorMap,
                async: true,
            },
            path: params?.path || [],
            schemaErrorMap: this._def.errorMap,
            parent: null,
            data,
            parsedType: getParsedType(data),
        };
        const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
        const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
        return handleResult(ctx, result);
    }
    refine(check, message) {
        const getIssueProperties = (val) => {
            if (typeof message === "string" || typeof message === "undefined") {
                return { message };
            }
            else if (typeof message === "function") {
                return message(val);
            }
            else {
                return message;
            }
        };
        return this._refinement((val, ctx) => {
            const result = check(val);
            const setError = () => ctx.addIssue({
                code: ZodIssueCode.custom,
                ...getIssueProperties(val),
            });
            if (typeof Promise !== "undefined" && result instanceof Promise) {
                return result.then((data) => {
                    if (!data) {
                        setError();
                        return false;
                    }
                    else {
                        return true;
                    }
                });
            }
            if (!result) {
                setError();
                return false;
            }
            else {
                return true;
            }
        });
    }
    refinement(check, refinementData) {
        return this._refinement((val, ctx) => {
            if (!check(val)) {
                ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
                return false;
            }
            else {
                return true;
            }
        });
    }
    _refinement(refinement) {
        return new ZodEffects({
            schema: this,
            typeName: ZodFirstPartyTypeKind.ZodEffects,
            effect: { type: "refinement", refinement },
        });
    }
    superRefine(refinement) {
        return this._refinement(refinement);
    }
    constructor(def) {
        /** Alias of safeParseAsync */
        this.spa = this.safeParseAsync;
        this._def = def;
        this.parse = this.parse.bind(this);
        this.safeParse = this.safeParse.bind(this);
        this.parseAsync = this.parseAsync.bind(this);
        this.safeParseAsync = this.safeParseAsync.bind(this);
        this.spa = this.spa.bind(this);
        this.refine = this.refine.bind(this);
        this.refinement = this.refinement.bind(this);
        this.superRefine = this.superRefine.bind(this);
        this.optional = this.optional.bind(this);
        this.nullable = this.nullable.bind(this);
        this.nullish = this.nullish.bind(this);
        this.array = this.array.bind(this);
        this.promise = this.promise.bind(this);
        this.or = this.or.bind(this);
        this.and = this.and.bind(this);
        this.transform = this.transform.bind(this);
        this.brand = this.brand.bind(this);
        this.default = this.default.bind(this);
        this.catch = this.catch.bind(this);
        this.describe = this.describe.bind(this);
        this.pipe = this.pipe.bind(this);
        this.readonly = this.readonly.bind(this);
        this.isNullable = this.isNullable.bind(this);
        this.isOptional = this.isOptional.bind(this);
        this["~standard"] = {
            version: 1,
            vendor: "zod",
            validate: (data) => this["~validate"](data),
        };
    }
    optional() {
        return ZodOptional.create(this, this._def);
    }
    nullable() {
        return ZodNullable.create(this, this._def);
    }
    nullish() {
        return this.nullable().optional();
    }
    array() {
        return ZodArray.create(this);
    }
    promise() {
        return ZodPromise.create(this, this._def);
    }
    or(option) {
        return ZodUnion.create([this, option], this._def);
    }
    and(incoming) {
        return ZodIntersection.create(this, incoming, this._def);
    }
    transform(transform) {
        return new ZodEffects({
            ...processCreateParams(this._def),
            schema: this,
            typeName: ZodFirstPartyTypeKind.ZodEffects,
            effect: { type: "transform", transform },
        });
    }
    default(def) {
        const defaultValueFunc = typeof def === "function" ? def : () => def;
        return new ZodDefault({
            ...processCreateParams(this._def),
            innerType: this,
            defaultValue: defaultValueFunc,
            typeName: ZodFirstPartyTypeKind.ZodDefault,
        });
    }
    brand() {
        return new ZodBranded({
            typeName: ZodFirstPartyTypeKind.ZodBranded,
            type: this,
            ...processCreateParams(this._def),
        });
    }
    catch(def) {
        const catchValueFunc = typeof def === "function" ? def : () => def;
        return new ZodCatch({
            ...processCreateParams(this._def),
            innerType: this,
            catchValue: catchValueFunc,
            typeName: ZodFirstPartyTypeKind.ZodCatch,
        });
    }
    describe(description) {
        const This = this.constructor;
        return new This({
            ...this._def,
            description,
        });
    }
    pipe(target) {
        return ZodPipeline.create(this, target);
    }
    readonly() {
        return ZodReadonly.create(this);
    }
    isOptional() {
        return this.safeParse(undefined).success;
    }
    isNullable() {
        return this.safeParse(null).success;
    }
}
const cuidRegex = /^c[^\s-]{8,}$/i;
const cuid2Regex = /^[0-9a-z]+$/;
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
// const uuidRegex =
//   /^([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000)$/i;
const uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
const nanoidRegex = /^[a-z0-9_-]{21}$/i;
const jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
const durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
// from https://stackoverflow.com/a/46181/1550155
// old version: too slow, didn't support unicode
// const emailRegex = /^((([a-z]|\d|[!#\$%&'\*\+\-\/=\?\^_`{\|}~]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])+(\.([a-z]|\d|[!#\$%&'\*\+\-\/=\?\^_`{\|}~]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])+)*)|((\x22)((((\x20|\x09)*(\x0d\x0a))?(\x20|\x09)+)?(([\x01-\x08\x0b\x0c\x0e-\x1f\x7f]|\x21|[\x23-\x5b]|[\x5d-\x7e]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(\\([\x01-\x09\x0b\x0c\x0d-\x7f]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]))))*(((\x20|\x09)*(\x0d\x0a))?(\x20|\x09)+)?(\x22)))@((([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.)+(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))$/i;
//old email regex
// const emailRegex = /^(([^<>()[\].,;:\s@"]+(\.[^<>()[\].,;:\s@"]+)*)|(".+"))@((?!-)([^<>()[\].,;:\s@"]+\.)+[^<>()[\].,;:\s@"]{1,})[^-<>()[\].,;:\s@"]$/i;
// eslint-disable-next-line
// const emailRegex =
//   /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\])|(\[IPv6:(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))\])|([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])*(\.[A-Za-z]{2,})+))$/;
// const emailRegex =
//   /^[a-zA-Z0-9\.\!\#\$\%\&\'\*\+\/\=\?\^\_\`\{\|\}\~\-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
// const emailRegex =
//   /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])$/i;
const emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
// const emailRegex =
//   /^[a-z0-9.!#$%&’*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9\-]+)*$/i;
// from https://thekevinscott.com/emojis-in-javascript/#writing-a-regular-expression
const _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
let emojiRegex;
// faster, simpler, safer
const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
// const ipv6Regex =
// /^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/;
const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
const ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
// https://stackoverflow.com/questions/7860392/determine-if-string-is-in-base64-using-javascript
const base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
// https://base64.guru/standards/base64url
const base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
// simple
// const dateRegexSource = `\\d{4}-\\d{2}-\\d{2}`;
// no leap year validation
// const dateRegexSource = `\\d{4}-((0[13578]|10|12)-31|(0[13-9]|1[0-2])-30|(0[1-9]|1[0-2])-(0[1-9]|1\\d|2\\d))`;
// with leap year validation
const dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
const dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
    let secondsRegexSource = `[0-5]\\d`;
    if (args.precision) {
        secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
    }
    else if (args.precision == null) {
        secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
    }
    const secondsQuantifier = args.precision ? "+" : "?"; // require seconds if precision is nonzero
    return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
    return new RegExp(`^${timeRegexSource(args)}$`);
}
// Adapted from https://stackoverflow.com/a/3143231
function datetimeRegex(args) {
    let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
    const opts = [];
    opts.push(args.local ? `Z?` : `Z`);
    if (args.offset)
        opts.push(`([+-]\\d{2}:?\\d{2})`);
    regex = `${regex}(${opts.join("|")})`;
    return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
    if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
        return true;
    }
    if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
        return true;
    }
    return false;
}
function isValidJWT(jwt, alg) {
    if (!jwtRegex.test(jwt))
        return false;
    try {
        const [header] = jwt.split(".");
        if (!header)
            return false;
        // Convert base64url to base64
        const base64 = header
            .replace(/-/g, "+")
            .replace(/_/g, "/")
            .padEnd(header.length + ((4 - (header.length % 4)) % 4), "=");
        const decoded = JSON.parse(atob(base64));
        if (typeof decoded !== "object" || decoded === null)
            return false;
        if ("typ" in decoded && decoded?.typ !== "JWT")
            return false;
        if (!decoded.alg)
            return false;
        if (alg && decoded.alg !== alg)
            return false;
        return true;
    }
    catch {
        return false;
    }
}
function isValidCidr(ip, version) {
    if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
        return true;
    }
    if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
        return true;
    }
    return false;
}
class ZodString extends ZodType {
    _parse(input) {
        if (this._def.coerce) {
            input.data = String(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.string) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.string,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const status = new ParseStatus();
        let ctx = undefined;
        for (const check of this._def.checks) {
            if (check.kind === "min") {
                if (input.data.length < check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_small,
                        minimum: check.value,
                        type: "string",
                        inclusive: true,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                if (input.data.length > check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_big,
                        maximum: check.value,
                        type: "string",
                        inclusive: true,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "length") {
                const tooBig = input.data.length > check.value;
                const tooSmall = input.data.length < check.value;
                if (tooBig || tooSmall) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    if (tooBig) {
                        addIssueToContext(ctx, {
                            code: ZodIssueCode.too_big,
                            maximum: check.value,
                            type: "string",
                            inclusive: true,
                            exact: true,
                            message: check.message,
                        });
                    }
                    else if (tooSmall) {
                        addIssueToContext(ctx, {
                            code: ZodIssueCode.too_small,
                            minimum: check.value,
                            type: "string",
                            inclusive: true,
                            exact: true,
                            message: check.message,
                        });
                    }
                    status.dirty();
                }
            }
            else if (check.kind === "email") {
                if (!emailRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "email",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "emoji") {
                if (!emojiRegex) {
                    emojiRegex = new RegExp(_emojiRegex, "u");
                }
                if (!emojiRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "emoji",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "uuid") {
                if (!uuidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "uuid",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "nanoid") {
                if (!nanoidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "nanoid",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "cuid") {
                if (!cuidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "cuid",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "cuid2") {
                if (!cuid2Regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "cuid2",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "ulid") {
                if (!ulidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "ulid",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "url") {
                try {
                    new URL(input.data);
                }
                catch {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "url",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "regex") {
                check.regex.lastIndex = 0;
                const testResult = check.regex.test(input.data);
                if (!testResult) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "regex",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "trim") {
                input.data = input.data.trim();
            }
            else if (check.kind === "includes") {
                if (!input.data.includes(check.value, check.position)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: { includes: check.value, position: check.position },
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "toLowerCase") {
                input.data = input.data.toLowerCase();
            }
            else if (check.kind === "toUpperCase") {
                input.data = input.data.toUpperCase();
            }
            else if (check.kind === "startsWith") {
                if (!input.data.startsWith(check.value)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: { startsWith: check.value },
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "endsWith") {
                if (!input.data.endsWith(check.value)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: { endsWith: check.value },
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "datetime") {
                const regex = datetimeRegex(check);
                if (!regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: "datetime",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "date") {
                const regex = dateRegex;
                if (!regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: "date",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "time") {
                const regex = timeRegex(check);
                if (!regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: "time",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "duration") {
                if (!durationRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "duration",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "ip") {
                if (!isValidIP(input.data, check.version)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "ip",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "jwt") {
                if (!isValidJWT(input.data, check.alg)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "jwt",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "cidr") {
                if (!isValidCidr(input.data, check.version)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "cidr",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "base64") {
                if (!base64Regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "base64",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "base64url") {
                if (!base64urlRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "base64url",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else {
                util.assertNever(check);
            }
        }
        return { status: status.value, value: input.data };
    }
    _regex(regex, validation, message) {
        return this.refinement((data) => regex.test(data), {
            validation,
            code: ZodIssueCode.invalid_string,
            ...errorUtil.errToObj(message),
        });
    }
    _addCheck(check) {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    email(message) {
        return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
    }
    url(message) {
        return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
    }
    emoji(message) {
        return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
    }
    uuid(message) {
        return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
    }
    nanoid(message) {
        return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
    }
    cuid(message) {
        return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
    }
    cuid2(message) {
        return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
    }
    ulid(message) {
        return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
    }
    base64(message) {
        return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
    }
    base64url(message) {
        // base64url encoding is a modification of base64 that can safely be used in URLs and filenames
        return this._addCheck({
            kind: "base64url",
            ...errorUtil.errToObj(message),
        });
    }
    jwt(options) {
        return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
    }
    ip(options) {
        return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
    }
    cidr(options) {
        return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
    }
    datetime(options) {
        if (typeof options === "string") {
            return this._addCheck({
                kind: "datetime",
                precision: null,
                offset: false,
                local: false,
                message: options,
            });
        }
        return this._addCheck({
            kind: "datetime",
            precision: typeof options?.precision === "undefined" ? null : options?.precision,
            offset: options?.offset ?? false,
            local: options?.local ?? false,
            ...errorUtil.errToObj(options?.message),
        });
    }
    date(message) {
        return this._addCheck({ kind: "date", message });
    }
    time(options) {
        if (typeof options === "string") {
            return this._addCheck({
                kind: "time",
                precision: null,
                message: options,
            });
        }
        return this._addCheck({
            kind: "time",
            precision: typeof options?.precision === "undefined" ? null : options?.precision,
            ...errorUtil.errToObj(options?.message),
        });
    }
    duration(message) {
        return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
    }
    regex(regex, message) {
        return this._addCheck({
            kind: "regex",
            regex: regex,
            ...errorUtil.errToObj(message),
        });
    }
    includes(value, options) {
        return this._addCheck({
            kind: "includes",
            value: value,
            position: options?.position,
            ...errorUtil.errToObj(options?.message),
        });
    }
    startsWith(value, message) {
        return this._addCheck({
            kind: "startsWith",
            value: value,
            ...errorUtil.errToObj(message),
        });
    }
    endsWith(value, message) {
        return this._addCheck({
            kind: "endsWith",
            value: value,
            ...errorUtil.errToObj(message),
        });
    }
    min(minLength, message) {
        return this._addCheck({
            kind: "min",
            value: minLength,
            ...errorUtil.errToObj(message),
        });
    }
    max(maxLength, message) {
        return this._addCheck({
            kind: "max",
            value: maxLength,
            ...errorUtil.errToObj(message),
        });
    }
    length(len, message) {
        return this._addCheck({
            kind: "length",
            value: len,
            ...errorUtil.errToObj(message),
        });
    }
    /**
     * Equivalent to `.min(1)`
     */
    nonempty(message) {
        return this.min(1, errorUtil.errToObj(message));
    }
    trim() {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, { kind: "trim" }],
        });
    }
    toLowerCase() {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, { kind: "toLowerCase" }],
        });
    }
    toUpperCase() {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, { kind: "toUpperCase" }],
        });
    }
    get isDatetime() {
        return !!this._def.checks.find((ch) => ch.kind === "datetime");
    }
    get isDate() {
        return !!this._def.checks.find((ch) => ch.kind === "date");
    }
    get isTime() {
        return !!this._def.checks.find((ch) => ch.kind === "time");
    }
    get isDuration() {
        return !!this._def.checks.find((ch) => ch.kind === "duration");
    }
    get isEmail() {
        return !!this._def.checks.find((ch) => ch.kind === "email");
    }
    get isURL() {
        return !!this._def.checks.find((ch) => ch.kind === "url");
    }
    get isEmoji() {
        return !!this._def.checks.find((ch) => ch.kind === "emoji");
    }
    get isUUID() {
        return !!this._def.checks.find((ch) => ch.kind === "uuid");
    }
    get isNANOID() {
        return !!this._def.checks.find((ch) => ch.kind === "nanoid");
    }
    get isCUID() {
        return !!this._def.checks.find((ch) => ch.kind === "cuid");
    }
    get isCUID2() {
        return !!this._def.checks.find((ch) => ch.kind === "cuid2");
    }
    get isULID() {
        return !!this._def.checks.find((ch) => ch.kind === "ulid");
    }
    get isIP() {
        return !!this._def.checks.find((ch) => ch.kind === "ip");
    }
    get isCIDR() {
        return !!this._def.checks.find((ch) => ch.kind === "cidr");
    }
    get isBase64() {
        return !!this._def.checks.find((ch) => ch.kind === "base64");
    }
    get isBase64url() {
        // base64url encoding is a modification of base64 that can safely be used in URLs and filenames
        return !!this._def.checks.find((ch) => ch.kind === "base64url");
    }
    get minLength() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min;
    }
    get maxLength() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max;
    }
}
ZodString.create = (params) => {
    return new ZodString({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodString,
        coerce: params?.coerce ?? false,
        ...processCreateParams(params),
    });
};
// https://stackoverflow.com/questions/3966484/why-does-modulus-operator-return-fractional-number-in-javascript/31711034#31711034
function floatSafeRemainder(val, step) {
    const valDecCount = (val.toString().split(".")[1] || "").length;
    const stepDecCount = (step.toString().split(".")[1] || "").length;
    const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
    const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
    const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
    return (valInt % stepInt) / 10 ** decCount;
}
class ZodNumber extends ZodType {
    constructor() {
        super(...arguments);
        this.min = this.gte;
        this.max = this.lte;
        this.step = this.multipleOf;
    }
    _parse(input) {
        if (this._def.coerce) {
            input.data = Number(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.number) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.number,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        let ctx = undefined;
        const status = new ParseStatus();
        for (const check of this._def.checks) {
            if (check.kind === "int") {
                if (!util.isInteger(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_type,
                        expected: "integer",
                        received: "float",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "min") {
                const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
                if (tooSmall) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_small,
                        minimum: check.value,
                        type: "number",
                        inclusive: check.inclusive,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
                if (tooBig) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_big,
                        maximum: check.value,
                        type: "number",
                        inclusive: check.inclusive,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "multipleOf") {
                if (floatSafeRemainder(input.data, check.value) !== 0) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.not_multiple_of,
                        multipleOf: check.value,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "finite") {
                if (!Number.isFinite(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.not_finite,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else {
                util.assertNever(check);
            }
        }
        return { status: status.value, value: input.data };
    }
    gte(value, message) {
        return this.setLimit("min", value, true, errorUtil.toString(message));
    }
    gt(value, message) {
        return this.setLimit("min", value, false, errorUtil.toString(message));
    }
    lte(value, message) {
        return this.setLimit("max", value, true, errorUtil.toString(message));
    }
    lt(value, message) {
        return this.setLimit("max", value, false, errorUtil.toString(message));
    }
    setLimit(kind, value, inclusive, message) {
        return new ZodNumber({
            ...this._def,
            checks: [
                ...this._def.checks,
                {
                    kind,
                    value,
                    inclusive,
                    message: errorUtil.toString(message),
                },
            ],
        });
    }
    _addCheck(check) {
        return new ZodNumber({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    int(message) {
        return this._addCheck({
            kind: "int",
            message: errorUtil.toString(message),
        });
    }
    positive(message) {
        return this._addCheck({
            kind: "min",
            value: 0,
            inclusive: false,
            message: errorUtil.toString(message),
        });
    }
    negative(message) {
        return this._addCheck({
            kind: "max",
            value: 0,
            inclusive: false,
            message: errorUtil.toString(message),
        });
    }
    nonpositive(message) {
        return this._addCheck({
            kind: "max",
            value: 0,
            inclusive: true,
            message: errorUtil.toString(message),
        });
    }
    nonnegative(message) {
        return this._addCheck({
            kind: "min",
            value: 0,
            inclusive: true,
            message: errorUtil.toString(message),
        });
    }
    multipleOf(value, message) {
        return this._addCheck({
            kind: "multipleOf",
            value: value,
            message: errorUtil.toString(message),
        });
    }
    finite(message) {
        return this._addCheck({
            kind: "finite",
            message: errorUtil.toString(message),
        });
    }
    safe(message) {
        return this._addCheck({
            kind: "min",
            inclusive: true,
            value: Number.MIN_SAFE_INTEGER,
            message: errorUtil.toString(message),
        })._addCheck({
            kind: "max",
            inclusive: true,
            value: Number.MAX_SAFE_INTEGER,
            message: errorUtil.toString(message),
        });
    }
    get minValue() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min;
    }
    get maxValue() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max;
    }
    get isInt() {
        return !!this._def.checks.find((ch) => ch.kind === "int" || (ch.kind === "multipleOf" && util.isInteger(ch.value)));
    }
    get isFinite() {
        let max = null;
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
                return true;
            }
            else if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
            else if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return Number.isFinite(min) && Number.isFinite(max);
    }
}
ZodNumber.create = (params) => {
    return new ZodNumber({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodNumber,
        coerce: params?.coerce || false,
        ...processCreateParams(params),
    });
};
class ZodBigInt extends ZodType {
    constructor() {
        super(...arguments);
        this.min = this.gte;
        this.max = this.lte;
    }
    _parse(input) {
        if (this._def.coerce) {
            try {
                input.data = BigInt(input.data);
            }
            catch {
                return this._getInvalidInput(input);
            }
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.bigint) {
            return this._getInvalidInput(input);
        }
        let ctx = undefined;
        const status = new ParseStatus();
        for (const check of this._def.checks) {
            if (check.kind === "min") {
                const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
                if (tooSmall) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_small,
                        type: "bigint",
                        minimum: check.value,
                        inclusive: check.inclusive,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
                if (tooBig) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_big,
                        type: "bigint",
                        maximum: check.value,
                        inclusive: check.inclusive,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "multipleOf") {
                if (input.data % check.value !== BigInt(0)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.not_multiple_of,
                        multipleOf: check.value,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else {
                util.assertNever(check);
            }
        }
        return { status: status.value, value: input.data };
    }
    _getInvalidInput(input) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.bigint,
            received: ctx.parsedType,
        });
        return INVALID;
    }
    gte(value, message) {
        return this.setLimit("min", value, true, errorUtil.toString(message));
    }
    gt(value, message) {
        return this.setLimit("min", value, false, errorUtil.toString(message));
    }
    lte(value, message) {
        return this.setLimit("max", value, true, errorUtil.toString(message));
    }
    lt(value, message) {
        return this.setLimit("max", value, false, errorUtil.toString(message));
    }
    setLimit(kind, value, inclusive, message) {
        return new ZodBigInt({
            ...this._def,
            checks: [
                ...this._def.checks,
                {
                    kind,
                    value,
                    inclusive,
                    message: errorUtil.toString(message),
                },
            ],
        });
    }
    _addCheck(check) {
        return new ZodBigInt({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    positive(message) {
        return this._addCheck({
            kind: "min",
            value: BigInt(0),
            inclusive: false,
            message: errorUtil.toString(message),
        });
    }
    negative(message) {
        return this._addCheck({
            kind: "max",
            value: BigInt(0),
            inclusive: false,
            message: errorUtil.toString(message),
        });
    }
    nonpositive(message) {
        return this._addCheck({
            kind: "max",
            value: BigInt(0),
            inclusive: true,
            message: errorUtil.toString(message),
        });
    }
    nonnegative(message) {
        return this._addCheck({
            kind: "min",
            value: BigInt(0),
            inclusive: true,
            message: errorUtil.toString(message),
        });
    }
    multipleOf(value, message) {
        return this._addCheck({
            kind: "multipleOf",
            value,
            message: errorUtil.toString(message),
        });
    }
    get minValue() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min;
    }
    get maxValue() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max;
    }
}
ZodBigInt.create = (params) => {
    return new ZodBigInt({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodBigInt,
        coerce: params?.coerce ?? false,
        ...processCreateParams(params),
    });
};
class ZodBoolean extends ZodType {
    _parse(input) {
        if (this._def.coerce) {
            input.data = Boolean(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.boolean) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.boolean,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodBoolean.create = (params) => {
    return new ZodBoolean({
        typeName: ZodFirstPartyTypeKind.ZodBoolean,
        coerce: params?.coerce || false,
        ...processCreateParams(params),
    });
};
class ZodDate extends ZodType {
    _parse(input) {
        if (this._def.coerce) {
            input.data = new Date(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.date) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.date,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        if (Number.isNaN(input.data.getTime())) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_date,
            });
            return INVALID;
        }
        const status = new ParseStatus();
        let ctx = undefined;
        for (const check of this._def.checks) {
            if (check.kind === "min") {
                if (input.data.getTime() < check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_small,
                        message: check.message,
                        inclusive: true,
                        exact: false,
                        minimum: check.value,
                        type: "date",
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                if (input.data.getTime() > check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_big,
                        message: check.message,
                        inclusive: true,
                        exact: false,
                        maximum: check.value,
                        type: "date",
                    });
                    status.dirty();
                }
            }
            else {
                util.assertNever(check);
            }
        }
        return {
            status: status.value,
            value: new Date(input.data.getTime()),
        };
    }
    _addCheck(check) {
        return new ZodDate({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    min(minDate, message) {
        return this._addCheck({
            kind: "min",
            value: minDate.getTime(),
            message: errorUtil.toString(message),
        });
    }
    max(maxDate, message) {
        return this._addCheck({
            kind: "max",
            value: maxDate.getTime(),
            message: errorUtil.toString(message),
        });
    }
    get minDate() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min != null ? new Date(min) : null;
    }
    get maxDate() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max != null ? new Date(max) : null;
    }
}
ZodDate.create = (params) => {
    return new ZodDate({
        checks: [],
        coerce: params?.coerce || false,
        typeName: ZodFirstPartyTypeKind.ZodDate,
        ...processCreateParams(params),
    });
};
class ZodSymbol extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.symbol) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.symbol,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodSymbol.create = (params) => {
    return new ZodSymbol({
        typeName: ZodFirstPartyTypeKind.ZodSymbol,
        ...processCreateParams(params),
    });
};
class ZodUndefined extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.undefined) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.undefined,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodUndefined.create = (params) => {
    return new ZodUndefined({
        typeName: ZodFirstPartyTypeKind.ZodUndefined,
        ...processCreateParams(params),
    });
};
class ZodNull extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.null) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.null,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodNull.create = (params) => {
    return new ZodNull({
        typeName: ZodFirstPartyTypeKind.ZodNull,
        ...processCreateParams(params),
    });
};
class ZodAny extends ZodType {
    constructor() {
        super(...arguments);
        // to prevent instances of other classes from extending ZodAny. this causes issues with catchall in ZodObject.
        this._any = true;
    }
    _parse(input) {
        return OK(input.data);
    }
}
ZodAny.create = (params) => {
    return new ZodAny({
        typeName: ZodFirstPartyTypeKind.ZodAny,
        ...processCreateParams(params),
    });
};
class ZodUnknown extends ZodType {
    constructor() {
        super(...arguments);
        // required
        this._unknown = true;
    }
    _parse(input) {
        return OK(input.data);
    }
}
ZodUnknown.create = (params) => {
    return new ZodUnknown({
        typeName: ZodFirstPartyTypeKind.ZodUnknown,
        ...processCreateParams(params),
    });
};
class ZodNever extends ZodType {
    _parse(input) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.never,
            received: ctx.parsedType,
        });
        return INVALID;
    }
}
ZodNever.create = (params) => {
    return new ZodNever({
        typeName: ZodFirstPartyTypeKind.ZodNever,
        ...processCreateParams(params),
    });
};
class ZodVoid extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.undefined) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.void,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodVoid.create = (params) => {
    return new ZodVoid({
        typeName: ZodFirstPartyTypeKind.ZodVoid,
        ...processCreateParams(params),
    });
};
class ZodArray extends ZodType {
    _parse(input) {
        const { ctx, status } = this._processInputParams(input);
        const def = this._def;
        if (ctx.parsedType !== ZodParsedType.array) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.array,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        if (def.exactLength !== null) {
            const tooBig = ctx.data.length > def.exactLength.value;
            const tooSmall = ctx.data.length < def.exactLength.value;
            if (tooBig || tooSmall) {
                addIssueToContext(ctx, {
                    code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
                    minimum: (tooSmall ? def.exactLength.value : undefined),
                    maximum: (tooBig ? def.exactLength.value : undefined),
                    type: "array",
                    inclusive: true,
                    exact: true,
                    message: def.exactLength.message,
                });
                status.dirty();
            }
        }
        if (def.minLength !== null) {
            if (ctx.data.length < def.minLength.value) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.too_small,
                    minimum: def.minLength.value,
                    type: "array",
                    inclusive: true,
                    exact: false,
                    message: def.minLength.message,
                });
                status.dirty();
            }
        }
        if (def.maxLength !== null) {
            if (ctx.data.length > def.maxLength.value) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.too_big,
                    maximum: def.maxLength.value,
                    type: "array",
                    inclusive: true,
                    exact: false,
                    message: def.maxLength.message,
                });
                status.dirty();
            }
        }
        if (ctx.common.async) {
            return Promise.all([...ctx.data].map((item, i) => {
                return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
            })).then((result) => {
                return ParseStatus.mergeArray(status, result);
            });
        }
        const result = [...ctx.data].map((item, i) => {
            return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
        });
        return ParseStatus.mergeArray(status, result);
    }
    get element() {
        return this._def.type;
    }
    min(minLength, message) {
        return new ZodArray({
            ...this._def,
            minLength: { value: minLength, message: errorUtil.toString(message) },
        });
    }
    max(maxLength, message) {
        return new ZodArray({
            ...this._def,
            maxLength: { value: maxLength, message: errorUtil.toString(message) },
        });
    }
    length(len, message) {
        return new ZodArray({
            ...this._def,
            exactLength: { value: len, message: errorUtil.toString(message) },
        });
    }
    nonempty(message) {
        return this.min(1, message);
    }
}
ZodArray.create = (schema, params) => {
    return new ZodArray({
        type: schema,
        minLength: null,
        maxLength: null,
        exactLength: null,
        typeName: ZodFirstPartyTypeKind.ZodArray,
        ...processCreateParams(params),
    });
};
function deepPartialify(schema) {
    if (schema instanceof ZodObject) {
        const newShape = {};
        for (const key in schema.shape) {
            const fieldSchema = schema.shape[key];
            newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
        }
        return new ZodObject({
            ...schema._def,
            shape: () => newShape,
        });
    }
    else if (schema instanceof ZodArray) {
        return new ZodArray({
            ...schema._def,
            type: deepPartialify(schema.element),
        });
    }
    else if (schema instanceof ZodOptional) {
        return ZodOptional.create(deepPartialify(schema.unwrap()));
    }
    else if (schema instanceof ZodNullable) {
        return ZodNullable.create(deepPartialify(schema.unwrap()));
    }
    else if (schema instanceof ZodTuple) {
        return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
    }
    else {
        return schema;
    }
}
class ZodObject extends ZodType {
    constructor() {
        super(...arguments);
        this._cached = null;
        /**
         * @deprecated In most cases, this is no longer needed - unknown properties are now silently stripped.
         * If you want to pass through unknown properties, use `.passthrough()` instead.
         */
        this.nonstrict = this.passthrough;
        // extend<
        //   Augmentation extends ZodRawShape,
        //   NewOutput extends util.flatten<{
        //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
        //       ? Augmentation[k]["_output"]
        //       : k extends keyof Output
        //       ? Output[k]
        //       : never;
        //   }>,
        //   NewInput extends util.flatten<{
        //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
        //       ? Augmentation[k]["_input"]
        //       : k extends keyof Input
        //       ? Input[k]
        //       : never;
        //   }>
        // >(
        //   augmentation: Augmentation
        // ): ZodObject<
        //   extendShape<T, Augmentation>,
        //   UnknownKeys,
        //   Catchall,
        //   NewOutput,
        //   NewInput
        // > {
        //   return new ZodObject({
        //     ...this._def,
        //     shape: () => ({
        //       ...this._def.shape(),
        //       ...augmentation,
        //     }),
        //   }) as any;
        // }
        /**
         * @deprecated Use `.extend` instead
         *  */
        this.augment = this.extend;
    }
    _getCached() {
        if (this._cached !== null)
            return this._cached;
        const shape = this._def.shape();
        const keys = util.objectKeys(shape);
        this._cached = { shape, keys };
        return this._cached;
    }
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.object) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.object,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const { status, ctx } = this._processInputParams(input);
        const { shape, keys: shapeKeys } = this._getCached();
        const extraKeys = [];
        if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
            for (const key in ctx.data) {
                if (!shapeKeys.includes(key)) {
                    extraKeys.push(key);
                }
            }
        }
        const pairs = [];
        for (const key of shapeKeys) {
            const keyValidator = shape[key];
            const value = ctx.data[key];
            pairs.push({
                key: { status: "valid", value: key },
                value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
                alwaysSet: key in ctx.data,
            });
        }
        if (this._def.catchall instanceof ZodNever) {
            const unknownKeys = this._def.unknownKeys;
            if (unknownKeys === "passthrough") {
                for (const key of extraKeys) {
                    pairs.push({
                        key: { status: "valid", value: key },
                        value: { status: "valid", value: ctx.data[key] },
                    });
                }
            }
            else if (unknownKeys === "strict") {
                if (extraKeys.length > 0) {
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.unrecognized_keys,
                        keys: extraKeys,
                    });
                    status.dirty();
                }
            }
            else if (unknownKeys === "strip") ;
            else {
                throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
            }
        }
        else {
            // run catchall validation
            const catchall = this._def.catchall;
            for (const key of extraKeys) {
                const value = ctx.data[key];
                pairs.push({
                    key: { status: "valid", value: key },
                    value: catchall._parse(new ParseInputLazyPath(ctx, value, ctx.path, key) //, ctx.child(key), value, getParsedType(value)
                    ),
                    alwaysSet: key in ctx.data,
                });
            }
        }
        if (ctx.common.async) {
            return Promise.resolve()
                .then(async () => {
                const syncPairs = [];
                for (const pair of pairs) {
                    const key = await pair.key;
                    const value = await pair.value;
                    syncPairs.push({
                        key,
                        value,
                        alwaysSet: pair.alwaysSet,
                    });
                }
                return syncPairs;
            })
                .then((syncPairs) => {
                return ParseStatus.mergeObjectSync(status, syncPairs);
            });
        }
        else {
            return ParseStatus.mergeObjectSync(status, pairs);
        }
    }
    get shape() {
        return this._def.shape();
    }
    strict(message) {
        errorUtil.errToObj;
        return new ZodObject({
            ...this._def,
            unknownKeys: "strict",
            ...(message !== undefined
                ? {
                    errorMap: (issue, ctx) => {
                        const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
                        if (issue.code === "unrecognized_keys")
                            return {
                                message: errorUtil.errToObj(message).message ?? defaultError,
                            };
                        return {
                            message: defaultError,
                        };
                    },
                }
                : {}),
        });
    }
    strip() {
        return new ZodObject({
            ...this._def,
            unknownKeys: "strip",
        });
    }
    passthrough() {
        return new ZodObject({
            ...this._def,
            unknownKeys: "passthrough",
        });
    }
    // const AugmentFactory =
    //   <Def extends ZodObjectDef>(def: Def) =>
    //   <Augmentation extends ZodRawShape>(
    //     augmentation: Augmentation
    //   ): ZodObject<
    //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
    //     Def["unknownKeys"],
    //     Def["catchall"]
    //   > => {
    //     return new ZodObject({
    //       ...def,
    //       shape: () => ({
    //         ...def.shape(),
    //         ...augmentation,
    //       }),
    //     }) as any;
    //   };
    extend(augmentation) {
        return new ZodObject({
            ...this._def,
            shape: () => ({
                ...this._def.shape(),
                ...augmentation,
            }),
        });
    }
    /**
     * Prior to zod@1.0.12 there was a bug in the
     * inferred type of merged objects. Please
     * upgrade if you are experiencing issues.
     */
    merge(merging) {
        const merged = new ZodObject({
            unknownKeys: merging._def.unknownKeys,
            catchall: merging._def.catchall,
            shape: () => ({
                ...this._def.shape(),
                ...merging._def.shape(),
            }),
            typeName: ZodFirstPartyTypeKind.ZodObject,
        });
        return merged;
    }
    // merge<
    //   Incoming extends AnyZodObject,
    //   Augmentation extends Incoming["shape"],
    //   NewOutput extends {
    //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
    //       ? Augmentation[k]["_output"]
    //       : k extends keyof Output
    //       ? Output[k]
    //       : never;
    //   },
    //   NewInput extends {
    //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
    //       ? Augmentation[k]["_input"]
    //       : k extends keyof Input
    //       ? Input[k]
    //       : never;
    //   }
    // >(
    //   merging: Incoming
    // ): ZodObject<
    //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
    //   Incoming["_def"]["unknownKeys"],
    //   Incoming["_def"]["catchall"],
    //   NewOutput,
    //   NewInput
    // > {
    //   const merged: any = new ZodObject({
    //     unknownKeys: merging._def.unknownKeys,
    //     catchall: merging._def.catchall,
    //     shape: () =>
    //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
    //     typeName: ZodFirstPartyTypeKind.ZodObject,
    //   }) as any;
    //   return merged;
    // }
    setKey(key, schema) {
        return this.augment({ [key]: schema });
    }
    // merge<Incoming extends AnyZodObject>(
    //   merging: Incoming
    // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
    // ZodObject<
    //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
    //   Incoming["_def"]["unknownKeys"],
    //   Incoming["_def"]["catchall"]
    // > {
    //   // const mergedShape = objectUtil.mergeShapes(
    //   //   this._def.shape(),
    //   //   merging._def.shape()
    //   // );
    //   const merged: any = new ZodObject({
    //     unknownKeys: merging._def.unknownKeys,
    //     catchall: merging._def.catchall,
    //     shape: () =>
    //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
    //     typeName: ZodFirstPartyTypeKind.ZodObject,
    //   }) as any;
    //   return merged;
    // }
    catchall(index) {
        return new ZodObject({
            ...this._def,
            catchall: index,
        });
    }
    pick(mask) {
        const shape = {};
        for (const key of util.objectKeys(mask)) {
            if (mask[key] && this.shape[key]) {
                shape[key] = this.shape[key];
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => shape,
        });
    }
    omit(mask) {
        const shape = {};
        for (const key of util.objectKeys(this.shape)) {
            if (!mask[key]) {
                shape[key] = this.shape[key];
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => shape,
        });
    }
    /**
     * @deprecated
     */
    deepPartial() {
        return deepPartialify(this);
    }
    partial(mask) {
        const newShape = {};
        for (const key of util.objectKeys(this.shape)) {
            const fieldSchema = this.shape[key];
            if (mask && !mask[key]) {
                newShape[key] = fieldSchema;
            }
            else {
                newShape[key] = fieldSchema.optional();
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => newShape,
        });
    }
    required(mask) {
        const newShape = {};
        for (const key of util.objectKeys(this.shape)) {
            if (mask && !mask[key]) {
                newShape[key] = this.shape[key];
            }
            else {
                const fieldSchema = this.shape[key];
                let newField = fieldSchema;
                while (newField instanceof ZodOptional) {
                    newField = newField._def.innerType;
                }
                newShape[key] = newField;
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => newShape,
        });
    }
    keyof() {
        return createZodEnum(util.objectKeys(this.shape));
    }
}
ZodObject.create = (shape, params) => {
    return new ZodObject({
        shape: () => shape,
        unknownKeys: "strip",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params),
    });
};
ZodObject.strictCreate = (shape, params) => {
    return new ZodObject({
        shape: () => shape,
        unknownKeys: "strict",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params),
    });
};
ZodObject.lazycreate = (shape, params) => {
    return new ZodObject({
        shape,
        unknownKeys: "strip",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params),
    });
};
class ZodUnion extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        const options = this._def.options;
        function handleResults(results) {
            // return first issue-free validation if it exists
            for (const result of results) {
                if (result.result.status === "valid") {
                    return result.result;
                }
            }
            for (const result of results) {
                if (result.result.status === "dirty") {
                    // add issues from dirty option
                    ctx.common.issues.push(...result.ctx.common.issues);
                    return result.result;
                }
            }
            // return invalid
            const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_union,
                unionErrors,
            });
            return INVALID;
        }
        if (ctx.common.async) {
            return Promise.all(options.map(async (option) => {
                const childCtx = {
                    ...ctx,
                    common: {
                        ...ctx.common,
                        issues: [],
                    },
                    parent: null,
                };
                return {
                    result: await option._parseAsync({
                        data: ctx.data,
                        path: ctx.path,
                        parent: childCtx,
                    }),
                    ctx: childCtx,
                };
            })).then(handleResults);
        }
        else {
            let dirty = undefined;
            const issues = [];
            for (const option of options) {
                const childCtx = {
                    ...ctx,
                    common: {
                        ...ctx.common,
                        issues: [],
                    },
                    parent: null,
                };
                const result = option._parseSync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: childCtx,
                });
                if (result.status === "valid") {
                    return result;
                }
                else if (result.status === "dirty" && !dirty) {
                    dirty = { result, ctx: childCtx };
                }
                if (childCtx.common.issues.length) {
                    issues.push(childCtx.common.issues);
                }
            }
            if (dirty) {
                ctx.common.issues.push(...dirty.ctx.common.issues);
                return dirty.result;
            }
            const unionErrors = issues.map((issues) => new ZodError(issues));
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_union,
                unionErrors,
            });
            return INVALID;
        }
    }
    get options() {
        return this._def.options;
    }
}
ZodUnion.create = (types, params) => {
    return new ZodUnion({
        options: types,
        typeName: ZodFirstPartyTypeKind.ZodUnion,
        ...processCreateParams(params),
    });
};
function mergeValues(a, b) {
    const aType = getParsedType(a);
    const bType = getParsedType(b);
    if (a === b) {
        return { valid: true, data: a };
    }
    else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
        const bKeys = util.objectKeys(b);
        const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
        const newObj = { ...a, ...b };
        for (const key of sharedKeys) {
            const sharedValue = mergeValues(a[key], b[key]);
            if (!sharedValue.valid) {
                return { valid: false };
            }
            newObj[key] = sharedValue.data;
        }
        return { valid: true, data: newObj };
    }
    else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
        if (a.length !== b.length) {
            return { valid: false };
        }
        const newArray = [];
        for (let index = 0; index < a.length; index++) {
            const itemA = a[index];
            const itemB = b[index];
            const sharedValue = mergeValues(itemA, itemB);
            if (!sharedValue.valid) {
                return { valid: false };
            }
            newArray.push(sharedValue.data);
        }
        return { valid: true, data: newArray };
    }
    else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
        return { valid: true, data: a };
    }
    else {
        return { valid: false };
    }
}
class ZodIntersection extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        const handleParsed = (parsedLeft, parsedRight) => {
            if (isAborted(parsedLeft) || isAborted(parsedRight)) {
                return INVALID;
            }
            const merged = mergeValues(parsedLeft.value, parsedRight.value);
            if (!merged.valid) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.invalid_intersection_types,
                });
                return INVALID;
            }
            if (isDirty(parsedLeft) || isDirty(parsedRight)) {
                status.dirty();
            }
            return { status: status.value, value: merged.data };
        };
        if (ctx.common.async) {
            return Promise.all([
                this._def.left._parseAsync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                }),
                this._def.right._parseAsync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                }),
            ]).then(([left, right]) => handleParsed(left, right));
        }
        else {
            return handleParsed(this._def.left._parseSync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            }), this._def.right._parseSync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            }));
        }
    }
}
ZodIntersection.create = (left, right, params) => {
    return new ZodIntersection({
        left: left,
        right: right,
        typeName: ZodFirstPartyTypeKind.ZodIntersection,
        ...processCreateParams(params),
    });
};
// type ZodTupleItems = [ZodTypeAny, ...ZodTypeAny[]];
class ZodTuple extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.array) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.array,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        if (ctx.data.length < this._def.items.length) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.too_small,
                minimum: this._def.items.length,
                inclusive: true,
                exact: false,
                type: "array",
            });
            return INVALID;
        }
        const rest = this._def.rest;
        if (!rest && ctx.data.length > this._def.items.length) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.too_big,
                maximum: this._def.items.length,
                inclusive: true,
                exact: false,
                type: "array",
            });
            status.dirty();
        }
        const items = [...ctx.data]
            .map((item, itemIndex) => {
            const schema = this._def.items[itemIndex] || this._def.rest;
            if (!schema)
                return null;
            return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
        })
            .filter((x) => !!x); // filter nulls
        if (ctx.common.async) {
            return Promise.all(items).then((results) => {
                return ParseStatus.mergeArray(status, results);
            });
        }
        else {
            return ParseStatus.mergeArray(status, items);
        }
    }
    get items() {
        return this._def.items;
    }
    rest(rest) {
        return new ZodTuple({
            ...this._def,
            rest,
        });
    }
}
ZodTuple.create = (schemas, params) => {
    if (!Array.isArray(schemas)) {
        throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
    }
    return new ZodTuple({
        items: schemas,
        typeName: ZodFirstPartyTypeKind.ZodTuple,
        rest: null,
        ...processCreateParams(params),
    });
};
class ZodRecord extends ZodType {
    get keySchema() {
        return this._def.keyType;
    }
    get valueSchema() {
        return this._def.valueType;
    }
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.object) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.object,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const pairs = [];
        const keyType = this._def.keyType;
        const valueType = this._def.valueType;
        for (const key in ctx.data) {
            pairs.push({
                key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
                value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
                alwaysSet: key in ctx.data,
            });
        }
        if (ctx.common.async) {
            return ParseStatus.mergeObjectAsync(status, pairs);
        }
        else {
            return ParseStatus.mergeObjectSync(status, pairs);
        }
    }
    get element() {
        return this._def.valueType;
    }
    static create(first, second, third) {
        if (second instanceof ZodType) {
            return new ZodRecord({
                keyType: first,
                valueType: second,
                typeName: ZodFirstPartyTypeKind.ZodRecord,
                ...processCreateParams(third),
            });
        }
        return new ZodRecord({
            keyType: ZodString.create(),
            valueType: first,
            typeName: ZodFirstPartyTypeKind.ZodRecord,
            ...processCreateParams(second),
        });
    }
}
class ZodMap extends ZodType {
    get keySchema() {
        return this._def.keyType;
    }
    get valueSchema() {
        return this._def.valueType;
    }
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.map) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.map,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const keyType = this._def.keyType;
        const valueType = this._def.valueType;
        const pairs = [...ctx.data.entries()].map(([key, value], index) => {
            return {
                key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
                value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"])),
            };
        });
        if (ctx.common.async) {
            const finalMap = new Map();
            return Promise.resolve().then(async () => {
                for (const pair of pairs) {
                    const key = await pair.key;
                    const value = await pair.value;
                    if (key.status === "aborted" || value.status === "aborted") {
                        return INVALID;
                    }
                    if (key.status === "dirty" || value.status === "dirty") {
                        status.dirty();
                    }
                    finalMap.set(key.value, value.value);
                }
                return { status: status.value, value: finalMap };
            });
        }
        else {
            const finalMap = new Map();
            for (const pair of pairs) {
                const key = pair.key;
                const value = pair.value;
                if (key.status === "aborted" || value.status === "aborted") {
                    return INVALID;
                }
                if (key.status === "dirty" || value.status === "dirty") {
                    status.dirty();
                }
                finalMap.set(key.value, value.value);
            }
            return { status: status.value, value: finalMap };
        }
    }
}
ZodMap.create = (keyType, valueType, params) => {
    return new ZodMap({
        valueType,
        keyType,
        typeName: ZodFirstPartyTypeKind.ZodMap,
        ...processCreateParams(params),
    });
};
class ZodSet extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.set) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.set,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const def = this._def;
        if (def.minSize !== null) {
            if (ctx.data.size < def.minSize.value) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.too_small,
                    minimum: def.minSize.value,
                    type: "set",
                    inclusive: true,
                    exact: false,
                    message: def.minSize.message,
                });
                status.dirty();
            }
        }
        if (def.maxSize !== null) {
            if (ctx.data.size > def.maxSize.value) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.too_big,
                    maximum: def.maxSize.value,
                    type: "set",
                    inclusive: true,
                    exact: false,
                    message: def.maxSize.message,
                });
                status.dirty();
            }
        }
        const valueType = this._def.valueType;
        function finalizeSet(elements) {
            const parsedSet = new Set();
            for (const element of elements) {
                if (element.status === "aborted")
                    return INVALID;
                if (element.status === "dirty")
                    status.dirty();
                parsedSet.add(element.value);
            }
            return { status: status.value, value: parsedSet };
        }
        const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
        if (ctx.common.async) {
            return Promise.all(elements).then((elements) => finalizeSet(elements));
        }
        else {
            return finalizeSet(elements);
        }
    }
    min(minSize, message) {
        return new ZodSet({
            ...this._def,
            minSize: { value: minSize, message: errorUtil.toString(message) },
        });
    }
    max(maxSize, message) {
        return new ZodSet({
            ...this._def,
            maxSize: { value: maxSize, message: errorUtil.toString(message) },
        });
    }
    size(size, message) {
        return this.min(size, message).max(size, message);
    }
    nonempty(message) {
        return this.min(1, message);
    }
}
ZodSet.create = (valueType, params) => {
    return new ZodSet({
        valueType,
        minSize: null,
        maxSize: null,
        typeName: ZodFirstPartyTypeKind.ZodSet,
        ...processCreateParams(params),
    });
};
class ZodLazy extends ZodType {
    get schema() {
        return this._def.getter();
    }
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        const lazySchema = this._def.getter();
        return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
    }
}
ZodLazy.create = (getter, params) => {
    return new ZodLazy({
        getter: getter,
        typeName: ZodFirstPartyTypeKind.ZodLazy,
        ...processCreateParams(params),
    });
};
class ZodLiteral extends ZodType {
    _parse(input) {
        if (input.data !== this._def.value) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                received: ctx.data,
                code: ZodIssueCode.invalid_literal,
                expected: this._def.value,
            });
            return INVALID;
        }
        return { status: "valid", value: input.data };
    }
    get value() {
        return this._def.value;
    }
}
ZodLiteral.create = (value, params) => {
    return new ZodLiteral({
        value: value,
        typeName: ZodFirstPartyTypeKind.ZodLiteral,
        ...processCreateParams(params),
    });
};
function createZodEnum(values, params) {
    return new ZodEnum({
        values,
        typeName: ZodFirstPartyTypeKind.ZodEnum,
        ...processCreateParams(params),
    });
}
class ZodEnum extends ZodType {
    _parse(input) {
        if (typeof input.data !== "string") {
            const ctx = this._getOrReturnCtx(input);
            const expectedValues = this._def.values;
            addIssueToContext(ctx, {
                expected: util.joinValues(expectedValues),
                received: ctx.parsedType,
                code: ZodIssueCode.invalid_type,
            });
            return INVALID;
        }
        if (!this._cache) {
            this._cache = new Set(this._def.values);
        }
        if (!this._cache.has(input.data)) {
            const ctx = this._getOrReturnCtx(input);
            const expectedValues = this._def.values;
            addIssueToContext(ctx, {
                received: ctx.data,
                code: ZodIssueCode.invalid_enum_value,
                options: expectedValues,
            });
            return INVALID;
        }
        return OK(input.data);
    }
    get options() {
        return this._def.values;
    }
    get enum() {
        const enumValues = {};
        for (const val of this._def.values) {
            enumValues[val] = val;
        }
        return enumValues;
    }
    get Values() {
        const enumValues = {};
        for (const val of this._def.values) {
            enumValues[val] = val;
        }
        return enumValues;
    }
    get Enum() {
        const enumValues = {};
        for (const val of this._def.values) {
            enumValues[val] = val;
        }
        return enumValues;
    }
    extract(values, newDef = this._def) {
        return ZodEnum.create(values, {
            ...this._def,
            ...newDef,
        });
    }
    exclude(values, newDef = this._def) {
        return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
            ...this._def,
            ...newDef,
        });
    }
}
ZodEnum.create = createZodEnum;
class ZodNativeEnum extends ZodType {
    _parse(input) {
        const nativeEnumValues = util.getValidEnumValues(this._def.values);
        const ctx = this._getOrReturnCtx(input);
        if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
            const expectedValues = util.objectValues(nativeEnumValues);
            addIssueToContext(ctx, {
                expected: util.joinValues(expectedValues),
                received: ctx.parsedType,
                code: ZodIssueCode.invalid_type,
            });
            return INVALID;
        }
        if (!this._cache) {
            this._cache = new Set(util.getValidEnumValues(this._def.values));
        }
        if (!this._cache.has(input.data)) {
            const expectedValues = util.objectValues(nativeEnumValues);
            addIssueToContext(ctx, {
                received: ctx.data,
                code: ZodIssueCode.invalid_enum_value,
                options: expectedValues,
            });
            return INVALID;
        }
        return OK(input.data);
    }
    get enum() {
        return this._def.values;
    }
}
ZodNativeEnum.create = (values, params) => {
    return new ZodNativeEnum({
        values: values,
        typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
        ...processCreateParams(params),
    });
};
class ZodPromise extends ZodType {
    unwrap() {
        return this._def.type;
    }
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.promise,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
        return OK(promisified.then((data) => {
            return this._def.type.parseAsync(data, {
                path: ctx.path,
                errorMap: ctx.common.contextualErrorMap,
            });
        }));
    }
}
ZodPromise.create = (schema, params) => {
    return new ZodPromise({
        type: schema,
        typeName: ZodFirstPartyTypeKind.ZodPromise,
        ...processCreateParams(params),
    });
};
class ZodEffects extends ZodType {
    innerType() {
        return this._def.schema;
    }
    sourceType() {
        return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects
            ? this._def.schema.sourceType()
            : this._def.schema;
    }
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        const effect = this._def.effect || null;
        const checkCtx = {
            addIssue: (arg) => {
                addIssueToContext(ctx, arg);
                if (arg.fatal) {
                    status.abort();
                }
                else {
                    status.dirty();
                }
            },
            get path() {
                return ctx.path;
            },
        };
        checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
        if (effect.type === "preprocess") {
            const processed = effect.transform(ctx.data, checkCtx);
            if (ctx.common.async) {
                return Promise.resolve(processed).then(async (processed) => {
                    if (status.value === "aborted")
                        return INVALID;
                    const result = await this._def.schema._parseAsync({
                        data: processed,
                        path: ctx.path,
                        parent: ctx,
                    });
                    if (result.status === "aborted")
                        return INVALID;
                    if (result.status === "dirty")
                        return DIRTY(result.value);
                    if (status.value === "dirty")
                        return DIRTY(result.value);
                    return result;
                });
            }
            else {
                if (status.value === "aborted")
                    return INVALID;
                const result = this._def.schema._parseSync({
                    data: processed,
                    path: ctx.path,
                    parent: ctx,
                });
                if (result.status === "aborted")
                    return INVALID;
                if (result.status === "dirty")
                    return DIRTY(result.value);
                if (status.value === "dirty")
                    return DIRTY(result.value);
                return result;
            }
        }
        if (effect.type === "refinement") {
            const executeRefinement = (acc) => {
                const result = effect.refinement(acc, checkCtx);
                if (ctx.common.async) {
                    return Promise.resolve(result);
                }
                if (result instanceof Promise) {
                    throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
                }
                return acc;
            };
            if (ctx.common.async === false) {
                const inner = this._def.schema._parseSync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                });
                if (inner.status === "aborted")
                    return INVALID;
                if (inner.status === "dirty")
                    status.dirty();
                // return value is ignored
                executeRefinement(inner.value);
                return { status: status.value, value: inner.value };
            }
            else {
                return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
                    if (inner.status === "aborted")
                        return INVALID;
                    if (inner.status === "dirty")
                        status.dirty();
                    return executeRefinement(inner.value).then(() => {
                        return { status: status.value, value: inner.value };
                    });
                });
            }
        }
        if (effect.type === "transform") {
            if (ctx.common.async === false) {
                const base = this._def.schema._parseSync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                });
                if (!isValid(base))
                    return INVALID;
                const result = effect.transform(base.value, checkCtx);
                if (result instanceof Promise) {
                    throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
                }
                return { status: status.value, value: result };
            }
            else {
                return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
                    if (!isValid(base))
                        return INVALID;
                    return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
                        status: status.value,
                        value: result,
                    }));
                });
            }
        }
        util.assertNever(effect);
    }
}
ZodEffects.create = (schema, effect, params) => {
    return new ZodEffects({
        schema,
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        effect,
        ...processCreateParams(params),
    });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
    return new ZodEffects({
        schema,
        effect: { type: "preprocess", transform: preprocess },
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        ...processCreateParams(params),
    });
};
class ZodOptional extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType === ZodParsedType.undefined) {
            return OK(undefined);
        }
        return this._def.innerType._parse(input);
    }
    unwrap() {
        return this._def.innerType;
    }
}
ZodOptional.create = (type, params) => {
    return new ZodOptional({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodOptional,
        ...processCreateParams(params),
    });
};
class ZodNullable extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType === ZodParsedType.null) {
            return OK(null);
        }
        return this._def.innerType._parse(input);
    }
    unwrap() {
        return this._def.innerType;
    }
}
ZodNullable.create = (type, params) => {
    return new ZodNullable({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodNullable,
        ...processCreateParams(params),
    });
};
class ZodDefault extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        let data = ctx.data;
        if (ctx.parsedType === ZodParsedType.undefined) {
            data = this._def.defaultValue();
        }
        return this._def.innerType._parse({
            data,
            path: ctx.path,
            parent: ctx,
        });
    }
    removeDefault() {
        return this._def.innerType;
    }
}
ZodDefault.create = (type, params) => {
    return new ZodDefault({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodDefault,
        defaultValue: typeof params.default === "function" ? params.default : () => params.default,
        ...processCreateParams(params),
    });
};
class ZodCatch extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        // newCtx is used to not collect issues from inner types in ctx
        const newCtx = {
            ...ctx,
            common: {
                ...ctx.common,
                issues: [],
            },
        };
        const result = this._def.innerType._parse({
            data: newCtx.data,
            path: newCtx.path,
            parent: {
                ...newCtx,
            },
        });
        if (isAsync(result)) {
            return result.then((result) => {
                return {
                    status: "valid",
                    value: result.status === "valid"
                        ? result.value
                        : this._def.catchValue({
                            get error() {
                                return new ZodError(newCtx.common.issues);
                            },
                            input: newCtx.data,
                        }),
                };
            });
        }
        else {
            return {
                status: "valid",
                value: result.status === "valid"
                    ? result.value
                    : this._def.catchValue({
                        get error() {
                            return new ZodError(newCtx.common.issues);
                        },
                        input: newCtx.data,
                    }),
            };
        }
    }
    removeCatch() {
        return this._def.innerType;
    }
}
ZodCatch.create = (type, params) => {
    return new ZodCatch({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodCatch,
        catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
        ...processCreateParams(params),
    });
};
class ZodNaN extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.nan) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.nan,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return { status: "valid", value: input.data };
    }
}
ZodNaN.create = (params) => {
    return new ZodNaN({
        typeName: ZodFirstPartyTypeKind.ZodNaN,
        ...processCreateParams(params),
    });
};
class ZodBranded extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        const data = ctx.data;
        return this._def.type._parse({
            data,
            path: ctx.path,
            parent: ctx,
        });
    }
    unwrap() {
        return this._def.type;
    }
}
class ZodPipeline extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.common.async) {
            const handleAsync = async () => {
                const inResult = await this._def.in._parseAsync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                });
                if (inResult.status === "aborted")
                    return INVALID;
                if (inResult.status === "dirty") {
                    status.dirty();
                    return DIRTY(inResult.value);
                }
                else {
                    return this._def.out._parseAsync({
                        data: inResult.value,
                        path: ctx.path,
                        parent: ctx,
                    });
                }
            };
            return handleAsync();
        }
        else {
            const inResult = this._def.in._parseSync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            });
            if (inResult.status === "aborted")
                return INVALID;
            if (inResult.status === "dirty") {
                status.dirty();
                return {
                    status: "dirty",
                    value: inResult.value,
                };
            }
            else {
                return this._def.out._parseSync({
                    data: inResult.value,
                    path: ctx.path,
                    parent: ctx,
                });
            }
        }
    }
    static create(a, b) {
        return new ZodPipeline({
            in: a,
            out: b,
            typeName: ZodFirstPartyTypeKind.ZodPipeline,
        });
    }
}
class ZodReadonly extends ZodType {
    _parse(input) {
        const result = this._def.innerType._parse(input);
        const freeze = (data) => {
            if (isValid(data)) {
                data.value = Object.freeze(data.value);
            }
            return data;
        };
        return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
    }
    unwrap() {
        return this._def.innerType;
    }
}
ZodReadonly.create = (type, params) => {
    return new ZodReadonly({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodReadonly,
        ...processCreateParams(params),
    });
};
var ZodFirstPartyTypeKind;
(function (ZodFirstPartyTypeKind) {
    ZodFirstPartyTypeKind["ZodString"] = "ZodString";
    ZodFirstPartyTypeKind["ZodNumber"] = "ZodNumber";
    ZodFirstPartyTypeKind["ZodNaN"] = "ZodNaN";
    ZodFirstPartyTypeKind["ZodBigInt"] = "ZodBigInt";
    ZodFirstPartyTypeKind["ZodBoolean"] = "ZodBoolean";
    ZodFirstPartyTypeKind["ZodDate"] = "ZodDate";
    ZodFirstPartyTypeKind["ZodSymbol"] = "ZodSymbol";
    ZodFirstPartyTypeKind["ZodUndefined"] = "ZodUndefined";
    ZodFirstPartyTypeKind["ZodNull"] = "ZodNull";
    ZodFirstPartyTypeKind["ZodAny"] = "ZodAny";
    ZodFirstPartyTypeKind["ZodUnknown"] = "ZodUnknown";
    ZodFirstPartyTypeKind["ZodNever"] = "ZodNever";
    ZodFirstPartyTypeKind["ZodVoid"] = "ZodVoid";
    ZodFirstPartyTypeKind["ZodArray"] = "ZodArray";
    ZodFirstPartyTypeKind["ZodObject"] = "ZodObject";
    ZodFirstPartyTypeKind["ZodUnion"] = "ZodUnion";
    ZodFirstPartyTypeKind["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
    ZodFirstPartyTypeKind["ZodIntersection"] = "ZodIntersection";
    ZodFirstPartyTypeKind["ZodTuple"] = "ZodTuple";
    ZodFirstPartyTypeKind["ZodRecord"] = "ZodRecord";
    ZodFirstPartyTypeKind["ZodMap"] = "ZodMap";
    ZodFirstPartyTypeKind["ZodSet"] = "ZodSet";
    ZodFirstPartyTypeKind["ZodFunction"] = "ZodFunction";
    ZodFirstPartyTypeKind["ZodLazy"] = "ZodLazy";
    ZodFirstPartyTypeKind["ZodLiteral"] = "ZodLiteral";
    ZodFirstPartyTypeKind["ZodEnum"] = "ZodEnum";
    ZodFirstPartyTypeKind["ZodEffects"] = "ZodEffects";
    ZodFirstPartyTypeKind["ZodNativeEnum"] = "ZodNativeEnum";
    ZodFirstPartyTypeKind["ZodOptional"] = "ZodOptional";
    ZodFirstPartyTypeKind["ZodNullable"] = "ZodNullable";
    ZodFirstPartyTypeKind["ZodDefault"] = "ZodDefault";
    ZodFirstPartyTypeKind["ZodCatch"] = "ZodCatch";
    ZodFirstPartyTypeKind["ZodPromise"] = "ZodPromise";
    ZodFirstPartyTypeKind["ZodBranded"] = "ZodBranded";
    ZodFirstPartyTypeKind["ZodPipeline"] = "ZodPipeline";
    ZodFirstPartyTypeKind["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
const stringType = ZodString.create;
const numberType = ZodNumber.create;
const booleanType = ZodBoolean.create;
const unknownType = ZodUnknown.create;
ZodNever.create;
const arrayType = ZodArray.create;
const objectType = ZodObject.create;
const unionType = ZodUnion.create;
ZodIntersection.create;
ZodTuple.create;
const recordType = ZodRecord.create;
const literalType = ZodLiteral.create;
const enumType = ZodEnum.create;
ZodPromise.create;
ZodOptional.create;
ZodNullable.create;

const okResponse = (data, next_steps) => Object.freeze({ ok: true, data, next_steps: Object.freeze([...next_steps]) });
const errorResponse = (error, next_steps) => Object.freeze({ ok: false, error, next_steps: Object.freeze([...next_steps]) });
const registerTools = (server, tools, ctx) => {
    for (const tool of tools) {
        // The SDK's registerTool generics are tied to the per-call inputSchema; we
        // erase to `any` here because each ToolDef carries its own typed handler.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.registerTool(tool.name, {
            description: tool.description,
            inputSchema: tool.inputSchema,
        }, async (args) => {
            const response = await tool.handler(args, ctx);
            return {
                content: [
                    { type: 'text', text: JSON.stringify(response, null, 2) },
                ],
                structuredContent: response,
            };
        });
    }
};

/**
 * Shared host-process filesystem IO primitives.
 *
 * Three pure-at-edges functions consumed by every host module that needs to
 * persist a small JSON file under ~/.config/pwa-debug (host_state.state.json,
 * host_settings.settings.json, …). Side effects (fs) live here; callers stay
 * pure transforms.
 *
 * Plug-ability: a new persisted host file = pass a different filename +
 * caller-specific shape validator. No primitive in this module knows about
 * any particular schema.
 */
const PWA_DEBUG_CONFIG_DIR = 'pwa-debug';
/**
 * Resolve `<XDG_CONFIG_HOME | HOME/.config>/pwa-debug/<filename>`. Pure with
 * respect to the passed env snapshot. Throws on missing env vars; callers
 * (host_state, host_settings) wrap the throw with their own caller-specific
 * message so existing error contracts stay stable.
 */
const xdgConfigPath = (filename, env = process.env) => {
    const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
        ? env.XDG_CONFIG_HOME
        : env.HOME
            ? join(env.HOME, '.config')
            : null;
    if (!configHome) {
        throw new Error('host_io: cannot resolve config path; HOME and XDG_CONFIG_HOME are both unset');
    }
    return join(configHome, PWA_DEBUG_CONFIG_DIR, filename);
};
/**
 * Crash-safe JSON persistence: mkdir-p the parent dir, write to a per-process
 * tmp file, then atomic rename onto the target. Identical bytes (2-space
 * indent, trailing newline) to the inline implementation host_state used
 * pre-extraction so on-disk format is unchanged.
 */
const atomicWriteJson = async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    await rename(tmp, path);
};
/**
 * Append a single record line to a file. Opens-with-create on first call
 * (mode 0o600) and writes one fs.appendFile per call with a trailing '\n'.
 * Ensures the parent directory exists via mkdir -p. Owns the only place in
 * the host process where rolling jsonl files are appended — host_archive
 * composes this primitive on every disk-spill event from the captures ring
 * buffers. No buffering, no fsync; the caller decides when to rotate to a
 * fresh path. The caller passes a line WITHOUT a trailing newline so this
 * primitive owns line termination.
 */
const appendLine = async (path, line) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${line}\n`, { encoding: 'utf-8', mode: 0o600 });
};
/**
 * Streaming UTF-8 line reader for jsonl archives. Async generator over
 * createReadStream + readline so the host_archive reader can iterate
 * multi-MB rotated files without slurping them into memory. Final lines
 * without a trailing '\n' are still emitted (readline default).
 *
 * ENOENT contract: when the file does not exist, yields nothing and
 * returns normally — host_archive treats "archive doesn't exist yet" as
 * the steady state on a fresh install or with disk spill disabled.
 */
async function* readLines(path) {
    try {
        await access(path);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return;
        throw err;
    }
    const stream = createReadStream(path, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of rl) {
            yield line;
        }
    }
    finally {
        rl.close();
        stream.destroy();
    }
}
/**
 * Read + JSON.parse a config file with a missing-file fallback. The caller
 * supplies the (raw:unknown) => T validator so per-file shape enforcement
 * stays at the boundary that owns it — `host_state` validates HostState,
 * `host_settings` validates the persisted settings object, this primitive
 * remains schema-agnostic.
 */
const readJsonOr = async (path, fallback, parse) => {
    let body;
    try {
        body = await readFile(path, 'utf-8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return fallback;
        throw err;
    }
    return parse(JSON.parse(body));
};

const EMPTY_STATE = Object.freeze({
    extensionIds: Object.freeze([]),
    lastUpdated: '',
    lastInstalledManifestPaths: Object.freeze([]),
});
/**
 * Thin wrapper over host_io.xdgConfigPath. Pre-checks env so the error string
 * stays the host_state-specific message existing callers (and the test suite)
 * already assert on, rather than the generic host_io message.
 */
const defaultStatePath = (env = process.env) => {
    const hasXdg = Boolean(env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0);
    if (!hasXdg && !env.HOME) {
        throw new Error('host_state: cannot resolve state path; HOME and XDG_CONFIG_HOME are both unset');
    }
    return xdgConfigPath('state.json', env);
};
const isStringArray$1 = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const parseHostState = (raw) => {
    if (!raw || typeof raw !== 'object') {
        throw new Error('host_state: state.json root is not an object');
    }
    const r = raw;
    if (!isStringArray$1(r['extensionIds'])) {
        throw new Error('host_state: extensionIds is not a string[]');
    }
    if (typeof r['lastUpdated'] !== 'string') {
        throw new Error('host_state: lastUpdated is not a string');
    }
    if (!isStringArray$1(r['lastInstalledManifestPaths'])) {
        throw new Error('host_state: lastInstalledManifestPaths is not a string[]');
    }
    return {
        extensionIds: Object.freeze([...r['extensionIds']]),
        lastUpdated: r['lastUpdated'],
        lastInstalledManifestPaths: Object.freeze([...r['lastInstalledManifestPaths']]),
    };
};
const loadHostState = (path) => readJsonOr(path, EMPTY_STATE, parseHostState);
const saveHostState = (path, state) => atomicWriteJson(path, state);
const addExtensionId = (state, id) => {
    if (state.extensionIds.includes(id))
        return state;
    return {
        ...state,
        extensionIds: Object.freeze([...state.extensionIds, id]),
    };
};
const removeExtensionId = (state, id) => {
    if (!state.extensionIds.includes(id))
        return state;
    return {
        ...state,
        extensionIds: Object.freeze(state.extensionIds.filter((x) => x !== id)),
    };
};
const setManifestPaths = (state, paths) => {
    const deduped = Object.freeze([...new Set(paths)].sort());
    return { ...state, lastInstalledManifestPaths: deduped };
};

const NMH_DIR = 'NativeMessagingHosts';
const HOST_NAME$5 = 'com.pwa_debug.host';
const SNAP_CAVEAT = 'Snap confinement requires the host launcher and bundled main.js to be under $HOME (the snap home interface). If the connect fails, move the host into your home directory.';
const flatpakCaveat = (appId) => `Flatpak confinement may block host execution. If the connect fails, run \`flatpak override --user --filesystem=host ${appId}\` and retry.`;
const LINUX_NATIVE = Object.freeze([
    { name: 'chrome', segments: Object.freeze(['google-chrome']) },
    { name: 'chromium', segments: Object.freeze(['chromium']) },
    { name: 'edge', segments: Object.freeze(['microsoft-edge']) },
    { name: 'brave', segments: Object.freeze(['BraveSoftware', 'Brave-Browser']) },
    { name: 'vivaldi', segments: Object.freeze(['vivaldi']) },
    { name: 'opera', segments: Object.freeze(['opera']) },
]);
const LINUX_SNAP = Object.freeze([
    {
        name: 'chromium',
        snapPackage: 'chromium',
        configRelative: Object.freeze(['common', 'chromium']),
    },
    {
        name: 'chrome',
        snapPackage: 'google-chrome',
        configRelative: Object.freeze(['common', '.config', 'google-chrome']),
    },
]);
/**
 * Flatpak Chromium-family app-ids + their config segment under
 * ~/.var/app/<appId>/config/. Single source of truth for everything flatpak:
 * the NMH install path (detectLinux below), launch-side discovery
 * (browser_discovery), and profile-dir resolution (browser_launch/profile_dirs)
 * all read this table rather than re-deriving the app-id↔segment mapping.
 */
const LINUX_FLATPAK = Object.freeze([
    {
        name: 'chromium',
        appId: 'org.chromium.Chromium',
        configSegments: Object.freeze(['chromium']),
    },
    {
        name: 'chrome',
        appId: 'com.google.Chrome',
        configSegments: Object.freeze(['google-chrome']),
    },
    {
        name: 'edge',
        appId: 'com.microsoft.Edge',
        configSegments: Object.freeze(['microsoft-edge']),
    },
    {
        name: 'brave',
        appId: 'com.brave.Browser',
        configSegments: Object.freeze(['BraveSoftware', 'Brave-Browser']),
    },
    {
        name: 'vivaldi',
        appId: 'com.vivaldi.Vivaldi',
        configSegments: Object.freeze(['vivaldi']),
    },
    {
        name: 'opera',
        appId: 'com.opera.Opera',
        configSegments: Object.freeze(['opera']),
    },
]);
const MAC_BROWSERS = Object.freeze([
    { name: 'chrome', segments: Object.freeze(['Google', 'Chrome']) },
    { name: 'chromium', segments: Object.freeze(['Chromium']) },
    { name: 'edge', segments: Object.freeze(['Microsoft Edge']) },
    { name: 'brave', segments: Object.freeze(['BraveSoftware', 'Brave-Browser']) },
    { name: 'vivaldi', segments: Object.freeze(['Vivaldi']) },
    { name: 'opera', segments: Object.freeze(['com.operasoftware.Opera']) },
]);
const WIN_BROWSERS = Object.freeze([
    {
        name: 'chrome',
        vendorPath: 'Google\\Chrome',
        userDataSegments: Object.freeze(['Google', 'Chrome', 'User Data']),
    },
    {
        name: 'chromium',
        vendorPath: 'Chromium',
        userDataSegments: Object.freeze(['Chromium', 'User Data']),
    },
    {
        name: 'edge',
        vendorPath: 'Microsoft\\Edge',
        userDataSegments: Object.freeze(['Microsoft', 'Edge', 'User Data']),
    },
    {
        name: 'brave',
        vendorPath: 'BraveSoftware\\Brave-Browser',
        userDataSegments: Object.freeze(['BraveSoftware', 'Brave-Browser', 'User Data']),
    },
    {
        name: 'vivaldi',
        vendorPath: 'Vivaldi',
        userDataSegments: Object.freeze(['Vivaldi', 'User Data']),
    },
    {
        name: 'opera',
        vendorPath: 'Opera Software\\Opera Stable',
        userDataSegments: Object.freeze(['Opera Software', 'Opera Stable']),
    },
]);
const linuxConfigRoot$1 = (env) => {
    if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0)
        return env.XDG_CONFIG_HOME;
    if (env.HOME)
        return join(env.HOME, '.config');
    throw new Error('browser_paths: cannot resolve config root; HOME and XDG_CONFIG_HOME both unset');
};
const macSupportRoot = (env) => {
    if (!env.HOME)
        throw new Error('browser_paths: HOME unset on darwin');
    return join(env.HOME, 'Library', 'Application Support');
};
const winLocalAppData = (env) => {
    if (env.LOCALAPPDATA && env.LOCALAPPDATA.length > 0)
        return env.LOCALAPPDATA;
    if (env.USERPROFILE && env.USERPROFILE.length > 0) {
        return join(env.USERPROFILE, 'AppData', 'Local');
    }
    return null;
};
const detectLinux = async (env, exists) => {
    const out = [];
    const cfg = linuxConfigRoot$1(env);
    for (const b of LINUX_NATIVE) {
        const profile = join(cfg, ...b.segments);
        if (await exists(profile)) {
            out.push(Object.freeze({
                browser: b.name,
                kind: 'native',
                manifestDir: join(profile, NMH_DIR),
            }));
        }
    }
    if (env.HOME) {
        for (const b of LINUX_SNAP) {
            const profile = join(env.HOME, 'snap', b.snapPackage, ...b.configRelative);
            if (await exists(profile)) {
                out.push(Object.freeze({
                    browser: b.name,
                    kind: 'snap',
                    manifestDir: join(profile, NMH_DIR),
                    caveat: SNAP_CAVEAT,
                    snapPackage: b.snapPackage,
                }));
            }
        }
        for (const b of LINUX_FLATPAK) {
            const appRoot = join(env.HOME, '.var', 'app', b.appId);
            if (await exists(appRoot)) {
                out.push(Object.freeze({
                    browser: b.name,
                    kind: 'flatpak',
                    manifestDir: join(appRoot, 'config', ...b.configSegments, NMH_DIR),
                    caveat: flatpakCaveat(b.appId),
                }));
            }
        }
    }
    return Object.freeze(out);
};
const detectDarwin = async (env, exists) => {
    const out = [];
    const root = macSupportRoot(env);
    for (const b of MAC_BROWSERS) {
        const profile = join(root, ...b.segments);
        if (await exists(profile)) {
            out.push(Object.freeze({
                browser: b.name,
                kind: 'native',
                manifestDir: join(profile, NMH_DIR),
            }));
        }
    }
    return Object.freeze(out);
};
const detectWin32 = async (env, exists) => {
    const local = winLocalAppData(env);
    if (!local)
        return Object.freeze([]);
    const out = [];
    for (const b of WIN_BROWSERS) {
        const userDataDir = join(local, ...b.userDataSegments);
        if (await exists(userDataDir)) {
            out.push(Object.freeze({
                browser: b.name,
                kind: 'registry',
                registryHive: 'HKCU',
                registrySubkey: `Software\\${b.vendorPath}\\NativeMessagingHosts\\${HOST_NAME$5}`,
            }));
        }
    }
    return Object.freeze(out);
};
const detectBrowserInstalls = async (env, platform, exists) => {
    if (platform === 'linux')
        return detectLinux(env, exists);
    if (platform === 'darwin')
        return detectDarwin(env, exists);
    if (platform === 'win32')
        return detectWin32(env, exists);
    return Object.freeze([]);
};

const POSIX_HEADER = [
    '#!/bin/sh',
    '# pwa-debug native messaging host launcher (POSIX).',
    '# Generated at install time. Embeds an absolute node path so spawn works',
    '# under sandboxed/stripped PATH environments (snap, flatpak).',
];
const WINDOWS_HEADER = [
    '@echo off',
    'rem pwa-debug native messaging host launcher (Windows).',
    'rem Generated at install time. Embeds an absolute node.exe path.',
];
const buildPosixLauncher = (spec) => {
    const quoted = [spec.nodePath, spec.mainJsPath];
    if (spec.socketPath !== undefined)
        quoted.push(spec.socketPath);
    if (quoted.some((p) => p.includes("'"))) {
        throw new Error('launcher: nodePath/mainJsPath/socketPath must not contain single quotes (POSIX shell quoting)');
    }
    const envLines = spec.socketPath !== undefined
        ? [`PWA_DEBUG_SOCKET='${spec.socketPath}'`, 'export PWA_DEBUG_SOCKET']
        : [];
    const lines = [
        ...POSIX_HEADER,
        ...envLines,
        `exec '${spec.nodePath}' '${spec.mainJsPath}' "$@"`,
        '',
    ];
    return lines.join('\n');
};
const buildWindowsLauncher = (spec) => {
    const quoted = [spec.nodePath, spec.mainJsPath];
    if (spec.socketPath !== undefined)
        quoted.push(spec.socketPath);
    if (quoted.some((p) => p.includes('"'))) {
        throw new Error('launcher: nodePath/mainJsPath/socketPath must not contain double quotes (Windows .bat quoting)');
    }
    const envLines = spec.socketPath !== undefined
        ? [`set "PWA_DEBUG_SOCKET=${spec.socketPath}"`]
        : [];
    const lines = [
        ...WINDOWS_HEADER,
        ...envLines,
        `"${spec.nodePath}" "${spec.mainJsPath}" %*`,
        '',
    ];
    return lines.join('\r\n');
};
const defaultLauncherPath = (platform, env) => {
    if (platform === 'win32') {
        if (!env.APPDATA || env.APPDATA.length === 0) {
            throw new Error('launcher: APPDATA env var unset on win32');
        }
        return join(env.APPDATA, 'pwa-debug', 'pwa-debug-host.bat');
    }
    const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
        ? env.XDG_CONFIG_HOME
        : env.HOME
            ? join(env.HOME, '.config')
            : null;
    if (!configHome) {
        throw new Error('launcher: HOME and XDG_CONFIG_HOME both unset on posix');
    }
    return join(configHome, 'pwa-debug', 'bin', 'pwa-debug-host');
};
const writeLauncher = async (platform, spec, launcherPath) => {
    const body = platform === 'win32' ? buildWindowsLauncher(spec) : buildPosixLauncher(spec);
    await mkdir(dirname(launcherPath), { recursive: true });
    const tmp = `${launcherPath}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, body, 'utf-8');
    await rename(tmp, launcherPath);
    if (platform !== 'win32') {
        await chmod(launcherPath, 0o755);
    }
    return Object.freeze({ launcherPath });
};

const HOST_NAME$4 = 'com.pwa_debug.host';
const fileExists$4 = async (p) => {
    try {
        await stat(p);
        return true;
    }
    catch {
        return false;
    }
};
const expectedManifestPath = (install) => {
    if (install.kind === 'registry')
        return null;
    const segments = install.manifestDir.endsWith('/')
        ? `${install.manifestDir}${HOST_NAME$4}.json`
        : `${install.manifestDir}/${HOST_NAME$4}.json`;
    return segments;
};
const safeLauncherPath = () => {
    try {
        return defaultLauncherPath(process.platform, process.env);
    }
    catch {
        return null;
    }
};
const hostStatusHandler = async (_args, ctx) => {
    try {
        const statePath = defaultStatePath();
        const state = await loadHostState(statePath);
        const installs = await detectBrowserInstalls(process.env, process.platform, fileExists$4);
        const installReports = await Promise.all(installs.map(async (install) => {
            if (install.kind === 'registry') {
                return {
                    browser: install.browser,
                    kind: install.kind,
                    registrySubkey: install.registrySubkey,
                    manifestOnDisk: false,
                    verifiable: false,
                };
            }
            const path = expectedManifestPath(install) ?? '';
            const exists = path !== '' && (await fileExists$4(path));
            return {
                browser: install.browser,
                kind: install.kind,
                manifestPath: path,
                manifestOnDisk: exists,
                verifiable: true,
                ...(install.caveat ? { caveat: install.caveat } : {}),
            };
        }));
        const manifestPathsOnDisk = [];
        for (const p of state.lastInstalledManifestPaths) {
            if (await fileExists$4(p))
                manifestPathsOnDisk.push(p);
        }
        const launcherPath = safeLauncherPath();
        const launcherOnDisk = launcherPath !== null && (await fileExists$4(launcherPath));
        const activeConnections = ctx.ipcServer.listConnections();
        const data = {
            hostBinaryPath: process.argv[1] ?? '',
            stateFilePath: statePath,
            registeredExtensionIds: [...state.extensionIds],
            manifestPathsOnDisk,
            launcherPath,
            launcherOnDisk,
            installs: installReports,
            detectedBrowsers: installs.map((i) => i.browser),
            activeConnections,
        };
        const next_steps = [];
        if (state.extensionIds.length === 0) {
            next_steps.push('No extensions registered. Use chrome-devtools-mcp to read the pwa-debug service-worker console for a line like `[pwa-debug/sw] id=<id>`, then call host_register_extension with that ID.');
        }
        else if (manifestPathsOnDisk.length === 0) {
            next_steps.push('State records registered IDs but no manifest is present on disk. Call host_register_extension with the same ID to recreate per-browser manifests.');
        }
        else if (!launcherOnDisk) {
            next_steps.push('Manifest exists on disk but the launcher script is missing. Re-run host_register_extension with an existing ID to refresh the launcher.');
        }
        else if (activeConnections.length === 0) {
            next_steps.push('Manifest is installed and at least one extension ID is registered, but no NMH instance is currently connected. Ask the user to reload the extension at chrome://extensions so Chrome respawns the NMH; activeConnections will populate once the SW reconnects.');
        }
        else {
            next_steps.push(`Manifest is installed, launcher is present, and ${activeConnections.length} NMH connection(s) are live. Call session_ping (optionally with extension_id) for a full round-trip via the IPC bridge.`);
        }
        for (const r of installReports) {
            if (r.verifiable && !r.manifestOnDisk) {
                next_steps.push(`${r.browser} (${r.kind}): expected manifest at ${r.manifestPath} but file is missing. Re-run host_register_extension to recreate.`);
            }
            if (r.verifiable && 'caveat' in r && r.caveat) {
                next_steps.push(`${r.browser} (${r.kind}): ${r.caveat}`);
            }
        }
        if (state.extensionIds.length > 0 && manifestPathsOnDisk.length === 0) {
            next_steps.push('To uninstall cleanly, call host_reset.');
        }
        return okResponse(data, next_steps);
    }
    catch (err) {
        return errorResponse(`host_status failed: ${err.message}`, [
            'Filesystem error reading state. Check ~/.config/pwa-debug/state.json permissions and disk space.',
        ]);
    }
};
const hostStatusTool = Object.freeze({
    name: 'host_status',
    description: 'Reports the install/liveness state of the pwa-debug native messaging host: registered extension IDs, expected manifest paths per detected browser install (with on-disk verification for POSIX kinds), launcher script path + presence, and the host binary path. Cheap, idempotent, no side effects. CALL THIS BEFORE ANY OTHER pwa-debug TOOL to confirm setup. The structured response includes a next_steps[] array tailored to the actual state — follow it.',
    inputSchema: {},
    handler: hostStatusHandler,
});

/** Canonical native-messaging-host identity, shared by the install tool and the
 *  flatpak sandbox-launch manifest writer so the name/description live once. */
const HOST_NAME$3 = 'com.pwa_debug.host';
const HOST_DESCRIPTION$1 = 'PWA Debug Layer native messaging host';
const extensionIdToOrigin = (id) => `chrome-extension://${id}/`;
const buildHostManifest = (input) => {
    if (input.allowedExtensionIds.length === 0) {
        throw new Error('manifest_writer: allowedExtensionIds is empty; Chrome rejects manifests with no allowed_origins');
    }
    const origins = Object.freeze([...new Set(input.allowedExtensionIds.map(extensionIdToOrigin))].sort());
    return Object.freeze({
        name: input.name,
        description: input.description,
        path: input.hostBinaryPath,
        type: 'stdio',
        allowed_origins: origins,
    });
};
const manifestFilename = (manifestName) => `${manifestName}.json`;
/**
 * Write a single host manifest into `<dir>/<name>.json` atomically and return
 * the written path. Every sandbox launch (native, flatpak, snap — FINDING #3)
 * uses this: a Chromium spawned with a custom --user-data-dir searches
 * `<user-data-dir>/NativeMessagingHosts/` for the host manifest (not the
 * install location), so the launch flow drops a copy there pointing at the
 * appropriate launcher. Reuses the same atomic temp-then-rename as the
 * per-browser install path.
 */
const writeHostManifestToDir = async (manifest, dir) => {
    const path = join(dir, manifestFilename(manifest.name));
    await writeAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
    return path;
};
const writeAtomic = async (path, body) => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, body, 'utf-8');
    await rename(tmp, path);
};
const unlinkIfExists = async (path) => {
    try {
        await unlink(path);
        return true;
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
        return false;
    }
};
const requireRegistryOptions = (installs, options) => {
    if (!options.registryJsonPath) {
        throw new Error('manifest_writer: registryJsonPath is required when any install.kind === "registry"');
    }
    if (!options.registry) {
        throw new Error('manifest_writer: registry gateway is required when any install.kind === "registry"');
    }
    return { jsonPath: options.registryJsonPath, gateway: options.registry };
};
const installManifestForBrowsers = async (manifest, installs, options = {}) => {
    const body = `${JSON.stringify(manifest, null, 2)}\n`;
    const out = [];
    let registryJsonPathWritten = false;
    for (const install of installs) {
        if (install.kind === 'registry') {
            const { jsonPath, gateway } = requireRegistryOptions(installs, options);
            if (!registryJsonPathWritten) {
                await writeAtomic(jsonPath, body);
                registryJsonPathWritten = true;
            }
            await gateway.setDefault(install.registryHive, install.registrySubkey, jsonPath);
            out.push(Object.freeze({
                browser: install.browser,
                kind: 'registry',
                manifestPath: jsonPath,
                registrySubkey: install.registrySubkey,
            }));
            continue;
        }
        const path = join(install.manifestDir, manifestFilename(manifest.name));
        await writeAtomic(path, body);
        out.push(Object.freeze({
            browser: install.browser,
            kind: install.kind,
            manifestPath: path,
        }));
    }
    return Object.freeze(out);
};
const uninstallManifestForBrowsers = async (manifestName, installs, options = {}) => {
    const out = [];
    for (const install of installs) {
        if (install.kind === 'registry') {
            const { gateway } = requireRegistryOptions(installs, options);
            await gateway.removeKey(install.registryHive, install.registrySubkey);
            out.push(Object.freeze({
                browser: install.browser,
                kind: 'registry',
                manifestPath: options.registryJsonPath ?? '',
                registrySubkey: install.registrySubkey,
            }));
            continue;
        }
        const path = join(install.manifestDir, manifestFilename(manifestName));
        if (await unlinkIfExists(path)) {
            out.push(Object.freeze({
                browser: install.browser,
                kind: install.kind,
                manifestPath: path,
            }));
        }
    }
    if (options.registryJsonPath) {
        const anyRegistry = installs.some((i) => i.kind === 'registry');
        if (anyRegistry) {
            await unlinkIfExists(options.registryJsonPath);
        }
    }
    return Object.freeze(out);
};

/**
 * Snap-confinement native-messaging support.
 *
 * Snap chromium cannot use the normal $HOME launcher + node + ~/.config socket:
 * its AppArmor profile (snap.chromium.chromium) denies (a) exec of binaries
 * under $HOME and (b) connect() to a unix socket under ~/.config, and its base
 * runtime ships an older glibc than host-built binaries. Three clearances,
 * each live-verified in snap confinement (see milestone-54 notes):
 *   - exec IS allowed from ~/snap/<pkg>/common/ and of /usr/bin/python3;
 *   - /usr/bin/python3 runs under the snap runtime glibc and has AF_UNIX;
 *   - connect() to a unix socket UNDER ~/snap/<pkg>/common/ IS allowed.
 *
 * Because the NMH is a PURE byte relay (Chrome native-messaging framing and the
 * IPC socket framing are byte-identical — encodeIpcEnvelope === frameMessage),
 * the snap host is a ~20-line python3 script that pumps stdin<->the snap-common
 * unix socket. This module owns: where the snap host files live, the relay
 * source, the launcher that execs it, and the per-install snap socket paths the
 * MCP host additionally listens on.
 *
 * Single source of truth for snap package names: LINUX_SNAP in browser_paths.
 */
/** Filename of the generated python relay under the snap host dir. */
const SNAP_RELAY_FILENAME = 'snap_relay.py';
/** Filename of the generated snap launcher (the manifest `path` target). */
const SNAP_LAUNCHER_FILENAME = 'pwa-debug-host-snap';
/** Basename of the per-snap IPC socket the MCP host also listens on. */
const SNAP_SOCKET_FILENAME = 'mcp.sock';
/** ~/snap/<pkg>/common/pwa-debug — the snap-confinement-reachable host dir. */
const snapHostDir = (snapPackage, env) => env.HOME
    ? join(env.HOME, 'snap', snapPackage, 'common', 'pwa-debug')
    : null;
/** The snap package name for a browser, or null if it has no snap packaging. */
const snapPackageForBrowser = (browser) => LINUX_SNAP.find((b) => b.name === browser)?.snapPackage ?? null;
/**
 * Sandbox-mode profile dir for a snap browser: ~/snap/<pkg>/common/pwa-debug-profile.
 * The normal sandbox dir (~/.pwa-debug/profiles/<browser>) is UNREACHABLE under
 * snap confinement — `.pwa-debug` is a hidden dir the snap home interface
 * excludes, so the browser exits instantly. The snap's own common dir is
 * writable from inside confinement. Null without HOME.
 */
const snapSandboxProfileDir = (snapPackage, env) => env.HOME
    ? join(env.HOME, 'snap', snapPackage, 'common', 'pwa-debug-profile')
    : null;
/** Absolute path of the per-snap IPC socket (under the snap-common host dir). */
const snapSocketPath = (snapPackage, env) => {
    const dir = snapHostDir(snapPackage, env);
    return dir ? join(dir, SNAP_SOCKET_FILENAME) : null;
};
/**
 * The python3 relay source. Reads the target socket from PWA_DEBUG_SOCKET
 * (baked into the launcher), connects, SYNTHESIZES the IPC register frame from
 * the chrome-extension://<id>/ origin Chrome passes as argv (exactly like the
 * node NMH's nmh_mode + ipc_client — the register is NMH-generated, NOT sent by
 * the extension), then pumps stdin<->socket verbatim. After register, Chrome's
 * native-messaging frames and the host IPC frames are byte-identical (4-byte LE
 * len + JSON), so the rest is a pure byte relay. Uses /usr/bin/python3 from the
 * snap runtime (glibc-compatible, AppArmor-exec-allowed), never host node.
 */
const buildSnapRelayScript = () => [
    '#!/usr/bin/python3',
    '# pwa-debug snap native-messaging relay (generated at install time).',
    '# Synthesizes the register frame from the origin argv, then pumps',
    '# stdin<->the snap-common IPC unix socket (framing is byte-identical).',
    'import os, sys, socket, select, struct, json, re',
    'path = os.environ.get("PWA_DEBUG_SOCKET")',
    'if not path:',
    '    sys.stderr.write("pwa-debug snap relay: PWA_DEBUG_SOCKET unset\\n")',
    '    sys.exit(1)',
    '# Chrome passes the calling extension origin (chrome-extension://<id>/) in argv.',
    'ext = None',
    'for a in sys.argv[1:]:',
    '    m = re.match(r"^chrome-extension://([^/:]+)/?$", a)',
    '    if m:',
    '        ext = m.group(1)',
    '        break',
    'if not ext:',
    '    sys.stderr.write("pwa-debug snap relay: no chrome-extension origin in argv\\n")',
    '    sys.exit(1)',
    's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
    'try:',
    '    s.connect(path)',
    'except OSError as e:',
    '    sys.stderr.write("pwa-debug snap relay: connect failed: %s\\n" % e)',
    '    sys.exit(1)',
    '# Register frame (NMH-synthesized): 4-byte LE length + JSON body.',
    'reg = json.dumps({"type": "register", "extensionId": ext}).encode()',
    's.sendall(struct.pack("<I", len(reg)) + reg)',
    'stdin_fd = sys.stdin.fileno()',
    'out = sys.stdout.buffer',
    'stdin_open = True',
    'while True:',
    '    rlist = [s] + ([stdin_fd] if stdin_open else [])',
    '    r, _, _ = select.select(rlist, [], [])',
    '    if stdin_open and stdin_fd in r:',
    '        data = os.read(stdin_fd, 65536)',
    '        if data:',
    '            s.sendall(data)',
    '        else:',
    '            stdin_open = False',
    '            try:',
    '                s.shutdown(socket.SHUT_WR)',
    '            except OSError:',
    '                pass',
    '    if s in r:',
    '        chunk = s.recv(65536)',
    '        if not chunk:',
    '            break',
    '        out.write(chunk)',
    '        out.flush()',
    '',
].join('\n');
/**
 * The snap launcher (POSIX sh) that Chrome execs as the native host. Bakes the
 * snap-common socket path into PWA_DEBUG_SOCKET and execs /usr/bin/python3 on
 * the relay, forwarding Chrome's argv. Lives under the snap-common host dir so
 * AppArmor permits its exec. Mirrors the node launcher's single-quote safety.
 */
const buildSnapLauncher = (relayPath, socketPath) => {
    if (relayPath.includes("'") || socketPath.includes("'")) {
        throw new Error('snap_host: relayPath/socketPath must not contain single quotes (POSIX shell quoting)');
    }
    return [
        '#!/bin/sh',
        '# pwa-debug snap native messaging host launcher (generated at install time).',
        '# Execs the snap runtime python3 on the byte-relay; node is exec-denied and',
        '# glibc-incompatible under snap confinement.',
        `PWA_DEBUG_SOCKET='${socketPath}'`,
        'export PWA_DEBUG_SOCKET',
        `exec /usr/bin/python3 '${relayPath}' "$@"`,
        '',
    ].join('\n');
};
const atomicWrite = async (path, body, mode) => {
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, body, 'utf-8');
    await rename(tmp, path);
    await chmod(path, mode);
};
/**
 * Install the snap native-messaging host files under ~/snap/<pkg>/common/pwa-debug:
 * the python relay (0644) and the launcher that execs it with the snap socket
 * baked in (0755). Returns the launcher path (the snap manifest's `path` target)
 * + the socket path, or null when HOME is unset. The only impure function here;
 * the install orchestrator composes it with the manifest writer.
 */
const writeSnapHostFiles = async (snapPackage, env) => {
    const hostDir = snapHostDir(snapPackage, env);
    const socketPath = snapSocketPath(snapPackage, env);
    if (!hostDir || !socketPath)
        return null;
    const relayPath = join(hostDir, SNAP_RELAY_FILENAME);
    const launcherPath = join(hostDir, SNAP_LAUNCHER_FILENAME);
    await mkdir(hostDir, { recursive: true });
    await atomicWrite(relayPath, buildSnapRelayScript(), 0o644);
    await atomicWrite(launcherPath, buildSnapLauncher(relayPath, socketPath), 0o755);
    return Object.freeze({ launcherPath, relayPath, socketPath });
};
/**
 * Per-installed-snap socket paths the MCP host must ALSO listen on (in addition
 * to the canonical ~/.config socket). A snap is "installed" iff its
 * ~/snap/<pkg>/common dir exists — cheap to check and avoids creating a
 * ~/snap tree for a snap that isn't present. Pure over the injected `exists`.
 */
const installedSnapSocketTargets = async (env, exists) => {
    if (!env.HOME)
        return Object.freeze([]);
    const out = [];
    for (const b of LINUX_SNAP) {
        const common = join(env.HOME, 'snap', b.snapPackage, 'common');
        if (await exists(common)) {
            const socketPath = join(common, 'pwa-debug', SNAP_SOCKET_FILENAME);
            out.push(Object.freeze({
                browser: b.name,
                snapPackage: b.snapPackage,
                socketPath,
            }));
        }
    }
    return Object.freeze(out);
};

function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}

/************************************************************************************************************
 * registry.js - contains a wrapper for the REG command under Windows, which provides access to the registry
 *
 * @author Paul Bottin a/k/a FrEsC
 *
 */

var registry;
var hasRequiredRegistry;

function requireRegistry () {
	if (hasRequiredRegistry) return registry;
	hasRequiredRegistry = 1;
	/* imports */
	var util          = require$$0
	,   path          = require$$1
	,   spawn         = require$$2.spawn

	/* set to console.log for debugging */
	,   HKLM          = 'HKLM'
	,   HKCU          = 'HKCU'
	,   HKCR          = 'HKCR'
	,   HKU           = 'HKU'
	,   HKCC          = 'HKCC'
	,   HIVES         = [ HKLM, HKCU, HKCR, HKU, HKCC ]

	/* registry value type ids */
	,   REG_SZ        = 'REG_SZ'
	,   REG_MULTI_SZ  = 'REG_MULTI_SZ'
	,   REG_EXPAND_SZ = 'REG_EXPAND_SZ'
	,   REG_DWORD     = 'REG_DWORD'
	,   REG_QWORD     = 'REG_QWORD'
	,   REG_BINARY    = 'REG_BINARY'
	,   REG_NONE      = 'REG_NONE'
	,   REG_TYPES     = [ REG_SZ, REG_MULTI_SZ, REG_EXPAND_SZ, REG_DWORD, REG_QWORD, REG_BINARY, REG_NONE ]

	/* default registry value name */
	,   DEFAULT_VALUE = ''

	/* general key pattern */
	,   KEY_PATTERN   = /(\\[a-zA-Z0-9_\s]+)*/

	/* key path pattern (as returned by REG-cli) */
	,   PATH_PATTERN  = /^(HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKEY_CLASSES_ROOT|HKEY_USERS|HKEY_CURRENT_CONFIG)(.*)$/

	/* registry item pattern */
	,   ITEM_PATTERN  = /^(.*)\s(REG_SZ|REG_MULTI_SZ|REG_EXPAND_SZ|REG_DWORD|REG_QWORD|REG_BINARY|REG_NONE)\s+([^\s].*)$/;

	/**
	 * Creates an Error object that contains the exit code of the REG.EXE process.
	 * This contructor is private. Objects of this type are created internally and returned in the <code>err</code> parameters in case the REG.EXE process doesn't exit cleanly.
	 *
	 * @private
	 * @class
	 *
	 * @param {string} message - the error message
	 * @param {number} code - the process exit code
	 *
	 */
	function ProcessUncleanExitError(message, code) {
	  if (!(this instanceof ProcessUncleanExitError))
	    return new ProcessUncleanExitError(message, code);

	  Error.captureStackTrace(this, ProcessUncleanExitError);

	  /**
	   * The error name.
	   * @readonly
	   * @member {string} ProcessUncleanExitError#name
	   */
	  this.__defineGetter__('name', function () { return ProcessUncleanExitError.name; });

	  /**
	   * The error message.
	   * @readonly
	   * @member {string} ProcessUncleanExitError#message
	   */
	  this.__defineGetter__('message', function () { return message; });

	  /**
	   * The process exit code.
	   * @readonly
	   * @member {number} ProcessUncleanExitError#code
	   */
	  this.__defineGetter__('code', function () { return code; });

	}

	util.inherits(ProcessUncleanExitError, Error);

	/*
	 * Captures stdout/stderr for a child process
	 */
	function captureOutput(child) {
	  // Use a mutable data structure so we can append as we get new data and have
	  // the calling context see the new data
	  var output = {'stdout': '', 'stderr': ''};

	  child.stdout.on('data', function(data) { output["stdout"] += data.toString(); });
	  child.stderr.on('data', function(data) { output["stderr"] += data.toString(); });

	  return output;
	}


	/*
	 * Returns an error message containing the stdout/stderr of the child process
	 */
	function mkErrorMsg(registryCommand, code, output) {
	    var stdout = output['stdout'].trim();
	    var stderr = output['stderr'].trim();

	    var msg = util.format("%s command exited with code %d:\n%s\n%s", registryCommand, code, stdout, stderr);
	    return new ProcessUncleanExitError(msg, code);
	}


	/*
	 * Converts x86/x64 to 32/64
	 */
	function convertArchString(archString) {
	  if (archString == 'x64') {
	    return '64';
	  } else if (archString == 'x86') {
	    return '32';
	  } else {
	    throw new Error('illegal architecture: ' + archString + ' (use x86 or x64)');
	  }
	}


	/*
	 * Adds correct architecture to reg args
	 */
	function pushArch(args, arch) {
	  if (arch) {
	    args.push('/reg:' + convertArchString(arch));
	  }
	}

	/*
	 * Get the path to system's reg.exe. Useful when another reg.exe is added to the PATH
	 * Implemented only for Windows
	 */
	function getRegExePath() {
	    if (process.platform === 'win32') {
	        return path.join(process.env.windir, 'system32', 'reg.exe');
	    } else {
	        return "REG";
	    }
	}


	/**
	 * Creates a single registry value record.
	 * This contructor is private. Objects of this type are created internally and returned by methods of {@link Registry} objects.
	 *
	 * @private
	 * @class
	 *
	 * @param {string} host - the hostname
	 * @param {string} hive - the hive id
	 * @param {string} key - the registry key
	 * @param {string} name - the value name
	 * @param {string} type - the value type
	 * @param {string} value - the value
	 * @param {string} arch - the hive architecture ('x86' or 'x64')
	 *
	 */
	function RegistryItem (host, hive, key, name, type, value, arch) {

	  if (!(this instanceof RegistryItem))
	    return new RegistryItem(host, hive, key, name, type, value, arch);

	  /* private members */
	  var _host = host    // hostname
	  ,   _hive = hive    // registry hive
	  ,   _key = key      // registry key
	  ,   _name = name    // property name
	  ,   _type = type    // property type
	  ,   _value = value  // property value
	  ,   _arch = arch;    // hive architecture

	  /* getters/setters */

	  /**
	   * The hostname.
	   * @readonly
	   * @member {string} RegistryItem#host
	   */
	  this.__defineGetter__('host', function () { return _host; });

	  /**
	   * The hive id.
	   * @readonly
	   * @member {string} RegistryItem#hive
	   */
	  this.__defineGetter__('hive', function () { return _hive; });

	  /**
	   * The registry key.
	   * @readonly
	   * @member {string} RegistryItem#key
	   */
	  this.__defineGetter__('key', function () { return _key; });

	  /**
	   * The value name.
	   * @readonly
	   * @member {string} RegistryItem#name
	   */
	  this.__defineGetter__('name', function () { return _name; });

	  /**
	   * The value type.
	   * @readonly
	   * @member {string} RegistryItem#type
	   */
	  this.__defineGetter__('type', function () { return _type; });

	  /**
	   * The value.
	   * @readonly
	   * @member {string} RegistryItem#value
	   */
	  this.__defineGetter__('value', function () { return _value; });

	  /**
	   * The hive architecture.
	   * @readonly
	   * @member {string} RegistryItem#arch
	   */
	  this.__defineGetter__('arch', function () { return _arch; });

	}

	util.inherits(RegistryItem, Object);

	/**
	 * Creates a registry object, which provides access to a single registry key.
	 * Note: This class is returned by a call to ```require('winreg')```.
	 *
	 * @public
	 * @class
	 *
	 * @param {object} options - the options
	 * @param {string=} options.host - the hostname
	 * @param {string=} options.hive - the hive id
	 * @param {string=} options.key - the registry key
	 * @param {string=} options.arch - the optional registry hive architecture ('x86' or 'x64'; only valid on Windows 64 Bit Operating Systems)
	 *
	 * @example
	 * var Registry = require('winreg')
	 * ,   autoStartCurrentUser = new Registry({
	 *       hive: Registry.HKCU,
	 *       key:  '\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
	 *     });
	 *
	 */
	function Registry (options) {

	  if (!(this instanceof Registry))
	    return new Registry(options);

	  /* private members */
	  var _options = options || {}
	  ,   _host = '' + (_options.host || '')    // hostname
	  ,   _hive = '' + (_options.hive || HKLM)  // registry hive
	  ,   _key  = '' + (_options.key  || '')    // registry key
	  ,   _arch = _options.arch || null;         // hive architecture

	  /* getters/setters */

	  /**
	   * The hostname.
	   * @readonly
	   * @member {string} Registry#host
	   */
	  this.__defineGetter__('host', function () { return _host; });

	  /**
	   * The hive id.
	   * @readonly
	   * @member {string} Registry#hive
	   */
	  this.__defineGetter__('hive', function () { return _hive; });

	  /**
	   * The registry key name.
	   * @readonly
	   * @member {string} Registry#key
	   */
	  this.__defineGetter__('key', function () { return _key; });

	  /**
	   * The full path to the registry key.
	   * @readonly
	   * @member {string} Registry#path
	   */
	  this.__defineGetter__('path', function () { return '"' + (_host.length == 0 ? '' : '\\\\' + _host + '\\') + _hive + _key + '"'; });

	  /**
	   * The registry hive architecture ('x86' or 'x64').
	   * @readonly
	   * @member {string} Registry#arch
	   */
	  this.__defineGetter__('arch', function () { return _arch; });

	  /**
	   * Creates a new {@link Registry} instance that points to the parent registry key.
	   * @readonly
	   * @member {Registry} Registry#parent
	   */
	  this.__defineGetter__('parent', function () {
	    var i = _key.lastIndexOf('\\');
	    return new Registry({
	      host: this.host,
	      hive: this.hive,
	      key:  (i == -1)?'':_key.substring(0, i),
	      arch: this.arch
	    });
	  });

	  // validate options...
	  if (HIVES.indexOf(_hive) == -1)
	    throw new Error('illegal hive specified.');

	  if (!KEY_PATTERN.test(_key))
	    throw new Error('illegal key specified.');

	  if (_arch && _arch != 'x64' && _arch != 'x86')
	    throw new Error('illegal architecture specified (use x86 or x64)');

	}

	/**
	 * Registry hive key HKEY_LOCAL_MACHINE.
	 * Note: For writing to this hive your program has to run with admin privileges.
	 * @type {string}
	 */
	Registry.HKLM = HKLM;

	/**
	 * Registry hive key HKEY_CURRENT_USER.
	 * @type {string}
	 */
	Registry.HKCU = HKCU;

	/**
	 * Registry hive key HKEY_CLASSES_ROOT.
	 * Note: For writing to this hive your program has to run with admin privileges.
	 * @type {string}
	 */
	Registry.HKCR = HKCR;

	/**
	 * Registry hive key HKEY_USERS.
	 * Note: For writing to this hive your program has to run with admin privileges.
	 * @type {string}
	 */
	Registry.HKU = HKU;

	/**
	 * Registry hive key HKEY_CURRENT_CONFIG.
	 * Note: For writing to this hive your program has to run with admin privileges.
	 * @type {string}
	 */
	Registry.HKCC = HKCC;

	/**
	 * Collection of available registry hive keys.
	 * @type {array}
	 */
	Registry.HIVES = HIVES;

	/**
	 * Registry value type STRING.
	 * @type {string}
	 */
	Registry.REG_SZ = REG_SZ;

	/**
	 * Registry value type MULTILINE_STRING.
	 * @type {string}
	 */
	Registry.REG_MULTI_SZ = REG_MULTI_SZ;

	/**
	 * Registry value type EXPANDABLE_STRING.
	 * @type {string}
	 */
	Registry.REG_EXPAND_SZ = REG_EXPAND_SZ;

	/**
	 * Registry value type DOUBLE_WORD.
	 * @type {string}
	 */
	Registry.REG_DWORD = REG_DWORD;

	/**
	 * Registry value type QUAD_WORD.
	 * @type {string}
	 */
	Registry.REG_QWORD = REG_QWORD;

	/**
	 * Registry value type BINARY.
	 * @type {string}
	 */
	Registry.REG_BINARY = REG_BINARY;

	/**
	 * Registry value type UNKNOWN.
	 * @type {string}
	 */
	Registry.REG_NONE = REG_NONE;

	/**
	 * Collection of available registry value types.
	 * @type {array}
	 */
	Registry.REG_TYPES = REG_TYPES;

	/**
	 * The name of the default value. May be used instead of the empty string literal for better readability.
	 * @type {string}
	 */
	Registry.DEFAULT_VALUE = DEFAULT_VALUE;

	/**
	 * Retrieve all values from this registry key.
	 * @param {valuesCallback} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @param {array=} cb.items - an array of {@link RegistryItem} objects
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.values = function values (cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = [ 'QUERY', this.path ];

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        shell: true,
	        windowsHide: true,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   buffer = ''
	  ,   self = this
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if (error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('QUERY', code, output), null);
	    } else {
	      var items = []
	      ,   result = []
	      ,   lines = buffer.split('\n')
	      ,   lineNumber = 0;

	      for (var i = 0, l = lines.length; i < l; i++) {
	        var line = lines[i].trim();
	        if (line.length > 0) {
	          if (lineNumber != 0) {
	            items.push(line);
	          }
	          ++lineNumber;
	        }
	      }

	      for (var i = 0, l = items.length; i < l; i++) {

	        var match = ITEM_PATTERN.exec(items[i])
	        ,   name
	        ,   type
	        ,   value;

	        if (match) {
	          name = match[1].trim();
	          type = match[2].trim();
	          value = match[3];
	          result.push(new RegistryItem(self.host, self.hive, self.key, name, type, value, self.arch));
	        }
	      }

	      cb(null, result);

	    }
	  });

	  proc.stdout.on('data', function (data) {
	    buffer += data.toString();
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Retrieve all subkeys from this registry key.
	 * @param {function (err, items)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @param {array=} cb.items - an array of {@link Registry} objects
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.keys = function keys (cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = [ 'QUERY', this.path ];

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        shell: true,
	        windowsHide: true,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   buffer = ''
	  ,   self = this
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if (error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('QUERY', code, output), null);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	    buffer += data.toString();
	  });

	  proc.stdout.on('end', function () {

	    var items = []
	    ,   result = []
	    ,   lines = buffer.split('\n');

	    for (var i = 0, l = lines.length; i < l; i++) {
	      var line = lines[i].trim();
	      if (line.length > 0) {
	        items.push(line);
	      }
	    }

	    for (var i = 0, l = items.length; i < l; i++) {

	      var match = PATH_PATTERN.exec(items[i])
	      ,   key;

	      if (match) {
	        match[1];
	        key  = match[2];
	        if (key && (key !== self.key)) {
	          result.push(new Registry({
	            host: self.host,
	            hive: self.hive,
	            key:  key,
	            arch: self.arch
	          }));
	        }
	      }
	    }

	    cb(null, result);

	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Gets a named value from this registry key.
	 * @param {string} name - the value name, use {@link Registry.DEFAULT_VALUE} or an empty string for the default value
	 * @param {function (err, item)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @param {RegistryItem=} cb.item - the retrieved registry item
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.get = function get (name, cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = ['QUERY', this.path];
	  if (name == '')
	    args.push('/ve');
	  else
	    args = args.concat(['/v', name]);

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        shell: true,
	        windowsHide: true,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   buffer = ''
	  ,   self = this
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if (error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('QUERY', code, output), null);
	    } else {
	      var items = []
	      ,   result = null
	      ,   lines = buffer.split('\n')
	      ,   lineNumber = 0;

	      for (var i = 0, l = lines.length; i < l; i++) {
	        var line = lines[i].trim();
	        if (line.length > 0) {
	          if (lineNumber != 0) {
	             items.push(line);
	          }
	          ++lineNumber;
	        }
	      }

	      //Get last item - so it works in XP where REG QUERY returns with a header
	      var item = items[items.length-1] || ''
	      ,   match = ITEM_PATTERN.exec(item)
	      ,   name
	      ,   type
	      ,   value;

	      if (match) {
	        name = match[1].trim();
	        type = match[2].trim();
	        value = match[3];
	        result = new RegistryItem(self.host, self.hive, self.key, name, type, value, self.arch);
	      }

	      cb(null, result);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	    buffer += data.toString();
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Sets a named value in this registry key, overwriting an already existing value.
	 * @param {string} name - the value name, use {@link Registry.DEFAULT_VALUE} or an empty string for the default value
	 * @param {string} type - the value type
	 * @param {string} value - the value
	 * @param {function (err)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.set = function set (name, type, value, cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  if (REG_TYPES.indexOf(type) == -1)
	    throw Error('illegal type specified.');

	  var args = ['ADD', this.path];
	  if (name == '')
	    args.push('/ve');
	  else
	    args = args.concat(['/v', name]);

	  args = args.concat(['/t', type, '/d', value, '/f']);

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        shell: true,
	        windowsHide: true,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if(error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('ADD', code, output));
	    } else {
	      cb(null);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Remove a named value from this registry key. If name is empty, sets the default value of this key.
	 * Note: This key must be already existing.
	 * @param {string} name - the value name, use {@link Registry.DEFAULT_VALUE} or an empty string for the default value
	 * @param {function (err)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.remove = function remove (name, cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = name ? ['DELETE', this.path, '/f', '/v', name] : ['DELETE', this.path, '/f', '/ve'];

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        shell: true,
	        windowsHide: true,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if(error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('DELETE', code, output), null);
	    } else {
	      cb(null);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Remove all subkeys and values (including the default value) from this registry key.
	 * @param {function (err)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.clear = function clear (cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = ['DELETE', this.path, '/f', '/va'];

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        shell: true,
	        windowsHide: true,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if(error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg("DELETE", code, output), null);
	    } else {
	      cb(null);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Alias for the clear method to keep it backward compatible.
	 * @method
	 * @deprecated Use {@link Registry#clear} or {@link Registry#destroy} in favour of this method.
	 * @param {function (err)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.erase = Registry.prototype.clear;

	/**
	 * Delete this key and all subkeys from the registry.
	 * @param {function (err)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.destroy = function destroy (cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = ['DELETE', this.path, '/f'];

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        shell: true,
	        windowsHide: true,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if (error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('DELETE', code, output), null);
	    } else {
	      cb(null);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Create this registry key. Note that this is a no-op if the key already exists.
	 * @param {function (err)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.create = function create (cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = ['ADD', this.path, '/f'];

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        shell: true,
	        windowsHide: true,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if (error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('ADD', code, output), null);
	    } else {
	      cb(null);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Checks if this key already exists.
	 * @param {function (err, exists)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @param {boolean=} cb.exists - true if a registry key with this name already exists
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.keyExists = function keyExists (cb) {

	  this.values(function (err, items) {
	    if (err) {
	      // process should return with code 1 if key not found
	      if (err.code == 1) {
	        return cb(null, false);
	      }
	      // other error
	      return cb(err);
	    }
	    cb(null, true);
	  });

	  return this;
	};

	/**
	 * Checks if a value with the given name already exists within this key.
	 * @param {string} name - the value name, use {@link Registry.DEFAULT_VALUE} or an empty string for the default value
	 * @param {function (err, exists)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @param {boolean=} cb.exists - true if a value with the given name was found in this key
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.valueExists = function valueExists (name, cb) {

	  this.get(name, function (err, item) {
	    if (err) {
	      // process should return with code 1 if value not found
	      if (err.code == 1) {
	        return cb(null, false);
	      }
	      // other error
	      return cb(err);
	    }
	    cb(null, true);
	  });

	  return this;
	};

	registry = Registry;
	return registry;
}

var registryExports = requireRegistry();
var Registry = /*@__PURE__*/getDefaultExportFromCjs(registryExports);

const ensureLeadingBackslash = (key) => key.startsWith('\\') ? key : `\\${key}`;
const defaultRegistryGateway = () => Object.freeze({
    setDefault: (hive, subkey, valueData) => new Promise((resolve, reject) => {
        const reg = new Registry({ hive, key: ensureLeadingBackslash(subkey) });
        reg.create((createErr) => {
            if (createErr)
                return reject(createErr);
            reg.set('', Registry.REG_SZ, valueData, (setErr) => {
                if (setErr)
                    return reject(setErr);
                resolve();
            });
        });
    }),
    removeKey: (hive, subkey) => new Promise((resolve, reject) => {
        const reg = new Registry({ hive, key: ensureLeadingBackslash(subkey) });
        reg.keyExists((existsErr, exists) => {
            if (existsErr)
                return reject(existsErr);
            if (!exists)
                return resolve();
            reg.destroy((destroyErr) => {
                if (destroyErr)
                    return reject(destroyErr);
                resolve();
            });
        });
    }),
});
const defaultRegistryJsonPath = (env, manifestName) => {
    const appdata = env.APPDATA && env.APPDATA.length > 0
        ? env.APPDATA
        : env.USERPROFILE && env.USERPROFILE.length > 0
            ? join(env.USERPROFILE, 'AppData', 'Roaming')
            : null;
    if (!appdata) {
        throw new Error('registry_writer: APPDATA and USERPROFILE both unset on win32');
    }
    return join(appdata, 'pwa-debug', `${manifestName}.json`);
};

const fileExists$3 = async (p) => {
    try {
        await stat(p);
        return true;
    }
    catch {
        return false;
    }
};
const installCaveatLines = (installs) => installs
    .filter((i) => i.kind !== 'registry' && i.caveat)
    .map((i) => `${i.browser} (${i.kind}): ${i.caveat}`);
const dedupe$2 = (xs) => [...new Set(xs)];
const inputSchema$V = { extension_id: stringType().min(1) };
const hostRegisterExtensionHandler = async (args) => {
    try {
        const statePath = defaultStatePath();
        const before = await loadHostState(statePath);
        const after = addExtensionId(before, args.extension_id);
        const added = after !== before;
        const installs = await detectBrowserInstalls(process.env, process.platform, fileExists$3);
        if (installs.length === 0) {
            return errorResponse('No Chromium-family browser detected on this machine.', [
                'Verify a Chromium-family browser (Chrome, Chromium, Edge, Brave, Vivaldi, Opera) is installed and has been launched at least once. Detection covers Linux native packages, Linux snap, Linux flatpak, macOS Application Support, and Windows HKCU registry vendors.',
            ]);
        }
        const mainJsPath = process.argv[1] ?? '';
        if (mainJsPath === '') {
            return errorResponse('host_register_extension: cannot determine bundled main.js path (process.argv[1] is empty).', [
                'This usually means the host was not started as `node /path/to/dist/main.js`. Verify your Claude Code MCP config points at the host binary directly.',
            ]);
        }
        const launcherPath = defaultLauncherPath(process.platform, process.env);
        // Resolve the socket path HERE, in the unconfined MCP host process whose
        // env matches the listening socket (mcp_mode resolves it the same way), and
        // bake it into the canonical (node) launcher. A flatpak-spawned NMH then
        // connects to the real socket instead of an XDG path remapped by
        // confinement. Snap is handled separately below (node is exec-denied +
        // glibc-incompatible under snap), so the canonical launcher serves
        // native + flatpak.
        const socketPath = defaultSocketPath(process.env, process.platform);
        await writeLauncher(process.platform, { nodePath: process.execPath, mainJsPath, socketPath }, launcherPath);
        const manifest = buildHostManifest({
            name: HOST_NAME$3,
            description: HOST_DESCRIPTION$1,
            hostBinaryPath: launcherPath,
            allowedExtensionIds: after.extensionIds,
        });
        // Snap installs need a DIFFERENT host: a python3 byte-relay under
        // ~/snap/<pkg>/common (AppArmor-exec-allowed, snap-glibc-compatible)
        // connecting to a snap-common socket the host also listens on. Their
        // manifest `path` points at that relay launcher, not the canonical one.
        const snapInstalls = installs.filter((i) => i.kind === 'snap');
        const nonSnapInstalls = installs.filter((i) => i.kind !== 'snap');
        const hasRegistry = nonSnapInstalls.some((i) => i.kind === 'registry');
        const options = hasRegistry
            ? {
                registryJsonPath: defaultRegistryJsonPath(process.env, HOST_NAME$3),
                registry: defaultRegistryGateway(),
            }
            : {};
        const writes = await installManifestForBrowsers(manifest, nonSnapInstalls, options);
        const snapWrites = [];
        for (const si of snapInstalls) {
            if (si.snapPackage === undefined)
                continue;
            const snapHost = await writeSnapHostFiles(si.snapPackage, process.env);
            if (!snapHost)
                continue;
            const snapManifest = buildHostManifest({
                name: HOST_NAME$3,
                description: HOST_DESCRIPTION$1,
                hostBinaryPath: snapHost.launcherPath,
                allowedExtensionIds: after.extensionIds,
            });
            const manifestPath = await writeHostManifestToDir(snapManifest, si.manifestDir);
            snapWrites.push(Object.freeze({ browser: si.browser, kind: 'snap', manifestPath }));
        }
        const allWrites = [...writes, ...snapWrites];
        const written = dedupe$2(allWrites.map((w) => w.manifestPath));
        const final = setManifestPaths({ ...after, lastUpdated: new Date().toISOString() }, written);
        await saveHostState(statePath, final);
        const data = {
            added,
            allRegisteredIds: [...final.extensionIds],
            manifestPathsWritten: written,
            installs: allWrites.map((w) => ({
                browser: w.browser,
                kind: w.kind,
                manifestPath: w.manifestPath,
                registrySubkey: w.registrySubkey,
            })),
            launcherPath,
            requiresReload: added,
            detectedBrowsers: installs.map((i) => i.browser),
        };
        const next_steps = [];
        if (added) {
            next_steps.push('New extension ID registered. Tell the user: "Reload the PWA Debug Layer extension at chrome://extensions (click the circular reload icon on its card)" so Chrome re-reads allowed_origins.');
            next_steps.push('After ~3s, call host_status to confirm the manifestPathsOnDisk list includes the written path and that activeConnections shows the NMH instance once the user has reloaded the extension. Then call session_ping for an end-to-end round-trip check.');
        }
        else {
            next_steps.push('Extension ID was already registered; manifest rewritten with the same allowed_origins. No reload needed unless the extension is also showing as not-yet-connected.');
        }
        for (const line of installCaveatLines(installs))
            next_steps.push(line);
        return okResponse(data, next_steps);
    }
    catch (err) {
        return errorResponse(`host_register_extension failed: ${err.message}`, [
            'Filesystem or registry error during install. Check write permissions on the per-browser NativeMessagingHosts directories (POSIX), %APPDATA%\\pwa-debug (Windows), or HKCU registry access (Windows).',
        ]);
    }
};
const hostRegisterExtensionTool = Object.freeze({
    name: 'host_register_extension',
    description: "Registers an extension ID as an allowed origin for the pwa-debug native messaging host. Detects every Chromium-family install on this machine — Linux native packages, Linux snap (Chromium), Linux flatpak (any vendor), macOS Application Support, Windows HKCU registry — and writes the host manifest into each one. Also drops an install-time launcher script (POSIX sh / Windows .bat) that embeds an absolute node path so the host spawns correctly under sandboxed/stripped PATH (snap, flatpak). Idempotent. ID DISCOVERY: read the pwa-debug service-worker console via chrome-devtools-mcp — the SW logs `[pwa-debug/sw] id=<id>` on every boot. NEVER invent an ID. After this returns requiresReload:true, the user must reload the extension at chrome://extensions for Chrome to re-validate allowed_origins. If next_steps mentions a flatpak caveat, surface it to the user verbatim.",
    inputSchema: inputSchema$V,
    handler: hostRegisterExtensionHandler,
});

const HOST_NAME$2 = 'com.pwa_debug.host';
const HOST_DESCRIPTION = 'PWA Debug Layer native messaging host';
const fileExists$2 = async (p) => {
    try {
        await stat(p);
        return true;
    }
    catch {
        return false;
    }
};
const dedupe$1 = (xs) => [...new Set(xs)];
const inputSchema$U = { extension_id: stringType().min(1) };
const hostUnregisterExtensionHandler = async (args) => {
    try {
        const statePath = defaultStatePath();
        const before = await loadHostState(statePath);
        const after = removeExtensionId(before, args.extension_id);
        const removed = after !== before;
        if (!removed) {
            return okResponse({
                removed: false,
                remainingIds: [...before.extensionIds],
                manifestPathsDeleted: [],
                manifestPathsRewritten: [],
            }, [
                'Extension ID was not registered; no-op. Call host_list_registrations to see what is currently registered.',
            ]);
        }
        const installs = await detectBrowserInstalls(process.env, process.platform, fileExists$2);
        const hasRegistry = installs.some((i) => i.kind === 'registry');
        const registryOptions = hasRegistry
            ? {
                registryJsonPath: defaultRegistryJsonPath(process.env, HOST_NAME$2),
                registry: defaultRegistryGateway(),
            }
            : {};
        if (after.extensionIds.length === 0) {
            const removedWrites = await uninstallManifestForBrowsers(HOST_NAME$2, installs, registryOptions);
            const final = setManifestPaths({ ...after, lastUpdated: new Date().toISOString() }, []);
            await saveHostState(statePath, final);
            return okResponse({
                removed: true,
                remainingIds: [],
                manifestPathsDeleted: dedupe$1(removedWrites.map((w) => w.manifestPath)),
                manifestPathsRewritten: [],
                installs: removedWrites.map((w) => ({
                    browser: w.browser,
                    kind: w.kind,
                    manifestPath: w.manifestPath,
                    registrySubkey: w.registrySubkey,
                })),
            }, [
                'Last registration removed; per-browser host manifests deleted (and Windows HKCU keys cleared). The host is fully uninstalled. Future pwa-debug tool calls will surface "no extensions registered" until host_register_extension is called again.',
            ]);
        }
        const mainJsPath = process.argv[1] ?? '';
        if (mainJsPath === '') {
            return errorResponse('host_unregister_extension: cannot determine bundled main.js path (process.argv[1] is empty).', []);
        }
        const launcherPath = defaultLauncherPath(process.platform, process.env);
        await writeLauncher(process.platform, { nodePath: process.execPath, mainJsPath }, launcherPath);
        const manifest = buildHostManifest({
            name: HOST_NAME$2,
            description: HOST_DESCRIPTION,
            hostBinaryPath: launcherPath,
            allowedExtensionIds: after.extensionIds,
        });
        const writes = await installManifestForBrowsers(manifest, installs, registryOptions);
        const written = dedupe$1(writes.map((w) => w.manifestPath));
        const final = setManifestPaths({ ...after, lastUpdated: new Date().toISOString() }, written);
        await saveHostState(statePath, final);
        return okResponse({
            removed: true,
            remainingIds: [...after.extensionIds],
            manifestPathsDeleted: [],
            manifestPathsRewritten: written,
            installs: writes.map((w) => ({
                browser: w.browser,
                kind: w.kind,
                manifestPath: w.manifestPath,
                registrySubkey: w.registrySubkey,
            })),
        }, [
            'Extension ID removed; manifest rewritten with the remaining IDs in allowed_origins. The other extensions remain functional.',
        ]);
    }
    catch (err) {
        return errorResponse(`host_unregister_extension failed: ${err.message}`, [
            'Filesystem or registry error during unregister. Check write permissions on per-browser NativeMessagingHosts dirs (POSIX), %APPDATA%\\pwa-debug (Windows), and HKCU registry access (Windows).',
        ]);
    }
};
const hostUnregisterExtensionTool = Object.freeze({
    name: 'host_unregister_extension',
    description: "Removes an extension ID from the pwa-debug host manifest allowed_origins. If at least one ID remains, manifests are rewritten with the new union; if the last ID is removed, manifests are deleted entirely (Windows HKCU keys cleared too). Use to recycle stale IDs after a manifest key change in dev. Idempotent: removing an already-absent ID returns removed:false with no side effects.",
    inputSchema: inputSchema$U,
    handler: hostUnregisterExtensionHandler,
});

const hostListRegistrationsHandler = async () => {
    try {
        const state = await loadHostState(defaultStatePath());
        return okResponse({ extensionIds: [...state.extensionIds] }, state.extensionIds.length === 0
            ? [
                'No extension IDs registered. Use chrome-devtools-mcp to read the pwa-debug SW console for `[pwa-debug/sw] id=<id>`, then call host_register_extension.',
            ]
            : [
                'For full setup state including manifest paths and (eventually) active connections, call host_status.',
            ]);
    }
    catch (err) {
        return errorResponse(`host_list_registrations failed: ${err.message}`, ['Filesystem error reading state. Check ~/.config/pwa-debug/state.json.']);
    }
};
const hostListRegistrationsTool = Object.freeze({
    name: 'host_list_registrations',
    description: 'Lists registered extension IDs from the host state file. Cheap read-only view; does NOT verify that manifests are on disk or that any extension is connected. For the full setup picture, prefer host_status.',
    inputSchema: {},
    handler: hostListRegistrationsHandler,
});

const HOST_NAME$1 = 'com.pwa_debug.host';
const fileExists$1 = async (p) => {
    try {
        await stat(p);
        return true;
    }
    catch {
        return false;
    }
};
const dedupe = (xs) => [...new Set(xs)];
const inputSchema$T = { confirm: literalType('reset') };
const hostResetHandler = async (_args) => {
    try {
        const statePath = defaultStatePath();
        const before = await loadHostState(statePath);
        const installs = await detectBrowserInstalls(process.env, process.platform, fileExists$1);
        const hasRegistry = installs.some((i) => i.kind === 'registry');
        const registryOptions = hasRegistry
            ? {
                registryJsonPath: defaultRegistryJsonPath(process.env, HOST_NAME$1),
                registry: defaultRegistryGateway(),
            }
            : {};
        const removedWrites = await uninstallManifestForBrowsers(HOST_NAME$1, installs, registryOptions);
        await saveHostState(statePath, {
            ...EMPTY_STATE,
            lastUpdated: new Date().toISOString(),
        });
        return okResponse({
            idsRemoved: [...before.extensionIds],
            pathsDeleted: dedupe(removedWrites.map((w) => w.manifestPath)),
            installs: removedWrites.map((w) => ({
                browser: w.browser,
                kind: w.kind,
                manifestPath: w.manifestPath,
                registrySubkey: w.registrySubkey,
            })),
        }, [
            'All registrations cleared and host manifests deleted (Windows HKCU keys cleared too). Inform the user that any previously connected extensions will lose connectivity.',
            'To re-bootstrap, call host_register_extension with the desired extension ID.',
        ]);
    }
    catch (err) {
        return errorResponse(`host_reset failed: ${err.message}`, [
            'Filesystem or registry error during reset. Check write permissions on ~/.config/pwa-debug/, the per-browser NativeMessagingHosts dirs, %APPDATA%\\pwa-debug, and HKCU registry access.',
        ]);
    }
};
const hostResetTool = Object.freeze({
    name: 'host_reset',
    description: 'DESTRUCTIVE: removes ALL registered extension IDs and deletes every per-browser host manifest (POSIX files + Windows HKCU keys + the shared %APPDATA% manifest JSON). Requires confirm:"reset" to invoke (a typed safety guard). Inform the user before calling. Use only when starting setup from scratch.',
    inputSchema: inputSchema$T,
    handler: hostResetHandler,
});

const resolveTarget$1 = (ctx, argId) => {
    const conns = ctx.ipcServer.listConnections();
    if (argId !== undefined) {
        const found = conns.find((c) => c.extensionId === argId);
        if (!found) {
            return {
                ok: false,
                error: `no connected NMH for extension_id=${argId}`,
            };
        }
        return { ok: true, extensionId: argId };
    }
    if (conns.length === 0) {
        return { ok: false, error: 'no NMH connected' };
    }
    if (conns.length > 1) {
        return {
            ok: false,
            error: `multiple NMH connections (${conns.length}); pass extension_id explicitly`,
        };
    }
    return { ok: true, extensionId: conns[0].extensionId };
};

const SESSION_PING_TIMEOUT_MS = 5000;
const inputSchema$S = {
    extension_id: stringType().min(1).optional(),
};
const PAGE_WORLD_ERROR_CODES = new Set([
    'cs_not_attached_refresh_tab',
    'page_blocks_scripts',
    'page_world_blocked',
    'restricted_url',
    'no_active_tab',
    'cs_inject_failed',
]);
const NEXT_STEPS_BY_CODE = Object.freeze({
    cs_not_attached_refresh_tab: [
        "The page-world bridge is not responding even after the extension auto-injected its content scripts. The auto-recovery did not stick — the page may have rejected the injection silently or reloaded mid-flight.",
        "Ask the user to hard-refresh the page tab (Ctrl+Shift+R) and retry session_ping. If the problem repeats, ask them to reload the extension at chrome://extensions and then hard-refresh the page.",
    ],
    page_blocks_scripts: [
        "The site is blocking the pwa-debug content script. A content blocker is rejecting it.",
        "If the user is on Brave: ask them to click the lion icon in the address bar, set Shields to 'Down' for this site, refresh the page, and retry session_ping.",
        "If the user has uBlock Origin or a similar blocker: ask them to disable it for this site, refresh, and retry. If neither, the site's own CSP is blocking and pwa-debug cannot bypass it — inform the user this origin is unscriptable.",
    ],
    page_world_blocked: [
        "The content script attached but the MAIN-world page-world bridge cannot be reached. The site's Content-Security-Policy most likely blocks the inline script tag the bridge needs.",
        "Inform the user that this site's CSP prevents page-world introspection. pwa-debug cannot bypass site CSP. Console + network capture may still work via the content-script side, but live page-world reads (component state, store snapshots, evaluate) will not.",
    ],
    restricted_url: [
        "The current tab is on a URL that browsers do not allow extensions to touch (chrome://, the Web Store, about:, devtools://, file://, etc.).",
        "Ask the user to switch focus to a regular http(s) tab of the PWA they want to debug, then retry session_ping.",
    ],
    no_active_tab: [
        "No active http(s) tab is focused.",
        "Ask the user to focus a regular browser tab (not DevTools, not the extension popup) and retry session_ping.",
    ],
    cs_inject_failed: [
        "The auto-recovery injection (chrome.scripting.executeScript) itself failed. The extension cannot reach this tab.",
        "Ask the user to reload the extension at chrome://extensions and hard-refresh the page tab (Ctrl+Shift+R), then retry session_ping. If the problem persists, the tab may be on a URL the browser blocks all extensions from — ask the user what URL is in the address bar.",
    ],
});
const isPageWorldErrorCode = (v) => typeof v === 'string' && PAGE_WORLD_ERROR_CODES.has(v);
const readPayloadString = (payload, key) => {
    if (payload === null || typeof payload !== 'object')
        return null;
    const v = payload[key];
    return typeof v === 'string' ? v : null;
};
const readPayloadNumber = (payload, key) => {
    if (payload === null || typeof payload !== 'object')
        return null;
    const v = payload[key];
    return typeof v === 'number' ? v : null;
};
const readPayloadBoolean = (payload, key) => {
    if (payload === null || typeof payload !== 'object')
        return false;
    const v = payload[key];
    return v === true;
};
const readPageWorldErrorCode = (payload) => {
    const raw = readPayloadString(payload, 'pageWorldError');
    return raw !== null && isPageWorldErrorCode(raw) ? raw : null;
};
const readPageWorld = (payload) => {
    if (payload === null || typeof payload !== 'object')
        return null;
    const v = payload['pageWorld'];
    if (v === null || v === undefined)
        return null;
    if (typeof v !== 'object')
        return null;
    const obj = v;
    const url = obj['url'];
    const title = obj['title'];
    const readyState = obj['readyState'];
    if (typeof url !== 'string')
        return null;
    if (typeof title !== 'string')
        return null;
    if (readyState !== 'loading' &&
        readyState !== 'interactive' &&
        readyState !== 'complete') {
        return null;
    }
    return Object.freeze({ url, title, readyState });
};
const buildNextSteps = (pageWorld, pageWorldError, selfHealed) => {
    const steps = [
        'Round-trip MCP→IPC→NMH→SW→CS→page-world completed. extensionVersion and attachedTabId reflect the SW response; pageWorld carries url/title/readyState read from the active tab. If pageWorld is null and pageWorldError is set, the SW round-trip succeeded but the page-bridge half failed — see the next hint.',
    ];
    if (selfHealed && pageWorld !== null) {
        steps.push('pageWorldSelfHealed:true — the content script was missing on the active tab (loaded before the extension reload) and the SW auto-injected it via chrome.scripting.executeScript. No user action needed; just informational.');
    }
    if (pageWorldError !== null) {
        for (const hint of NEXT_STEPS_BY_CODE[pageWorldError])
            steps.push(hint);
    }
    else if (pageWorld === null) {
        steps.push('pageWorld is null but no typed pageWorldError was returned. This is unexpected — inspect the SW console for [pwa-debug] errors. The SW response payload may be malformed.');
    }
    return steps;
};
const sessionPingHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension at chrome://extensions so Chrome respawns the NMH.',
        ]);
    }
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'session_ping',
        extensionId: target.extensionId,
        payload: {},
    });
    const startedAt = Date.now();
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: SESSION_PING_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`session_ping failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Check the extension service worker console for errors and confirm the SW is connected to the host. If the SW responder is missing the session_ping handler, the request will time out.',
        ]);
    }
    const latencyMs = Date.now() - startedAt;
    if (response.error) {
        return errorResponse(`session_ping nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Inspect the extension service worker console and the host stderr for the underlying error.',
        ]);
    }
    const pageWorld = readPageWorld(response.payload);
    const pageWorldError = readPageWorldErrorCode(response.payload);
    const pageWorldErrorMessage = readPayloadString(response.payload, 'pageWorldErrorMessage');
    const pageWorldSelfHealed = readPayloadBoolean(response.payload, 'pageWorldSelfHealed');
    const data = {
        hostVersion: ctx.hostVersion,
        extensionVersion: readPayloadString(response.payload, 'extensionVersion'),
        attachedTabId: readPayloadNumber(response.payload, 'attachedTabId'),
        extensionId: target.extensionId,
        latencyMs,
        pageWorld,
        ...(pageWorldError !== null ? { pageWorldError } : {}),
        ...(pageWorldErrorMessage !== null ? { pageWorldErrorMessage } : {}),
        ...(pageWorldSelfHealed ? { pageWorldSelfHealed: true } : {}),
    };
    const nextSteps = buildNextSteps(pageWorld, pageWorldError, pageWorldSelfHealed);
    return okResponse(data, nextSteps);
};
const sessionPingTool = Object.freeze({
    name: 'session_ping',
    description: "Sends a ping through the full MCP → IPC → NMH → SW → CS → page-world chain and returns round-trip metadata: { hostVersion, extensionVersion, attachedTabId, extensionId, latencyMs, pageWorld, pageWorldError?, pageWorldErrorMessage?, pageWorldSelfHealed? }. pageWorld is { url, title, readyState } read live from the active tab's MAIN-world page-world script. pageWorld is null with pageWorldError set (a typed code: cs_not_attached_refresh_tab | page_blocks_scripts | page_world_blocked | restricted_url | no_active_tab | cs_inject_failed) when the SW round-trip succeeded but the page-bridge half failed. The SW also auto-recovers tabs that loaded before the extension reload by programmatically re-injecting the content script and page-world bundle — when this works, pageWorld is populated and pageWorldSelfHealed:true. The tool's next_steps[] field carries imperative, code-specific guidance the AI should relay verbatim to the user. With no args, targets the single connected NMH (errors if zero or multiple). Pass extension_id to target a specific extension. CALL host_status FIRST to see which extensions are currently connected.",
    inputSchema: inputSchema$S,
    handler: sessionPingHandler,
});

const RECENT_EVENTS_TIMEOUT_MS = 5000;
const inputSchema$R = {
    extension_id: stringType().min(1).optional(),
    kinds: arrayType(stringType()).optional(),
    since_ms: numberType().optional(),
    limit: numberType().int().nonnegative().optional(),
};
const readPayload$4 = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    return raw;
};
const recentEventsHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension at chrome://extensions so Chrome respawns the NMH.',
        ]);
    }
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'recent_events',
        extensionId: target.extensionId,
        payload: {
            ...(args.kinds !== undefined ? { kinds: args.kinds } : {}),
            ...(args.since_ms !== undefined ? { sinceMs: args.since_ms } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: RECENT_EVENTS_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`recent_events failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Check the extension service worker console and confirm the SW is connected to the host. If the SW responder is missing the recent_events handler, the request will time out.',
        ]);
    }
    if (response.error) {
        return errorResponse(`recent_events nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Inspect the extension service worker console and the host stderr for the underlying error.',
        ]);
    }
    const payload = readPayload$4(response.payload);
    const events = Array.isArray(payload?.events)
        ? payload.events
        : [];
    const stats = payload?.stats ?? {
        totalReceived: 0,
        perKind: {},
        bufferSize: 0,
    };
    const data = {
        extensionId: target.extensionId,
        events,
        stats,
    };
    const nextSteps = [
        "Recent events from the SW ring buffer (in-memory, lost on SW restart). The buffer is populated by page-world capture producers (console now; fetch/XHR/WebSocket land in M9 Task 8). M11 will replace this in-memory buffer with host-side persistence so events survive SW restarts and tab reloads.",
    ];
    if (events.length === 0) {
        nextSteps.push("events:[] — possible causes: (1) the page hasn't generated any captured activity since the SW started — try console.log on a page; (2) the SW restarted recently and the in-memory buffer was reset; (3) the page tab predates the most recent extension reload and content_scripts haven't injected — hard-refresh the tab and call session_ping to confirm the page-bridge half is healthy before retrying.");
    }
    return okResponse(data, nextSteps);
};
const recentEventsTool = Object.freeze({
    name: 'recent_events',
    description: "Returns recent CapturedEvents from the extension's SW-side ring buffer (in-memory, lost on SW restart; M11 will add cross-restart persistence). Each event has shape: { kind, ts, frameUrl, frameKey, ...kind-specific-fields } where kind is 'console' (currently) or 'fetch'/'xhr'/'websocket' (M9 Task 8). Filters: kinds=['console','fetch'] restricts to listed kinds; since_ms is a strict greater-than ts cutoff; limit caps the result to the most-recent N (default 50, hard max = SW bufferSize). Returns { extensionId, events, stats: { totalReceived, perKind, bufferSize } }. With no extension_id, targets the single connected NMH (errors if zero or multiple). CALL host_status FIRST to see which extensions are connected, and session_ping to confirm the page-bridge half is healthy on the active tab.",
    inputSchema: inputSchema$R,
    handler: recentEventsHandler,
});

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const encodeAsciiToBase64Url = (ascii) => {
    let out = '';
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < ascii.length; i++) {
        buffer = (buffer << 8) | (ascii.charCodeAt(i) & 0xff);
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            out += B64_ALPHABET.charAt((buffer >> bits) & 0x3f);
        }
    }
    if (bits > 0) {
        out += B64_ALPHABET.charAt((buffer << (6 - bits)) & 0x3f);
    }
    return out;
};
const decodeBase64UrlToAscii = (s) => {
    let out = '';
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charAt(i);
        const idx = B64_ALPHABET.indexOf(ch);
        if (idx === -1)
            return null;
        buffer = (buffer << 6) | idx;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += String.fromCharCode((buffer >> bits) & 0xff);
        }
    }
    return out;
};
const encodeCursor = (parts) => {
    const json = JSON.stringify({
        sid: parts.sessionId,
        seq: parts.sequenceNumber,
    });
    return encodeAsciiToBase64Url(json);
};
const decodeCursor = (cursor) => {
    if (typeof cursor !== 'string' || cursor.length === 0) {
        return { ok: false, error: 'cursor is empty' };
    }
    const json = decodeBase64UrlToAscii(cursor);
    if (json === null) {
        return { ok: false, error: 'cursor contains non-base64url characters' };
    }
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return { ok: false, error: 'cursor payload is not valid JSON' };
    }
    if (parsed === null || typeof parsed !== 'object') {
        return { ok: false, error: 'cursor payload is not an object' };
    }
    const obj = parsed;
    if (typeof obj.sid !== 'string' || obj.sid.length === 0) {
        return { ok: false, error: 'cursor.sid missing or not a non-empty string' };
    }
    if (typeof obj.seq !== 'number' ||
        !Number.isFinite(obj.seq) ||
        !Number.isInteger(obj.seq)) {
        return { ok: false, error: 'cursor.seq missing or not a finite integer' };
    }
    return {
        ok: true,
        value: { sessionId: obj.sid, sequenceNumber: obj.seq },
    };
};

const compilePatternList = (sources, fieldPathPrefix) => {
    if (sources === undefined || sources.length === 0) {
        return { ok: true, value: [] };
    }
    const out = [];
    let i = 0;
    for (const src of sources) {
        try {
            out.push(new RegExp(src));
        }
        catch (e) {
            return {
                ok: false,
                error: {
                    kind: 'pattern_invalid',
                    fieldPath: `${fieldPathPrefix}[${i}]`,
                    error: e instanceof Error ? e.message : String(e),
                },
            };
        }
        i++;
    }
    return { ok: true, value: out };
};
const eventTextForPattern = (event) => {
    try {
        return JSON.stringify(event) ?? '';
    }
    catch {
        return '';
    }
};
const compileSourceFilter = (spec) => {
    const includeResult = compilePatternList(spec?.pattern?.include, 'pattern.include');
    if (!includeResult.ok)
        return { ok: false, error: includeResult.error };
    const excludeResult = compilePatternList(spec?.pattern?.exclude, 'pattern.exclude');
    if (!excludeResult.ok)
        return { ok: false, error: excludeResult.error };
    const include = includeResult.value;
    const exclude = excludeResult.value;
    const levelSet = spec?.level !== undefined && spec.level.length > 0
        ? new Set(spec.level)
        : null;
    const predicate = (event) => {
        if (levelSet !== null) {
            const lvl = event.level;
            if (lvl === undefined || !levelSet.has(lvl))
                return false;
        }
        if (include.length === 0 && exclude.length === 0)
            return true;
        const text = eventTextForPattern(event);
        for (const re of exclude) {
            if (re.test(text))
                return false;
        }
        if (include.length > 0) {
            let any = false;
            for (const re of include) {
                if (re.test(text)) {
                    any = true;
                    break;
                }
            }
            if (!any)
                return false;
        }
        return true;
    };
    return { ok: true, predicate };
};

/**
 * Cross-package settings vocabulary — the single source of truth for every
 * user-tunable setting in pwa-debug.
 *
 * Plug-ability invariant (M7): adding a new setting is exactly ONE line in
 * {@link SettingTypeMap} + ONE entry in {@link SETTINGS_SCHEMA}. The host
 * settings store, the settings.* MCP tools, and the extension settings cache
 * all iterate {@link settingKeys} / {@link getSettingEntry} — no key is ever
 * hardcoded — so a new key needs zero changes to any consumer's shape.
 *
 * Lives in @pwa-debug/shared so the host store and the (T3) extension cache
 * enforce identical key/value shapes at compile time via getSetting<K>.
 */
/** Runtime tuple of every {@link CaptureKind}, for validation and introspection. */
const CAPTURE_KINDS = [
    'console',
    'network',
    'dom_mutations',
    'lifecycle',
    'store_change',
    'replay',
    'library_popup',
    'page_error',
    'sw_state',
];
// --- internal primitive guards (not exported; not part of the public surface) ---
const isNonNegInt = (v) => typeof v === 'number' &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    v >= 0;
const isBoolean = (v) => typeof v === 'boolean';
/** A valid TCP port for remote debugging: integer in [1, 65535]. */
const isPort = (v) => typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= 1 &&
    v <= 65535;
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isCaptureKindSubset = (v) => Array.isArray(v) &&
    new Set(v).size === v.length &&
    v.every((x) => CAPTURE_KINDS.includes(x));
const isPlainObject$1 = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isReadControlValue = (v) => {
    if (!isPlainObject$1(v))
        return false;
    const allowed = CAPTURE_KINDS;
    for (const [k, flag] of Object.entries(v)) {
        if (!allowed.includes(k))
            return false;
        if (typeof flag !== 'boolean')
            return false;
    }
    return true;
};
const isReadControlsRecord = (v) => {
    if (!isPlainObject$1(v))
        return false;
    for (const value of Object.values(v)) {
        if (!isReadControlValue(value))
            return false;
    }
    return true;
};
const CONSOLE_LEVELS = [
    'log',
    'info',
    'warn',
    'error',
    'debug',
    'trace',
];
const isFilterPattern = (v) => {
    if (!isPlainObject$1(v))
        return false;
    for (const [k, val] of Object.entries(v)) {
        if (k !== 'include' && k !== 'exclude')
            return false;
        if (val === undefined)
            continue;
        if (!Array.isArray(val))
            return false;
        if (!val.every((x) => typeof x === 'string'))
            return false;
    }
    return true;
};
const FILTER_SPEC_SOURCE_KEYS = ['level', 'pattern'];
const isSourceFilterSpec = (v) => {
    if (!isPlainObject$1(v))
        return false;
    for (const [k, val] of Object.entries(v)) {
        if (!FILTER_SPEC_SOURCE_KEYS.includes(k))
            return false;
        if (val === undefined)
            continue;
        if (k === 'level') {
            if (!Array.isArray(val))
                return false;
            if (!val.every((x) => typeof x === 'string' && CONSOLE_LEVELS.includes(x)))
                return false;
        }
        else if (k === 'pattern') {
            if (!isFilterPattern(val))
                return false;
        }
    }
    return true;
};
const isCaptureFiltersRecord = (v) => {
    if (!isPlainObject$1(v))
        return false;
    const allowed = CAPTURE_KINDS;
    for (const [k, val] of Object.entries(v)) {
        if (!allowed.includes(k))
            return false;
        if (val === undefined)
            continue;
        if (!isSourceFilterSpec(val))
            return false;
    }
    return true;
};
/**
 * The schema as data. Frozen. THIS is the single const instance; every
 * consumer reaches it through {@link settingKeys} / {@link getSettingEntry}.
 */
const SETTINGS_SCHEMA = Object.freeze({
    'capture.memoryCutoffPerKind': {
        key: 'capture.memoryCutoffPerKind',
        type: 'number',
        default: 5000,
        scope: 'host',
        description: 'Max events retained in memory per capture kind before eviction (overflow goes to disk when capture.diskSpill.enabled).',
        validate: isNonNegInt,
    },
    'capture.diskSpill.enabled': {
        key: 'capture.diskSpill.enabled',
        type: 'boolean',
        default: false,
        scope: 'host',
        description: 'When true, events evicted from the in-memory ring buffer are written to on-disk jsonl archives instead of dropped.',
        validate: isBoolean,
    },
    'capture.diskSpill.archiveLongevityDays': {
        key: 'capture.diskSpill.archiveLongevityDays',
        type: 'number',
        default: 7,
        scope: 'host',
        description: 'Age in days after which a disk archive file is pruned on the next pruner tick.',
        validate: isNonNegInt,
    },
    'capture.diskSpill.maxBytes': {
        key: 'capture.diskSpill.maxBytes',
        type: 'number',
        default: 100_000_000,
        scope: 'host',
        description: 'Total disk-archive byte cap; oldest archive files are evicted first when exceeded.',
        validate: isNonNegInt,
    },
    'sites.allowlist': {
        key: 'sites.allowlist',
        type: 'string[]',
        default: ['*'],
        scope: 'both',
        description: 'Glob patterns of origins/URLs the capture pipeline is permitted to record. Default ["*"] = all sites.',
        validate: isStringArray,
    },
    'sites.blocklist': {
        key: 'sites.blocklist',
        type: 'string[]',
        default: [],
        scope: 'both',
        description: 'Glob patterns of origins/URLs never captured; takes precedence over sites.allowlist.',
        validate: isStringArray,
    },
    'capture.enabledKinds': {
        key: 'capture.enabledKinds',
        type: 'enum[]',
        default: [
            'console',
            'network',
            'dom_mutations',
            'lifecycle',
            'store_change',
            'replay',
            'library_popup',
            'sw_state',
        ],
        scope: 'both',
        description: 'Subset of capture kinds actively recorded. Empty = capture nothing.',
        validate: isCaptureKindSubset,
        enumValues: CAPTURE_KINDS,
    },
    'sites.readControls': {
        key: 'sites.readControls',
        type: 'record',
        default: Object.freeze({}),
        scope: 'both',
        description: 'Per-site, per-kind read-permission overrides. Keys are glob patterns (same matcher as sites.allowlist); values are objects of CaptureKind→boolean flags. Missing flag = allowed; false denies that kind for matching URLs. Most-specific (longest) pattern wins per URL; ties broken lexicographically. Only DENIES events otherwise allowed by sites.allowlist + capture.enabledKinds — cannot re-enable what allowlist already rejected.',
        validate: isReadControlsRecord,
    },
    'capture.filters': {
        key: 'capture.filters',
        type: 'record',
        default: Object.freeze({}),
        scope: 'both',
        description: 'Per-kind source-side capture filters. Keys are CaptureKinds; values are wire FilterSpecs (level + pattern only — cursors and limit are seq-based, meaningful only on the host). When set, the capture chokepoint applies the compiled predicate BEFORE the event reaches the host buffer; rejected events are dropped at the source. Validation tightens the wire shape to source-applicable fields only.',
        validate: isCaptureFiltersRecord,
    },
    'capture.stores.allowDispatch': {
        key: 'capture.stores.allowDispatch',
        type: 'boolean',
        default: false,
        scope: 'both',
        description: 'When true, redux_dispatch (and forthcoming store-system dispatch tools) may write to the page-world store; when false (default), the dispatch tool rejects with an actionable next_steps[] hint. Gates the only write surface in the store-introspection family — reads (redux_get_state, redux_subscribe, redux_tail) are unaffected.',
        validate: isBoolean,
    },
    'capture.sourceMap.enabled': {
        key: 'capture.sourceMap.enabled',
        type: 'boolean',
        default: true,
        scope: 'both',
        description: 'When true (default), source_map_resolve fetches and resolves source maps to translate generated stack frames into original-source coordinates. When false, the tool returns errorResponse with a hint. M13 ships query-time resolution only; capture-time auto-annotation is deferred to M13.5.',
        validate: isBoolean,
    },
    'launch.defaultPort': {
        key: 'launch.defaultPort',
        type: 'number',
        default: 9222,
        scope: 'host',
        description: 'Default remote-debugging port used by pdl_launch_browser when no explicit `port` arg is given. 9222 is the chrome-devtools-mcp convention. Change it if 9222 is already in use on your machine.',
        validate: isPort,
    },
});
/**
 * All setting keys in stable schema-declaration order — the canonical
 * iteration order for defaults-merge and settings.list_schema.
 */
const settingKeys = () => Object.keys(SETTINGS_SCHEMA);
/**
 * Typed accessor for a single schema entry — the one DRY lookup point so a
 * future key change is a single schema edit, never a consumer change.
 */
const getSettingEntry = (key) => SETTINGS_SCHEMA[key];
/**
 * Central pure type-guard: validate an unknown value against a key's schema
 * validator. Single validation path shared by the host_settings store and the
 * settings.set MCP tool. Narrows `value` to SettingTypeMap[K] on true.
 */
const validateSettingValue = (key, value) => getSettingEntry(key).validate(value);
/**
 * Factory producing a fresh fully-materialized {@link SettingsRecord} of every
 * key's default. Array and plain-object defaults are cloned so the result
 * never aliases the frozen SETTINGS_SCHEMA. The base the host_settings store
 * merges over.
 */
const defaultSettings = () => Object.fromEntries(settingKeys().map((k) => {
    const d = getSettingEntry(k).default;
    if (Array.isArray(d))
        return [k, [...d]];
    if (isPlainObject$1(d))
        return [k, { ...d }];
    return [k, d];
}));

// Single source of truth for the Path 7 pdl_* interaction action tools.
//
// Both the host (builds a ToolDef + Zod schema per entry) and the extension
// (SW request routing + page-world dispatch) import this table, so tool names,
// their dom_actions action kind, and their parameters stay in sync across
// packages. Adding a tool = one entry here + (for new param shapes) the typed
// param model below; the three generic layers need no per-tool code.
const S = (key, required = false, description) => ({
    key,
    type: 'string',
    ...(required ? { required } : {}),
    ...(description !== undefined ? { description } : {}),
});
const N = (key, required = false, description) => ({
    key,
    type: 'number',
    ...(required ? { required } : {}),
    ...(description !== undefined ? { description } : {}),
});
const B = (key, description) => ({
    key,
    type: 'boolean',
    ...(description !== undefined ? { description } : {}),
});
const ACTION_TOOL_SPECS = Object.freeze([
    // --- discrete (pointer/keyboard) ---
    { tool: 'pdl_click', action: 'click', params: [], summary: 'Click an element (full pointer/mouse event chain so React/Vue delegated onClick fires).' },
    { tool: 'pdl_dblclick', action: 'dblclick', params: [], summary: 'Double-click an element.' },
    { tool: 'pdl_fill', action: 'fill', params: [S('value', true, 'text to set')], summary: "Set an input/textarea/select value via the native setter + input/change (works with React controlled inputs)." },
    { tool: 'pdl_submit', action: 'submit', params: [], summary: 'Submit the form owning the located element (requestSubmit).' },
    { tool: 'pdl_hover', action: 'hover', params: [], summary: 'Hover an element (pointer/mouse over/enter/move).' },
    { tool: 'pdl_focus', action: 'focus', params: [], summary: 'Focus an element.' },
    { tool: 'pdl_blur', action: 'blur', params: [], summary: 'Blur an element.' },
    { tool: 'pdl_check', action: 'check', params: [], summary: 'Check a checkbox/radio (idempotent; native click path so onChange fires).' },
    { tool: 'pdl_uncheck', action: 'uncheck', params: [], summary: 'Uncheck a checkbox (idempotent).' },
    { tool: 'pdl_select_option', action: 'selectOption', params: [S('value', false, 'option value'), S('label', false, 'visible option label')], summary: 'Select a <select> option by value or visible label (one required).' },
    { tool: 'pdl_key_press', action: 'keyPress', params: [S('key', true, "a character or named key e.g. 'Enter','Tab','ArrowDown'")], summary: 'Press a single key on an element.' },
    { tool: 'pdl_type_sequence', action: 'typeSequence', params: [S('value', true, 'string to type char-by-char')], summary: 'Type a string into an editable element char-by-char.' },
    // --- gestures (pointer/touch) ---
    { tool: 'pdl_drag', action: 'drag', params: [N('toX', false, 'destination viewport X'), N('toY', false, 'destination viewport Y'), S('targetSelector', false, 'CSS selector for the drop target (alternative to toX/toY)'), N('steps', false, 'pointermove steps (default 10)'), B('html5', 'also fire the native HTML5 drag/drop sequence with a DataTransfer')], summary: 'Drag the located element to a point (toX/toY) or onto targetSelector; pointer drag + optional HTML5 DnD.' },
    { tool: 'pdl_scroll', action: 'scroll', params: [N('deltaX', false, 'horizontal scroll delta'), N('deltaY', false, 'vertical scroll delta'), B('intoView', 'scrollIntoView (centered) instead of by-delta')], summary: 'Scroll the located element by delta (dispatches wheel + scrollBy) or scrollIntoView.' },
    { tool: 'pdl_swipe', action: 'swipe', params: [{ key: 'direction', type: 'enum', required: true, enum: ['up', 'down', 'left', 'right'], description: 'swipe direction' }, N('distance', false, 'px distance (default 100)'), N('steps', false, 'touchmove steps (default 10)')], summary: 'Swipe a touch across the located element in a direction.' },
    { tool: 'pdl_tap', action: 'tap', params: [], summary: 'Tap (touchstart/touchend) the located element.' },
    { tool: 'pdl_double_tap', action: 'doubleTap', params: [], summary: 'Double-tap the located element.' },
    { tool: 'pdl_long_press', action: 'longPress', params: [N('duration', false, 'hold ms before release (default 500)')], summary: 'Long-press the located element (holds, then releases + contextmenu).' },
    { tool: 'pdl_pinch', action: 'pinch', params: [N('scale', true, 'target scale: >1 zoom in, <1 zoom out'), N('steps', false, 'touchmove steps (default 10)')], summary: 'Pinch-zoom on the located element with two touches.' },
]);

/**
 * Host-side rolling jsonl archive for the captures ring buffer (M8 — disk
 * spill). The writer turns evicted ring-buffer entries into per-(session,
 * kind) rotated jsonl files under ~/.config/pwa-debug/buffers/. Reader (T2)
 * and pruner (T3) compose the same path/threshold primitives so the on-disk
 * layout has one source of truth.
 *
 * Plug-ability: the writer reads `capture.diskSpill.enabled` and
 * `capture.diskSpill.maxBytes` LIVE via the injected getSetting on every
 * write — no internal cache — so a live setting flip takes effect on the
 * very next write without restart. Adding a new disk-spill knob is one
 * entry in settings_schema; the writer needs zero shape changes.
 *
 * Side effects (fs) flow exclusively through host_io.appendLine. The
 * factory itself touches no fs primitives directly so the FP boundary
 * stays at the host_io edge.
 */
// =====================================================================
// Pure helpers (tracked, exported for reader/pruner reuse in T2/T3)
// =====================================================================
/**
 * Per-kind archive directory under the session root. Single source of
 * truth for the layout — the reader's listArchiveFiles enumerates this
 * directory, and resolveArchivePath composes it with the timestamp.jsonl
 * tail. DRY: the path math lives here, callers never construct strings.
 */
const resolveArchiveDir = (sessionId, kind) => xdgConfigPath(`buffers/${sessionId}/${kind}`);
/**
 * Absolute path to one rotated archive file. Composes resolveArchiveDir +
 * <rotationTimestamp>.jsonl so reader + writer share identical path math.
 */
const resolveArchivePath = (sessionId, kind, rotationTimestamp) => `${resolveArchiveDir(sessionId, kind)}/${rotationTimestamp}.jsonl`;
/**
 * Predicate: true when appending nextLineBytes to a file already holding
 * currentBytes would exceed maxBytesPerFile. Centralizes the rotation
 * threshold so the factory and any future re-rotation logic share the
 * same comparison — and so the math is unit-testable without disk.
 */
const shouldRotate = (currentBytes, nextLineBytes, maxBytesPerFile) => currentBytes + nextLineBytes > maxBytesPerFile;
// =====================================================================
// Reader (T2) — pure helpers + streaming orchestrator
// =====================================================================
const ARCHIVE_FILE_RE = /^(\d+)\.jsonl$/;
/**
 * Tagged JSON.parse for one jsonl line. Verifies the minimum shape needed
 * for cursor-bounded iteration (numeric sequenceNumber present). Returns
 * a tagged Result so the reader can skip malformed lines (truncated
 * final line after a host crash mid-write) without halting — robust
 * replay primitive, not a schema validator. T4 layers FilterSpec
 * validation on top.
 */
const parseArchiveLine = (line) => {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return { ok: false };
    }
    if (parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)) {
        return { ok: false };
    }
    const seq = parsed.sequenceNumber;
    if (typeof seq !== 'number' || !Number.isFinite(seq)) {
        return { ok: false };
    }
    return { ok: true, value: parsed };
};
/**
 * Enumerate rotated archive files for one (sessionId, kind) in
 * chronological order (filename = rotationTimestamp, numerically
 * ascending). ENOENT on the directory returns [] silently — a fresh
 * install or capture.diskSpill.enabled=false is a valid steady state,
 * not an error. Non-jsonl entries and non-numeric stems are filtered.
 */
const listArchiveFiles = async (sessionId, kind) => {
    const dir = resolveArchiveDir(sessionId, kind);
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return [];
        throw err;
    }
    const tsByName = [];
    for (const name of entries) {
        const m = ARCHIVE_FILE_RE.exec(name);
        if (!m)
            continue;
        const ts = Number(m[1]);
        if (!Number.isFinite(ts))
            continue;
        tsByName.push([ts, name]);
    }
    tsByName.sort((a, b) => a[0] - b[0]);
    return tsByName.map(([, name]) => `${dir}/${name}`);
};
const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 1000;
const clampLimit = (limit) => {
    if (limit === undefined)
        return DEFAULT_READ_LIMIT;
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
        return DEFAULT_READ_LIMIT;
    }
    return Math.min(limit, MAX_READ_LIMIT);
};
/**
 * Cursor-bounded streaming read of one (sessionId, kind)'s on-disk
 * archive. Lists rotated files, then for each in chronological order
 * streams lines via host_io.readLines, decodes each with
 * parseArchiveLine (skipping malformed lines), applies sinceSeq
 * (exclusive lower) + untilSeq (exclusive upper) bounds, and
 * accumulates entries up to limit. Since sequenceNumber is monotonic
 * within a session, once we see seq >= untilSeq we can stop globally.
 *
 * Filter-naive: T2 owns the disk-streaming substrate; T4 layers
 * FilterSpec compilation on top during the memory→disk merge.
 */
const readArchive = async (input) => {
    const { sessionId, kind, sinceSeq, untilSeq } = input;
    const limit = clampLimit(input.limit);
    const files = await listArchiveFiles(sessionId, kind);
    const entries = [];
    let hasMore = false;
    outer: for (const file of files) {
        for await (const line of readLines(file)) {
            const decoded = parseArchiveLine(line);
            if (!decoded.ok)
                continue;
            const seq = decoded.value.sequenceNumber;
            if (sinceSeq !== undefined && seq <= sinceSeq)
                continue;
            if (untilSeq !== undefined && seq >= untilSeq)
                break outer;
            if (entries.length >= limit) {
                hasMore = true;
                break outer;
            }
            entries.push(decoded.value);
        }
    }
    return { entries, hasMore };
};
// =====================================================================
// Factory
// =====================================================================
const MIN_BYTES_PER_FILE = 1;
/**
 * Per-file size cap derived from the user-facing disk budget:
 * floor(maxBytes / 4) bounds any single archive file to a quarter of the
 * total budget so a long-running kind cannot starve the others. Clamped
 * to MIN_BYTES_PER_FILE so degenerate settings still produce a writable
 * (and rapidly-rotating) state instead of throwing.
 */
const perFileCap = (maxBytes) => Math.max(MIN_BYTES_PER_FILE, Math.floor(maxBytes / 4));
const createArchiveWriter = (input) => {
    const { sessionId, getSetting, now = Date.now, onRotate } = input;
    const currentPathByKind = new Map();
    const currentBytesByKind = new Map();
    let writeCount = 0;
    let dropCount = 0;
    const write = async (kind, entry) => {
        if (!getSetting('capture.diskSpill.enabled')) {
            dropCount += 1;
            return;
        }
        const line = JSON.stringify(entry);
        // +1 for the trailing '\n' host_io.appendLine writes.
        const nextLineBytes = Buffer.byteLength(line, 'utf-8') + 1;
        const cap = perFileCap(getSetting('capture.diskSpill.maxBytes'));
        const currentBytes = currentBytesByKind.get(kind) ?? 0;
        const hasOpenFile = currentPathByKind.has(kind);
        const rotate = !hasOpenFile || shouldRotate(currentBytes, nextLineBytes, cap);
        if (rotate) {
            const path = resolveArchivePath(sessionId, kind, now());
            currentPathByKind.set(kind, path);
            currentBytesByKind.set(kind, 0);
            if (onRotate) {
                try {
                    onRotate();
                }
                catch {
                    // onRotate is a hook (typically pruner trigger); never let it
                    // crash the eviction-driven write path.
                }
            }
        }
        const targetPath = currentPathByKind.get(kind);
        await appendLine(targetPath, line);
        currentBytesByKind.set(kind, (currentBytesByKind.get(kind) ?? 0) + nextLineBytes);
        writeCount += 1;
    };
    const getStats = () => Object.freeze({ writeCount, dropCount });
    return Object.freeze({ write, getStats });
};
const CAPTURE_KIND_SET = new Set([
    'console',
    'network',
    'dom_mutations',
    'lifecycle',
]);
const isCaptureKind = (s) => CAPTURE_KIND_SET.has(s);
const MS_PER_DAY = 86_400_000;
/**
 * Buffers/ root: single source of truth for the cross-session archive
 * directory that scanArchiveFiles enumerates.
 */
const resolveBuffersBaseDir = () => xdgConfigPath('buffers');
/**
 * Pure-at-edges async fs walker. Enumerates every <baseDir>/<sessionId>/
 * <kind>/<timestamp>.jsonl path with its fs.stat metadata. ENOENT on the
 * baseDir or any subdir is treated as "no archive yet" and skipped silently
 * — this matches T1/T2's robustness contract on missing archive trees.
 */
const scanArchiveFiles = async (baseDir) => {
    let sessions;
    try {
        sessions = await readdir(baseDir);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return [];
        throw err;
    }
    const out = [];
    for (const sessionId of sessions) {
        const sessionDir = `${baseDir}/${sessionId}`;
        let kinds;
        try {
            kinds = await readdir(sessionDir);
        }
        catch (err) {
            if (err.code === 'ENOENT')
                continue;
            throw err;
        }
        for (const kindName of kinds) {
            if (!isCaptureKind(kindName))
                continue;
            const kindDir = `${sessionDir}/${kindName}`;
            let names;
            try {
                names = await readdir(kindDir);
            }
            catch (err) {
                if (err.code === 'ENOENT')
                    continue;
                throw err;
            }
            for (const name of names) {
                const m = ARCHIVE_FILE_RE.exec(name);
                if (!m)
                    continue;
                const timestamp = Number(m[1]);
                if (!Number.isFinite(timestamp))
                    continue;
                const path = `${kindDir}/${name}`;
                let st;
                try {
                    st = await stat(path);
                }
                catch (err) {
                    if (err.code === 'ENOENT')
                        continue;
                    throw err;
                }
                out.push({
                    path,
                    sessionId,
                    kind: kindName,
                    timestamp,
                    mtimeMs: st.mtimeMs,
                    bytes: st.size,
                });
            }
        }
    }
    return out;
};
/**
 * Pure filter: returns files whose (now - mtimeMs) exceeds longevityMs —
 * the age-victims that pruneArchives will unlink. longevityMs ≤ 0 selects
 * all; longevityMs = Infinity selects none.
 */
const pruneByAge = (now, longevityMs, files) => files.filter((f) => now - f.mtimeMs > longevityMs);
/**
 * Pure transform: when the sum of file bytes exceeds maxBytes, returns the
 * oldest-first prefix that must be deleted to push total ≤ maxBytes.
 * Total ≤ max → returns []. maxBytes ≤ 0 → returns all files (delete all).
 * Stable sort by mtimeMs ascending.
 */
const pruneBySize = (maxBytes, files) => {
    const cap = Math.max(0, maxBytes);
    const total = files.reduce((sum, f) => sum + f.bytes, 0);
    if (total <= cap)
        return [];
    const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
    const victims = [];
    let running = total;
    for (const f of sorted) {
        if (running <= cap)
            break;
        victims.push(f);
        running -= f.bytes;
    }
    return victims;
};
const safeUnlink = async (path) => {
    try {
        await unlink(path);
        return true;
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return false;
        throw err;
    }
};
/**
 * Pruner orchestrator. Reads capture.diskSpill.archiveLongevityDays +
 * capture.diskSpill.maxBytes live via getSetting, scanArchiveFiles, runs
 * pruneByAge → unlink, then pruneBySize over the survivors → unlink.
 * Returns PruneStats describing what was removed plus the post-prune
 * disk total. Missing buffers/ → zeroed stats (no-op). Triggered by
 * mcp_mode on host boot and on every writer rotation event.
 */
const pruneArchives = async (input) => {
    const baseDir = input.baseDir ?? resolveBuffersBaseDir();
    const now = (input.now ?? Date.now)();
    const longevityDays = input.getSetting('capture.diskSpill.archiveLongevityDays');
    const maxBytes = input.getSetting('capture.diskSpill.maxBytes');
    const longevityMs = longevityDays * MS_PER_DAY;
    const initial = await scanArchiveFiles(baseDir);
    if (initial.length === 0) {
        return { deletedByAge: 0, deletedBySize: 0, bytesAfter: 0, filesAfter: 0 };
    }
    const ageVictims = pruneByAge(now, longevityMs, initial);
    let deletedByAge = 0;
    for (const f of ageVictims) {
        if (await safeUnlink(f.path))
            deletedByAge += 1;
    }
    const ageVictimPaths = new Set(ageVictims.map((f) => f.path));
    const survivors = initial.filter((f) => !ageVictimPaths.has(f.path));
    const sizeVictims = pruneBySize(maxBytes, survivors);
    let deletedBySize = 0;
    for (const f of sizeVictims) {
        if (await safeUnlink(f.path))
            deletedBySize += 1;
    }
    const sizeVictimPaths = new Set(sizeVictims.map((f) => f.path));
    const finalSurvivors = survivors.filter((f) => !sizeVictimPaths.has(f.path));
    const bytesAfter = finalSurvivors.reduce((sum, f) => sum + f.bytes, 0);
    return {
        deletedByAge,
        deletedBySize,
        bytesAfter,
        filesAfter: finalSurvivors.length,
    };
};
// =====================================================================
// onEvict bridge (T3)
// =====================================================================
/**
 * Closes over an ArchiveWriter and returns the kind-aware onEvict callback
 * captures_in's ring buffers fire on FIFO eviction. Calls writer.write
 * fire-and-forget — the writer's drop counter already accounts for
 * capture.diskSpill.enabled=false, and any fs error during eviction must
 * NOT crash the SW pipeline. Decouples captures_in (per-kind ring buffers)
 * from host_archive (rotated jsonl persistence).
 */
const bridgeWriterToOnEvict = (writer) => (kind, evicted) => {
    void writer.write(kind, evicted).catch(() => undefined);
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const validateLimit = (limit) => {
    if (limit === undefined)
        return { ok: true, value: DEFAULT_LIMIT };
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
        return {
            ok: false,
            error: {
                kind: 'limit_invalid',
                fieldPath: 'limit',
                error: `limit must be a finite number; got ${String(limit)}`,
            },
        };
    }
    if (!Number.isInteger(limit)) {
        return {
            ok: false,
            error: {
                kind: 'limit_invalid',
                fieldPath: 'limit',
                error: `limit must be an integer; got ${limit}`,
            },
        };
    }
    if (limit < 1) {
        return {
            ok: false,
            error: {
                kind: 'limit_invalid',
                fieldPath: 'limit',
                error: `limit must be >= 1; got ${limit}`,
            },
        };
    }
    if (limit > MAX_LIMIT) {
        return {
            ok: false,
            error: {
                kind: 'limit_invalid',
                fieldPath: 'limit',
                error: `limit must be <= ${MAX_LIMIT}; got ${limit}`,
            },
        };
    }
    return { ok: true, value: limit };
};
/**
 * Decode a cursor field WITHOUT enforcing sessionId match. The caller (T4
 * tailWithFilterMerged) uses session mismatch as a routing signal to disk,
 * not an error.
 */
const decodeCursorFieldLoose = (cursor, fieldPath) => {
    if (cursor === undefined)
        return { ok: true, value: null };
    const decoded = decodeCursor(cursor);
    if (!decoded.ok) {
        return {
            ok: false,
            error: { kind: 'cursor_invalid', fieldPath, error: decoded.error },
        };
    }
    return { ok: true, value: decoded.value };
};
/**
 * Compile a FilterSpec into a reusable predicate + parsed pagination state.
 * Validates limit, decodes since/until WITHOUT sessionId-match enforcement
 * (the caller routes on mismatch), then DELEGATES level + pattern compile to
 * the shared @pwa-debug/shared compileSourceFilter so the extension capture
 * gate and the host tail use the same predicate code path. Pure (no fs, no
 * buffer access).
 */
const compileTailFilter = (spec, ctx) => {
    const limitResult = validateLimit(spec?.limit);
    if (!limitResult.ok)
        return { ok: false, error: limitResult.error };
    const limit = limitResult.value;
    const sinceResult = decodeCursorFieldLoose(spec?.since, 'since');
    if (!sinceResult.ok)
        return { ok: false, error: sinceResult.error };
    const sinceParts = sinceResult.value;
    const untilResult = decodeCursorFieldLoose(spec?.until, 'until');
    if (!untilResult.ok)
        return { ok: false, error: untilResult.error };
    const untilParts = untilResult.value;
    const sourceResult = compileSourceFilter(spec);
    if (!sourceResult.ok) {
        return {
            ok: false,
            error: {
                kind: 'pattern_invalid',
                fieldPath: sourceResult.error.fieldPath,
                error: sourceResult.error.error,
            },
        };
    }
    const sourcePredicate = sourceResult.predicate;
    const predicate = (event) => {
        if (sinceParts !== null &&
            !(event.sequenceNumber > sinceParts.sequenceNumber)) {
            return false;
        }
        if (untilParts !== null &&
            !(event.sequenceNumber < untilParts.sequenceNumber)) {
            return false;
        }
        return sourcePredicate(event);
    };
    return {
        ok: true,
        value: { predicate, sinceParts, untilParts, limit },
    };
};
const sessionMismatch = (fieldPath, cursorSessionId, currentSessionId) => ({
    kind: 'cursor_session_mismatch',
    fieldPath,
    cursorSessionId,
    currentSessionId,
});
const tailWithFilter = (buffer, spec, ctx) => {
    const compiled = compileTailFilter(spec);
    if (!compiled.ok)
        return { ok: false, error: compiled.error };
    const { predicate, sinceParts, untilParts, limit } = compiled.value;
    // Memory-only callers enforce sessionId match (preserves prior contract).
    if (sinceParts !== null && sinceParts.sessionId !== ctx.currentSessionId) {
        return {
            ok: false,
            error: sessionMismatch('since', sinceParts.sessionId, ctx.currentSessionId),
        };
    }
    if (untilParts !== null && untilParts.sessionId !== ctx.currentSessionId) {
        return {
            ok: false,
            error: sessionMismatch('until', untilParts.sessionId, ctx.currentSessionId),
        };
    }
    const matching = buffer.tail({ filter: predicate });
    let entries;
    let hasMore;
    if (sinceParts !== null) {
        if (matching.length > limit) {
            entries = matching.slice(0, limit);
            hasMore = true;
        }
        else {
            entries = matching;
            hasMore = false;
        }
    }
    else {
        entries =
            matching.length > limit
                ? matching.slice(matching.length - limit)
                : matching;
        hasMore = false;
    }
    if (entries.length === 0) {
        return { ok: true, entries, cursor: null, hasMore };
    }
    const lastEntry = entries[entries.length - 1];
    if (lastEntry === undefined) {
        return { ok: true, entries, cursor: null, hasMore };
    }
    const cursor = encodeCursor({
        sessionId: ctx.currentSessionId,
        sequenceNumber: lastEntry.sequenceNumber,
    });
    return { ok: true, entries, cursor, hasMore };
};
/**
 * Memory→disk-merging tail orchestrator. Routes spec.since by sessionId:
 *   no since                              → memory-only "latest" (no disk)
 *   since.sessionId === currentSessionId  → current-session merge: disk
 *                                           (for the gap predating memory)
 *                                           + memory, concatenated
 *   since.sessionId !== currentSessionId  → prior-session pure-disk read;
 *                                           cursor encodes against the
 *                                           prior sessionId
 * Until-cursor with a different sessionId than the routing session →
 * cursor_session_mismatch (malformed pagination, not routing).
 */
const tailWithFilterMerged = async (input) => {
    const { buffer, spec, ctx, kind } = input;
    const readDisk = input.readDisk ?? readArchive;
    // No since → memory-only "latest" semantics.
    if (spec?.since === undefined) {
        return tailWithFilter(buffer, spec, ctx);
    }
    const compiled = compileTailFilter(spec);
    if (!compiled.ok)
        return { ok: false, error: compiled.error };
    const { predicate, sinceParts, untilParts, limit } = compiled.value;
    if (sinceParts === null) {
        // Defensive: spec.since was set but decode produced null — shouldn't
        // happen with the loose decoder, but fall back to memory.
        return tailWithFilter(buffer, spec, ctx);
    }
    const routingSessionId = sinceParts.sessionId;
    if (untilParts !== null && untilParts.sessionId !== routingSessionId) {
        return {
            ok: false,
            error: sessionMismatch('until', untilParts.sessionId, routingSessionId),
        };
    }
    const diskInput = {
        sessionId: routingSessionId,
        kind,
        sinceSeq: sinceParts.sequenceNumber,
        ...(untilParts !== null && { untilSeq: untilParts.sequenceNumber }),
        // Generous raw cap so the predicate has headroom; we trim to spec.limit.
        limit: MAX_LIMIT,
    };
    const diskRead = await readDisk(diskInput);
    const diskFiltered = [];
    let diskOverflow = false;
    for (const entry of diskRead.entries) {
        if (!predicate(entry))
            continue;
        if (diskFiltered.length >= limit) {
            diskOverflow = true;
            break;
        }
        diskFiltered.push(entry);
    }
    const encodeCursorOrNull = (sessionId, seq) => seq === undefined ? null : encodeCursor({ sessionId, sequenceNumber: seq });
    // Prior-session routing — disk only.
    if (routingSessionId !== ctx.currentSessionId) {
        const entries = diskFiltered;
        const last = entries[entries.length - 1]?.sequenceNumber;
        return {
            ok: true,
            entries,
            cursor: encodeCursorOrNull(routingSessionId, last),
            hasMore: diskOverflow || diskRead.hasMore,
        };
    }
    // Current-session merge — disk first, then memory for the remainder.
    if (diskOverflow || diskFiltered.length === limit) {
        const entries = diskFiltered;
        const last = entries[entries.length - 1]?.sequenceNumber;
        return {
            ok: true,
            entries,
            cursor: encodeCursorOrNull(ctx.currentSessionId, last),
            hasMore: diskOverflow || diskRead.hasMore,
        };
    }
    const remaining = limit - diskFiltered.length;
    const memorySpec = { ...spec, limit: remaining };
    const memoryResult = tailWithFilter(buffer, memorySpec, ctx);
    if (!memoryResult.ok)
        return memoryResult;
    const entries = [
        ...diskFiltered,
        ...memoryResult.entries,
    ];
    const last = entries[entries.length - 1]?.sequenceNumber;
    return {
        ok: true,
        entries,
        cursor: encodeCursorOrNull(ctx.currentSessionId, last),
        hasMore: diskRead.hasMore || memoryResult.hasMore,
    };
};

const filterSchema = objectType({
    level: arrayType(enumType(['log', 'info', 'warn', 'error', 'debug', 'trace']))
        .optional(),
    pattern: objectType({
        include: arrayType(stringType()).optional(),
        exclude: arrayType(stringType()).optional(),
    })
        .optional(),
    since: stringType().optional(),
    until: stringType().optional(),
    limit: numberType().optional(),
    selectors: arrayType(stringType()).optional(),
})
    .optional();
const FILTER_SPEC_HINT = 'FilterSpec keys (all optional): level=ConsoleLevel[] (log|info|warn|error|debug|trace) — applies to console events only; pattern.include/exclude=regex source strings (compiled with new RegExp at the host); since/until=opaque cursor strings from a prior response; limit=int 1..1000 (default 200); selectors reserved for DOM tail tools.';
const toFilterSpec = (raw) => {
    if (raw === undefined)
        return undefined;
    const result = {};
    if (raw.level !== undefined)
        result.level = raw.level;
    if (raw.pattern !== undefined) {
        const p = {};
        if (raw.pattern.include !== undefined)
            p.include = raw.pattern.include;
        if (raw.pattern.exclude !== undefined)
            p.exclude = raw.pattern.exclude;
        result.pattern = p;
    }
    if (raw.since !== undefined)
        result.since = raw.since;
    if (raw.until !== undefined)
        result.until = raw.until;
    if (raw.limit !== undefined)
        result.limit = raw.limit;
    if (raw.selectors !== undefined)
        result.selectors = raw.selectors;
    return result;
};
const tailErrorToResponse = (err) => {
    switch (err.kind) {
        case 'cursor_invalid':
            return errorResponse(`filter.${err.fieldPath} is not a valid cursor: ${err.error}`, [
                `Cursors are opaque tokens returned in prior tail responses. Drop filter.${err.fieldPath} and call again to get a fresh cursor; then page forward by passing it as filter.since.`,
                FILTER_SPEC_HINT,
            ]);
        case 'cursor_session_mismatch':
            return errorResponse(`filter.${err.fieldPath} cursor was minted in session ${err.cursorSessionId}, but the current host buffer session is ${err.currentSessionId}. The host registry was reset (extension reload, host restart, or capture clear).`, [
                `Drop the stale cursor and call again without filter.${err.fieldPath} to get a fresh tail. Use the returned cursor for forward pagination.`,
                FILTER_SPEC_HINT,
            ]);
        case 'pattern_invalid':
            return errorResponse(`filter.${err.fieldPath} is not a valid JS regex source: ${err.error}`, [
                'Each pattern.include / pattern.exclude entry is compiled via new RegExp(source). Escape regex metacharacters in literal strings (e.g. literal "(" as "\\\\(", literal "." as "\\\\.").',
                FILTER_SPEC_HINT,
            ]);
        case 'limit_invalid':
            return errorResponse(`filter.limit invalid: ${err.error}`, [
                'limit must be a finite integer in [1, 1000]. Default is 200 when omitted.',
                FILTER_SPEC_HINT,
            ]);
    }
};

const inputSchema$Q = {
    extension_id: stringType().min(1).optional(),
    filter: filterSchema,
};
const consoleTailHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension at chrome://extensions.',
            FILTER_SPEC_HINT,
        ]);
    }
    const captures = ctx.capturesRegistry.get(target.extensionId);
    if (captures === undefined) {
        return okResponse({ entries: [], cursor: null, hasMore: false }, [
            `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. The CapturesIn instance is created lazily on first event — trigger console activity in a tab and retry.`,
            FILTER_SPEC_HINT,
        ]);
    }
    const sessionId = captures.getStats().sessionId;
    const consoleBuffer = captures.buffer('console');
    const filterSpec = toFilterSpec(args.filter);
    const result = await tailWithFilterMerged({
        buffer: consoleBuffer,
        spec: filterSpec,
        ctx: { currentSessionId: sessionId },
        kind: 'console',
    });
    if (!result.ok) {
        return tailErrorToResponse(result.error);
    }
    const entries = result.entries.map((e) => ({
        ...e,
        cursor: encodeCursor({
            sessionId: e.sessionId,
            sequenceNumber: e.sequenceNumber,
        }),
    }));
    const nextSteps = [
        `Returned ${entries.length} ConsoleEntry record(s) for extension ${target.extensionId} (host session ${sessionId}). Each entry carries page-world fields (ts, frameUrl, frameKey, level, args, optional stack) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor).`,
    ];
    if (result.hasMore) {
        nextSteps.push(`hasMore=true: more matching events exist beyond limit. Page forward by passing the response top-level cursor as filter.since on your next call.`);
    }
    else if (result.cursor === null) {
        nextSteps.push('No console events match the current filter; cursor is null. Adjust filter (level / pattern) or wait for new events.');
    }
    else {
        nextSteps.push('Latest tail returned (hasMore=false). To poll for new events as they arrive, retry with filter.since=cursor (top-level field of this response).');
    }
    nextSteps.push(FILTER_SPEC_HINT);
    return okResponse({ entries, cursor: result.cursor, hasMore: result.hasMore }, nextSteps);
};
const consoleTailTool = Object.freeze({
    name: 'console_tail',
    description: "Tail the host-side console ring buffer for a target extension with cursor pagination + FilterSpec. Returns { entries: ConsoleEntry[]; cursor: Cursor|null; hasMore: bool }. Each ConsoleEntry has page-world fields (ts, frameUrl, frameKey, level, args, optional stack) intersected with host fields (receivedAt, sessionId, extensionId, sequenceNumber) plus a per-entry cursor. Top-level cursor = newest entry's cursor for forward pagination via filter.since. With no extension_id, targets the single connected NMH (errors if zero or multiple). FilterSpec (all optional): level=ConsoleLevel[] (log|info|warn|error|debug|trace); pattern={include?: regex sources[], exclude?: regex sources[]}; since/until=opaque cursor strings; limit=int 1..1000 (default 200). Errors carry kind in next_steps so AI can self-correct: cursor_invalid, cursor_session_mismatch, pattern_invalid, limit_invalid.",
    inputSchema: inputSchema$Q,
    handler: consoleTailHandler,
});

const EVALUATE_IPC_TIMEOUT_MS = 5000;
const EVALUATE_MAX_EXPRESSION_TIMEOUT_MS = 3500;
const inputSchema$P = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    expression: stringType().min(1),
    timeout_ms: numberType()
        .int()
        .positive()
        .max(EVALUATE_MAX_EXPRESSION_TIMEOUT_MS)
        .optional(),
    await_promise: booleanType().optional(),
};
const readEvaluatePayload = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return Object.freeze({});
    const r = raw;
    const out = {};
    if ('value' in r)
        out.value = r['value'];
    if (typeof r['truncated'] === 'boolean')
        out.truncated = r['truncated'];
    if (typeof r['durationMs'] === 'number')
        out.durationMs = r['durationMs'];
    const err = r['error'];
    if (err !== null && typeof err === 'object') {
        const e = err;
        if (typeof e['message'] === 'string') {
            out.error =
                typeof e['stack'] === 'string'
                    ? Object.freeze({ message: e['message'], stack: e['stack'] })
                    : Object.freeze({ message: e['message'] });
        }
    }
    return Object.freeze(out);
};
const isPromiseTag = (v) => v !== null &&
    typeof v === 'object' &&
    v['__type'] === 'Promise';
const evaluateHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension at chrome://extensions so Chrome respawns the NMH.',
        ]);
    }
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'evaluate',
        extensionId: target.extensionId,
        payload: {
            expression: args.expression,
            ...(args.tab_id !== undefined ? { tab_id: args.tab_id } : {}),
            ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
            ...(args.await_promise !== undefined
                ? { await_promise: args.await_promise }
                : {}),
        },
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: EVALUATE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`evaluate failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Check the extension service worker console and confirm the SW is connected to the host. If the SW responder is missing the evaluate handler, the request will time out.',
        ]);
    }
    if (response.error) {
        return errorResponse(`evaluate nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab (open an http(s) tab), explicit tab_id not found, page-bridge timeout (page-world script not attached on chrome:// pages or the chrome web store), or page-world handler threw before producing an EvaluateOutput. Inspect the SW console for [pwa-debug] errors.',
        ]);
    }
    const payload = readEvaluatePayload(response.payload);
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        ...payload,
    };
    const nextSteps = [
        "Expression evaluated in MAIN world via the page-bridge (no CDP — coexists with the user's open DevTools). Result is serialized through captures/serialize.ts: 16KB cap, cycle-safe; DOM nodes/functions/promises/errors get { __type: ... } tags.",
    ];
    if (payload.error !== undefined) {
        nextSteps.push('evaluate.error is populated — the expression compiled but threw, rejected, or timed out. error.stack (when present) is the page-world stack from the moment of failure. Distinct from the outer error envelope: outer error = transport failure; payload.error = expression failure.');
    }
    if (payload.truncated === true) {
        nextSteps.push('truncated:true — the result exceeded 16KB and was replaced with a Truncated tag. Re-evaluate with a smaller projection (e.g., select specific fields, slice arrays, JSON.stringify with a replacer).');
    }
    if (args.await_promise !== true && isPromiseTag(payload.value)) {
        nextSteps.push(`value is { __type: 'Promise' } because await_promise was not set. Pass await_promise:true to await resolution (max timeout_ms = ${EVALUATE_MAX_EXPRESSION_TIMEOUT_MS}ms; default 3000ms).`);
    }
    return okResponse(data, nextSteps);
};
const evaluateTool = Object.freeze({
    name: 'evaluate',
    description: "Evaluate a JavaScript expression in the page (MAIN world) via the page-bridge — NO CDP, so this coexists with the user's open DevTools (chrome-devtools-mcp's evaluate_script cannot). Sees framework globals (window.React, __REACT_DEVTOOLS_GLOBAL_HOOK__, store hooks, etc.) that the SW and content script cannot reach. Args: { extension_id?, tab_id?, expression: non-empty string, timeout_ms?: <=3500ms (default 3000), await_promise? }. Returns { extensionId, tabId, value?, truncated?, durationMs, error? } where value is serialized with a 16KB cap (DOM nodes/functions/promises/errors become { __type: ... } tags; cycles become { __type: 'Cycle' }). When await_promise=true and the expression returns a thenable, races resolution against timeout_ms. error{message,stack?} is populated for syntax errors, sync throws, async rejects, and timeouts — the call still returns ok:true so AI can introspect failure detail. Expression mode only (single expression, no statements; same as DevTools console expression eval). With no extension_id/tab_id, targets the single connected NMH and the active tab. CALL host_status FIRST to see which extensions are connected.",
    inputSchema: inputSchema$P,
    handler: evaluateHandler,
});

const inputSchema$O = {
    extension_id: stringType().min(1).optional(),
    filter: filterSchema,
};
const networkTailHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension at chrome://extensions.',
            FILTER_SPEC_HINT,
        ]);
    }
    const captures = ctx.capturesRegistry.get(target.extensionId);
    if (captures === undefined) {
        return okResponse({ entries: [], cursor: null, hasMore: false }, [
            `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. The CapturesIn instance is created lazily on first event — trigger fetch / XHR / WebSocket activity in a tab and retry.`,
            FILTER_SPEC_HINT,
        ]);
    }
    const sessionId = captures.getStats().sessionId;
    const networkBuffer = captures.buffer('network');
    const filterSpec = toFilterSpec(args.filter);
    const result = await tailWithFilterMerged({
        buffer: networkBuffer,
        spec: filterSpec,
        ctx: { currentSessionId: sessionId },
        kind: 'network',
    });
    if (!result.ok) {
        return tailErrorToResponse(result.error);
    }
    const entries = result.entries.map((e) => ({
        ...e,
        cursor: encodeCursor({
            sessionId: e.sessionId,
            sequenceNumber: e.sequenceNumber,
        }),
    }));
    const nextSteps = [
        `Returned ${entries.length} NetworkEntry record(s) for extension ${target.extensionId} (host session ${sessionId}). Each entry is discriminated by kind: 'fetch' (request/response/error phases, captureId, method, url, headers, status, body, durationMs), 'xhr' (same as fetch + responseType), or 'websocket' (subkind=open|frame|close|error, connectionId, url, direction, frameType, data, code, reason). All carry host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor).`,
    ];
    if (result.hasMore) {
        nextSteps.push(`hasMore=true: more matching events exist beyond limit. Page forward by passing the response top-level cursor as filter.since on your next call.`);
    }
    else if (result.cursor === null) {
        nextSteps.push('No network events match the current filter; cursor is null. If you set filter.level, note it does not apply to network events (none have a level field) — drop it. Otherwise adjust filter.pattern or wait for new events.');
    }
    else {
        nextSteps.push('Latest tail returned (hasMore=false). To poll for new events as they arrive, retry with filter.since=cursor (top-level field of this response).');
    }
    nextSteps.push(FILTER_SPEC_HINT);
    return okResponse({ entries, cursor: result.cursor, hasMore: result.hasMore }, nextSteps);
};
const networkTailTool = Object.freeze({
    name: 'network_tail',
    description: "Tail the host-side network ring buffer (fetch + xhr + websocket events) for a target extension with cursor pagination + FilterSpec. Returns { entries: NetworkEntry[]; cursor: Cursor|null; hasMore: bool }. Each NetworkEntry is discriminated by kind: 'fetch' | 'xhr' (request/response/error phases correlated by captureId, with method, url, headers, status, body, durationMs; xhr adds responseType) | 'websocket' (subkind=open|frame|close|error, connectionId, url, direction=send|receive, frameType=text|binary, data, code, reason). All carry host fields (receivedAt, sessionId, extensionId, sequenceNumber) plus per-entry cursor. With no extension_id, targets the single connected NMH (errors if zero or multiple). FilterSpec (all optional): pattern={include?: regex sources[], exclude?: regex sources[]} matches against JSON.stringify of each entry; since/until=opaque cursor strings; limit=int 1..1000 (default 200); level applies only to console events and returns empty entries when set on the network buffer; selectors reserved for DOM tail tools. Errors carry kind in next_steps for AI self-correction.",
    inputSchema: inputSchema$O,
    handler: networkTailHandler,
});

const inputSchema$N = {
    extension_id: stringType().min(1).optional(),
    include_nested: booleanType().optional(),
    filter: filterSchema,
};
// Regex (matched against each entry's JSON) that drops NESTED popup events —
// the component-level web components inside a widget (e.g. Reown <wui-*>/<ph-*>
// inside <w3m-modal>). Top-level button roles serialize as "role":"button", so
// this only matches the event's own role field. Injected unless include_nested.
const NESTED_EXCLUDE_PATTERN = '"role":"nested"';
const withNestedExcluded = (spec) => {
    const pattern = spec?.pattern ?? {};
    return {
        ...(spec ?? {}),
        pattern: {
            ...pattern,
            exclude: [...(pattern.exclude ?? []), NESTED_EXCLUDE_PATTERN],
        },
    };
};
const popupTailHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension.',
            FILTER_SPEC_HINT,
        ]);
    }
    const captures = ctx.capturesRegistry.get(target.extensionId);
    if (captures === undefined) {
        return okResponse({ entries: [], cursor: null, hasMore: false }, [
            `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. The CapturesIn instance is created lazily on first event — trigger a library popup/widget to open in a tab (e.g. a wallet-connect modal) and retry.`,
            FILTER_SPEC_HINT,
        ]);
    }
    const sessionId = captures.getStats().sessionId;
    const popupBuffer = captures.buffer('library_popup');
    const baseSpec = toFilterSpec(args.filter);
    // Default view = PRIMARY popups only (one entry per logical widget). Pass
    // include_nested=true to also surface the nested component events.
    const filterSpec = args.include_nested === true ? baseSpec : withNestedExcluded(baseSpec);
    const result = await tailWithFilterMerged({
        buffer: popupBuffer,
        spec: filterSpec,
        ctx: { currentSessionId: sessionId },
        kind: 'library_popup',
    });
    if (!result.ok) {
        return tailErrorToResponse(result.error);
    }
    const entries = result.entries.map((e) => ({
        ...e,
        cursor: encodeCursor({
            sessionId: e.sessionId,
            sequenceNumber: e.sequenceNumber,
        }),
    }));
    const scope = args.include_nested === true ? 'primary + nested' : 'primary-only';
    const nextSteps = [
        `Returned ${entries.length} PopupEntry record(s) for extension ${target.extensionId} (host session ${sessionId}); scope=${scope}. Each entry carries page-world fields (ts, frameUrl, frameKey, popupId, phase=appeared|updated|disappeared, detection=shadow|portal, library tag with 'unknown' fallback, host{tagName, id?, classes?, selector}, role=primary|nested, parentPopupId) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). By DEFAULT only role='primary' popups are returned — one entry per logical widget, so a component-heavy modal (e.g. Reown/WalletConnect, ~50 nested web components) shows as a single popup. Pass include_nested=true to also see the nested component events (each carries parentPopupId pointing at its enclosing popup, for reconstructing the widget tree). On appeared/updated, state{visible, title?, text?, buttons?[{label,role}], content?, truncated?} snapshots the widget content. popupId is stable across a popup's appeared→updated→disappeared lifecycle.`,
    ];
    if (result.hasMore) {
        nextSteps.push(`hasMore=true: more matching events exist beyond limit. Page forward by passing the response top-level cursor as filter.since on your next call.`);
    }
    else if (result.cursor === null) {
        nextSteps.push("No library_popup events match the current filter; cursor is null. If you set filter.level, note it does not apply to popup events (none have a level field) — drop it. Otherwise interact with the page to open a popup, or adjust filter.pattern.");
    }
    else {
        nextSteps.push('Latest tail returned (hasMore=false). To poll for new events as they arrive, retry with filter.since=cursor (top-level field of this response).');
    }
    nextSteps.push(FILTER_SPEC_HINT);
    return okResponse({ entries, cursor: result.cursor, hasMore: result.hasMore }, nextSteps);
};
const popupTailTool = Object.freeze({
    name: 'popup_tail',
    description: "Tail the host-side library_popup ring buffer (injected library widgets/popups: WalletConnect, RainbowKit, ConnectKit, Privy, and generic shadow/portal overlays) for a target extension with cursor pagination + FilterSpec. Returns { entries: PopupEntry[]; cursor: Cursor|null; hasMore: bool }. Each PopupEntry carries page-world fields (ts, frameUrl, frameKey, popupId, phase=appeared|updated|disappeared, detection=shadow|portal, library tag ('unknown' when no signature matched), host{tagName, id?, classes?, selector}, role=primary|nested, parentPopupId, and on appeared/updated a state snapshot {visible, title?, text?, buttons?[{label,role}], content?, truncated?} of the widget content) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber) and a per-entry cursor. By DEFAULT only PRIMARY popups are returned — one entry per logical widget — so a component-heavy modal (e.g. a Reown/WalletConnect modal built from ~50 nested shadow-DOM web components) surfaces as a SINGLE popup instead of dozens. Pass include_nested=true to also return the nested component events; each nested entry's parentPopupId points at its enclosing popup so you can reconstruct the widget tree. popupId is stable across a popup's appeared→updated→disappeared lifecycle. With no extension_id, targets the single connected NMH (errors if zero or multiple). FilterSpec (all optional): pattern={include?: regex sources[], exclude?: regex sources[]} matches JSON.stringify of each entry (use it to filter by library, e.g. include:['walletconnect']); since/until=opaque cursor strings; limit=int 1..1000 (default 200); level is ignored (popup events have no console-level field). Errors carry kind in next_steps for AI self-correction.",
    inputSchema: inputSchema$N,
    handler: popupTailHandler,
});

// Pure correlation of popup failures (Path 6 M-C C2). Given the host's three
// ring-buffer tails (library_popup, console, network), groups popups by id,
// derives each one's open window, reads its in-widget failure/alerts from the
// captured PopupState, and links the console errors + failed network requests
// that fired in that window (same frameKey). No I/O, no buffer access — the
// caller (popup_failures tool) supplies the tails so this stays unit-testable.
const CONSOLE_TEXT_CAP = 1000;
const str$1 = (v) => typeof v === 'string' ? v : undefined;
const num = (v) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const readState = (e) => {
    const s = e.state;
    return s !== null && typeof s === 'object' ? s : undefined;
};
const readAlerts = (state) => {
    if (state === undefined || !Array.isArray(state.alerts))
        return [];
    return state.alerts.filter((a) => typeof a === 'string');
};
// Best readable text for a single console arg. Structured loggers (pino/bunyan)
// emit an object whose human message is under msg/message (level/time are
// noise), so prefer those before falling back to JSON.
const argText = (a) => {
    if (typeof a === 'string')
        return a;
    if (a !== null && typeof a === 'object') {
        const o = a;
        for (const key of ['msg', 'message', 'error', 'reason']) {
            const v = o[key];
            if (typeof v === 'string' && v.trim() !== '')
                return v;
        }
    }
    try {
        return JSON.stringify(a);
    }
    catch {
        return String(a);
    }
};
const consoleText = (e) => {
    const args = e.args;
    const parts = Array.isArray(args) ? args : [];
    const text = parts
        .map(argText)
        .join(' ')
        .trim();
    return text.slice(0, CONSOLE_TEXT_CAP);
};
const isNetworkFailure = (e) => {
    const kind = str$1(e.kind);
    if (kind === 'websocket') {
        return str$1(e.subkind) === 'error';
    }
    if (kind === 'fetch' || kind === 'xhr') {
        if (str$1(e.phase) === 'error')
            return true;
        const status = num(e.status);
        if (status !== undefined && (status === 0 || status >= 400))
            return true;
    }
    return false;
};
const toNetworkError = (e) => {
    const url = str$1(e.url);
    const method = str$1(e.method);
    const status = num(e.status);
    const phase = str$1(e.phase) ?? str$1(e.subkind);
    return {
        kind: str$1(e.kind) ?? 'unknown',
        ...(url !== undefined ? { url } : {}),
        ...(method !== undefined ? { method } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(phase !== undefined ? { phase } : {}),
        ts: e.ts,
        sequenceNumber: e.sequenceNumber,
    };
};
const inWindow = (ts, from, to) => ts >= from && ts <= to;
const correlatePopupFailures = (input) => {
    // Group popup events by id, preserving first-seen order.
    const order = [];
    const groups = new Map();
    for (const e of input.popups) {
        const id = str$1(e.popupId);
        if (id === undefined)
            continue;
        if (input.popupId !== undefined && id !== input.popupId)
            continue;
        const existing = groups.get(id);
        if (existing === undefined) {
            groups.set(id, [e]);
            order.push(id);
        }
        else {
            existing.push(e);
        }
    }
    const reports = [];
    for (const id of order) {
        const events = groups.get(id);
        const first = events[0];
        // Role/parent come from any event in the group (the producer stamps them on
        // every phase). Default to 'primary' when absent (pre-two-tier events).
        const roleRaw = events
            .map((e) => str$1(e.role))
            .find((r) => r !== undefined);
        const role = roleRaw === 'nested' ? 'nested' : 'primary';
        // Primary-only by default — nested components of one widget share the
        // frame+window, so the primary's report already aggregates their errors.
        if (role === 'nested' && input.includeNested !== true)
            continue;
        const parentRaw = first.parentPopupId;
        const parentPopupId = typeof parentRaw === 'string' ? parentRaw : null;
        const frameKey = str$1(first.frameKey) ?? '';
        const library = str$1(first.library) ?? 'unknown';
        const detection = str$1(first.detection) === 'portal'
            ? 'portal'
            : 'shadow';
        const appeared = events.find((e) => str$1(e.phase) === 'appeared') ??
            first;
        const disappeared = [...events]
            .reverse()
            .find((e) => str$1(e.phase) === 'disappeared');
        const from = appeared.ts;
        const to = disappeared !== undefined ? disappeared.ts : input.now;
        const open = disappeared === undefined;
        // Latest state-bearing event (appeared/updated carry state).
        const latestWithState = [...events].reverse().find((e) => readState(e) !== undefined);
        const state = latestWithState !== undefined ? readState(latestWithState) : undefined;
        const alerts = readAlerts(state);
        const reasonFromState = str$1(state?.failure?.reason);
        const consoleErrors = input.consoleEvents
            .filter((e) => str$1(e.frameKey) === frameKey &&
            str$1(e.level) === 'error' &&
            inWindow(e.ts, from, to))
            .map((e) => ({
            level: 'error',
            text: consoleText(e),
            ts: e.ts,
            sequenceNumber: e.sequenceNumber,
        }));
        const networkErrors = input.networkEvents
            .filter((e) => str$1(e.frameKey) === frameKey &&
            isNetworkFailure(e) &&
            inWindow(e.ts, from, to))
            .map(toNetworkError);
        const pageErrors = (input.errorEvents ?? [])
            .filter((e) => str$1(e.frameKey) === frameKey && inWindow(e.ts, from, to))
            .map((e) => {
            const name = str$1(e.name);
            return {
                subkind: str$1(e.subkind) ?? 'error',
                message: str$1(e.message) ?? '',
                ...(name !== undefined ? { name } : {}),
                ts: e.ts,
                sequenceNumber: e.sequenceNumber,
            };
        });
        const hasSignal = reasonFromState !== undefined ||
            alerts.length > 0 ||
            pageErrors.length > 0 ||
            consoleErrors.length > 0 ||
            networkErrors.length > 0;
        if (!hasSignal && input.includeAll !== true)
            continue;
        // An uncaught error/rejection is a stronger, more meaningful signal than a
        // generic console line, so it precedes console in the reason fallback.
        const reason = reasonFromState ??
            (pageErrors.find((p) => p.message !== '')?.message) ??
            (consoleErrors[0]?.text) ??
            (networkErrors[0] !== undefined
                ? `network ${networkErrors[0].kind} ${networkErrors[0].url ?? ''} ${networkErrors[0].status ?? networkErrors[0].phase ?? ''}`.trim()
                : undefined);
        reports.push({
            popupId: id,
            library,
            detection,
            frameKey,
            role,
            parentPopupId,
            ...(reason !== undefined ? { reason } : {}),
            ...(alerts.length > 0 ? { alerts } : {}),
            window: { from, to, open },
            console: consoleErrors,
            network: networkErrors,
            errors: pageErrors,
        });
    }
    return reports;
};

const inputSchema$M = {
    extension_id: stringType().min(1).optional(),
    include_all: booleanType().optional(),
    include_nested: booleanType().optional(),
    popup_id: stringType().min(1).optional(),
};
const popupFailuresHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension.',
        ]);
    }
    const captures = ctx.capturesRegistry.get(target.extensionId);
    if (captures === undefined) {
        return okResponse({ reports: [] }, [
            `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. Open a library popup/widget (e.g. a wallet-connect modal) and trigger a connect attempt, then retry.`,
        ]);
    }
    const reports = correlatePopupFailures({
        popups: captures.tail('library_popup'),
        consoleEvents: captures.tail('console'),
        networkEvents: captures.tail('network'),
        errorEvents: captures.tail('page_error'),
        now: Date.now(),
        ...(args.include_all !== undefined ? { includeAll: args.include_all } : {}),
        ...(args.include_nested !== undefined ? { includeNested: args.include_nested } : {}),
        ...(args.popup_id !== undefined ? { popupId: args.popup_id } : {}),
    });
    const scope = args.include_nested === true ? 'primary + nested' : 'primary-only';
    const nextSteps = [
        `Returned ${reports.length} PopupFailureReport(s) for extension ${target.extensionId}; scope=${scope}. Each report names a popup (popupId, library, detection, frameKey, role=primary|nested, parentPopupId), its reason (in-widget failure text > uncaught page error > console error > network error), any in-widget alerts, the open window {from, to, open}, and the uncaught errors[] (window error/unhandledrejection) + console errors + failed network requests captured during that window (matched by frameKey). By DEFAULT only PRIMARY popups are reported — one failure report per logical widget, so a component-heavy modal (e.g. Reown/WalletConnect) yields a single report rather than one per nested component. Use this to tell the user 'the <library> modal showed an error: <reason>' with linked evidence.`,
    ];
    if (reports.length === 0) {
        nextSteps.push('No primary popups with a failure signal. Pass include_all=true to list every tracked (primary) popup window even without a failure, include_nested=true to also report nested component popups, or confirm a popup actually appeared via popup_tail.');
    }
    else {
        nextSteps.push('For full console/network detail beyond the correlated subset, page console_tail / network_tail with filter.since around a report.window.from.');
    }
    return okResponse({ reports }, nextSteps);
};
const popupFailuresTool = Object.freeze({
    name: 'popup_failures',
    description: "Surface auth/connect FAILURES from library popups for a target extension. Correlates each tracked popup's in-widget failure (PopupState.failure/alerts captured by popup_tail's producer) with the console errors and failed network requests (fetch/xhr phase 'error' | status>=400 | status===0, websocket 'error') that fired during that popup's open window, matched by frameKey. Returns { reports: PopupFailureReport[] }, each: { popupId, library, detection, frameKey, role=primary|nested, parentPopupId, reason?, alerts?, window{from,to,open}, console[{level,text,ts,sequenceNumber}], network[{kind,url?,method?,status?,phase?,ts,sequenceNumber}] }. reason precedence = in-widget failure text > first uncaught page error (window error/unhandledrejection) > first console error (structured-logger args unwrapped to msg/message) > network error. Each report also carries errors[] (uncaught page errors in the window). By DEFAULT only PRIMARY popups WITH a failure signal are returned — one report per logical widget, so a component-heavy modal (e.g. a Reown/WalletConnect modal of ~hundreds of nested web components) yields ONE failure report, not hundreds. The primary's window already aggregates the whole widget's console/network errors by frameKey. Pass include_nested=true to also report nested component popups (each carries parentPopupId), include_all=true to include primary windows without a failure signal, or popup_id to filter to one. With no extension_id, targets the single connected NMH (errors if zero or multiple). Read-only.",
    inputSchema: inputSchema$M,
    handler: popupFailuresHandler,
});

const inputSchema$L = {
    extension_id: stringType().min(1).optional(),
    filter: filterSchema,
};
const errorTailHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension.',
            FILTER_SPEC_HINT,
        ]);
    }
    const captures = ctx.capturesRegistry.get(target.extensionId);
    if (captures === undefined) {
        return okResponse({ entries: [], cursor: null, hasMore: false }, [
            `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. Uncaught errors / unhandled promise rejections land here once they fire on a page.`,
            FILTER_SPEC_HINT,
        ]);
    }
    const sessionId = captures.getStats().sessionId;
    const result = await tailWithFilterMerged({
        buffer: captures.buffer('page_error'),
        spec: toFilterSpec(args.filter),
        ctx: { currentSessionId: sessionId },
        kind: 'page_error',
    });
    if (!result.ok) {
        return tailErrorToResponse(result.error);
    }
    const entries = result.entries.map((e) => ({
        ...e,
        cursor: encodeCursor({
            sessionId: e.sessionId,
            sequenceNumber: e.sequenceNumber,
        }),
    }));
    const nextSteps = [
        `Returned ${entries.length} PageErrorEntry record(s) for extension ${target.extensionId} (host session ${sessionId}). Each entry is an uncaught failure: subkind='error' (window 'error'/window.onerror) or 'unhandledrejection' (a rejected promise the app did not catch), plus message, name?, stack?, source? (url:line:col) and page-world fields (ts, frameUrl, frameKey) + host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). These are errors that BUBBLED — failures an app fully catches in try/catch won't appear here.`,
    ];
    if (result.hasMore) {
        nextSteps.push('hasMore=true: page forward by passing the response top-level cursor as filter.since.');
    }
    else if (result.cursor === null) {
        nextSteps.push('No page errors match the current filter. If you set filter.level, drop it (page errors have no console-level field). Otherwise trigger/await an uncaught error or unhandled rejection.');
    }
    else {
        nextSteps.push('Latest tail returned (hasMore=false). Poll for new errors with filter.since=cursor.');
    }
    nextSteps.push(FILTER_SPEC_HINT);
    return okResponse({ entries, cursor: result.cursor, hasMore: result.hasMore }, nextSteps);
};
const errorTailTool = Object.freeze({
    name: 'error_tail',
    description: "Tail the host-side page_error ring buffer for a target extension with cursor pagination + FilterSpec. page_error events are UNCAUGHT failures captured app-/framework-agnostically: a window 'error' (ErrorEvent / window.onerror, subkind='error') or an 'unhandledrejection' (a rejected promise the app did not catch, subkind='unhandledrejection'). Returns { entries: PageErrorEntry[]; cursor: Cursor|null; hasMore: bool }. Each entry: { kind:'page_error', subkind, message, name?, stack?, source?(url:line:col), ts, frameUrl, frameKey, ...host fields, cursor }. Use this to see thrown errors and rejected promises (including wallet/connect rejections that bubble) without the app having to log them. NOTE: errors an app fully handles in try/catch do NOT surface here. With no extension_id, targets the single connected NMH (errors if zero or multiple). FilterSpec (all optional): pattern.include/exclude=regex sources matched against each entry's JSON (e.g. include:['rejected','cancelled']); since/until=opaque cursors; limit=int 1..1000 (default 200); level is ignored (page errors have no level field).",
    inputSchema: inputSchema$L,
    handler: errorTailHandler,
});

// Intent-driven popup recording (Path 6 M-D). A bounded, AI-triggered capture:
// start subscribes to the extension's captures intake and buffers every
// library_popup event (primary + nested, in arrival order) IN MEMORY — immune
// to ring-buffer eviction during a long session — until stop persists the
// stream to <config>/pwa-debug/popup-recordings/<label>/events.jsonl (+ meta).
// Forward-only: only events received between start and stop are recorded. The
// long-lived MCP host owns the active-recording state (lost on host restart,
// which is fine for a session-scoped intent). Side effects (fs) at the edges.
const RECORDINGS_SUBDIR = 'popup-recordings';
// Per-extension active recording (module state in the long-lived MCP host).
const active = new Map();
/** Sanitize a label into one safe path segment. */
const sanitizeLabel = (label) => {
    const cleaned = label
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
    return cleaned.length > 0 ? cleaned.slice(0, 80) : 'recording';
};
const recordingStatus = (extensionId) => {
    const rec = active.get(extensionId);
    if (rec === undefined)
        return { active: false };
    return {
        active: true,
        label: rec.label,
        startedAt: rec.startedAt,
        count: rec.events.length,
    };
};
/**
 * Start a recording: subscribe to the extension's captures intake and buffer
 * every library_popup event until stop. Idempotent — returns the in-progress
 * status if one is already active for this extension.
 */
const startRecording = (captures, extensionId, label, startedAt) => {
    const existing = active.get(extensionId);
    if (existing !== undefined) {
        return {
            active: true,
            label: existing.label,
            startedAt: existing.startedAt,
            count: existing.events.length,
        };
    }
    const events = [];
    const unsubscribe = captures.subscribe((kind, event) => {
        if (kind === 'library_popup')
            events.push(event);
    });
    active.set(extensionId, { label, startedAt, events, unsubscribe });
    return { active: true, label, startedAt, count: 0 };
};
const eventsPath = (label, env) => xdgConfigPath(`${RECORDINGS_SUBDIR}/${label}/events.jsonl`, env);
const metaPath = (label, env) => xdgConfigPath(`${RECORDINGS_SUBDIR}/${label}/meta.json`, env);
/**
 * Stop a recording: unsubscribe, write the buffered events to events.jsonl
 * (overwriting any prior file for this label) + meta.json, clear state, and
 * return the path + count. Returns undefined when no recording is active.
 */
const stopRecording = async (extensionId, stoppedAt, env) => {
    const rec = active.get(extensionId);
    if (rec === undefined)
        return undefined;
    rec.unsubscribe();
    active.delete(extensionId);
    const path = eventsPath(rec.label, env);
    await mkdir(dirname(path), { recursive: true });
    const body = rec.events.length === 0
        ? ''
        : `${rec.events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    await writeFile(path, body, { encoding: 'utf-8', mode: 0o600 });
    await atomicWriteJson(metaPath(rec.label, env), {
        label: rec.label,
        extensionId,
        startedAt: rec.startedAt,
        stoppedAt,
        count: rec.events.length,
    });
    return {
        label: rec.label,
        path,
        dir: dirname(path),
        count: rec.events.length,
        startedAt: rec.startedAt,
        stoppedAt,
    };
};

const inputSchema$K = {
    action: enumType(['start', 'stop', 'status']),
    label: stringType().min(1).optional(),
    extension_id: stringType().min(1).optional(),
};
const popupRecordHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. A recording is bound to one extension.',
        ]);
    }
    if (args.action === 'status') {
        return okResponse({ recording: recordingStatus(target.extensionId) }, [
            'Recording status for this extension. start a recording, perform the actions you want to capture, then stop and view with popup_replay.',
        ]);
    }
    if (args.action === 'start') {
        // getOrCreate so the subscription is in place even before the first event.
        const captures = ctx.capturesRegistry.getOrCreate(target.extensionId);
        const label = sanitizeLabel(args.label ?? `rec-${Date.now()}`);
        const status = startRecording(captures, target.extensionId, label, Date.now());
        return okResponse({ recording: status }, [
            `Recording '${status.label}' is live for extension ${target.extensionId}. It buffers EVERY library_popup event (primary + nested, in order) until you stop it. Perform the popup interactions you want to capture, then call popup_record action='stop'. Already-active recording? This returns the in-progress one (one per extension).`,
        ]);
    }
    // action === 'stop'
    const result = await stopRecording(target.extensionId, Date.now());
    if (result === undefined) {
        return okResponse({ recording: { active: false } }, [
            'No active recording for this extension. Start one with popup_record action=\'start\' before stopping.',
        ]);
    }
    return okResponse({ recording: result }, [
        `Saved ${result.count} popup event(s) to ${result.path}. View it with popup_replay { label: '${result.label}', mode: 'primary' | 'tree' | 'flat' } — primary = one entry per widget, tree = hierarchy via parentPopupId, flat = raw sequence.`,
    ]);
};
const popupRecordTool = Object.freeze({
    name: 'popup_record',
    description: "Bounded, intent-driven recording of the library_popup event stream for a target extension. action='start' subscribes to the extension's capture intake and buffers EVERY library_popup event (primary + nested, in arrival order) in memory — immune to ring-buffer eviction — until action='stop', which persists the stream to <config>/pwa-debug/popup-recordings/<label>/events.jsonl (+ meta.json) and returns { path, count }. action='status' reports the active recording { active, label, startedAt, count }. Forward-only: only events between start and stop are recorded — start with intent, perform the interactions, stop, then view with popup_replay. One recording per extension (start while active returns the in-progress one). Optional label (defaults to rec-<timestamp>); optional extension_id (defaults to the single connected NMH). Use this to capture a specific debugging episode for sequential review instead of always-on noise.",
    inputSchema: inputSchema$K,
    handler: popupRecordHandler,
});

// Reader for popup recordings written by recorder.ts. Loads a recording's
// events.jsonl and projects it three ways for popup_replay:
//   - 'flat'    : the raw event sequence (paginated)
//   - 'primary' : only role!=='nested' events (paginated)
//   - 'tree'    : a hierarchy of popup nodes (primary roots, nested children
//                 attached by parentPopupId), each node summarizing its phases
// Pure transforms over the parsed lines; fs reads via host_io.
const str = (v) => typeof v === 'string' ? v : undefined;
const readEvents = async (label, env) => {
    const path = xdgConfigPath(`${RECORDINGS_SUBDIR}/${label}/events.jsonl`, env);
    const out = [];
    for await (const line of readLines(path)) {
        const t = line.trim();
        if (t === '')
            continue;
        try {
            const o = JSON.parse(t);
            if (o !== null && typeof o === 'object')
                out.push(o);
        }
        catch {
            // skip malformed line
        }
    }
    return out;
};
const buildTree = (events) => {
    const order = [];
    const nodes = new Map();
    for (const e of events) {
        const id = str(e.popupId);
        if (id === undefined)
            continue;
        let node = nodes.get(id);
        if (node === undefined) {
            const parentRaw = e.parentPopupId;
            const lib = str(e.library);
            const det = str(e.detection);
            const hostVal = e.host;
            node = {
                popupId: id,
                role: str(e.role) ?? 'primary',
                ...(lib !== undefined ? { library: lib } : {}),
                ...(det !== undefined ? { detection: det } : {}),
                ...(hostVal !== undefined ? { host: hostVal } : {}),
                parentPopupId: typeof parentRaw === 'string' ? parentRaw : null,
                phases: [],
                children: [],
            };
            nodes.set(id, node);
            order.push(id);
        }
        const phase = str(e.phase);
        if (phase !== undefined)
            node.phases.push(phase);
    }
    const roots = [];
    for (const id of order) {
        const node = nodes.get(id);
        const parent = node.parentPopupId !== null ? nodes.get(node.parentPopupId) : undefined;
        if (parent !== undefined)
            parent.children.push(node);
        else
            roots.push(node);
    }
    return roots;
};
const readRecording = async (label, mode, opts, env) => {
    const events = await readEvents(label, env);
    if (mode === 'tree') {
        return { mode: 'tree', total: events.length, roots: buildTree(events) };
    }
    const filtered = mode === 'primary' ? events.filter((e) => str(e.role) !== 'nested') : events;
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(Math.max(1, opts.limit ?? 500), 2000);
    const entries = filtered.slice(offset, offset + limit);
    return {
        mode,
        total: filtered.length,
        offset,
        entries,
        hasMore: offset + limit < filtered.length,
    };
};
const listRecordings = async (env) => {
    const dirPath = xdgConfigPath(RECORDINGS_SUBDIR, env);
    let labels;
    try {
        const dirents = await readdir(dirPath, { withFileTypes: true });
        labels = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return [];
        throw err;
    }
    const out = [];
    for (const label of labels) {
        const meta = await readJsonOr(xdgConfigPath(`${RECORDINGS_SUBDIR}/${label}/meta.json`, env), null, (raw) => (raw !== null && typeof raw === 'object' ? raw : null));
        out.push({
            label,
            ...(meta !== null
                ? {
                    ...(typeof meta.count === 'number' ? { count: meta.count } : {}),
                    ...(typeof meta.startedAt === 'number' ? { startedAt: meta.startedAt } : {}),
                    ...(typeof meta.stoppedAt === 'number' ? { stoppedAt: meta.stoppedAt } : {}),
                }
                : {}),
        });
    }
    return out;
};

const inputSchema$J = {
    label: stringType().min(1).optional(),
    mode: enumType(['flat', 'primary', 'tree']).optional(),
    offset: numberType().int().min(0).optional(),
    limit: numberType().int().min(1).max(2000).optional(),
};
const popupReplayHandler = async (args, _ctx) => {
    if (args.label === undefined) {
        const recordings = await listRecordings();
        return okResponse({ recordings }, [
            recordings.length === 0
                ? 'No popup recordings on disk yet. Capture one with popup_record action=\'start\' ... action=\'stop\'.'
                : `Available recordings (label, count, startedAt/stoppedAt). Read one with popup_replay { label, mode:'primary'|'tree'|'flat' }.`,
        ]);
    }
    const mode = args.mode ?? 'primary';
    const result = await readRecording(args.label, mode, {
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    if (result.mode === 'tree') {
        return okResponse({ ...result }, [
            `Hierarchical view of recording '${args.label}': ${result.roots.length} primary popup(s) (total ${result.total} events). Each node has popupId, role, library, detection, host, phases[], and nested children (linked by parentPopupId). Use mode='flat' for the raw event sequence or mode='primary' for primary events only.`,
        ]);
    }
    return okResponse({ label: args.label, ...result }, [
        `Recording '${args.label}' (${result.mode}): ${result.entries.length} of ${result.total} event(s) from offset ${result.offset}. ${result.hasMore ? 'hasMore=true — page with offset+limit.' : 'End of recording.'} mode='tree' gives the popup hierarchy; mode='flat' the full raw sequence (primary+nested).`,
    ]);
};
const popupReplayTool = Object.freeze({
    name: 'popup_replay',
    description: "Read back a popup recording captured by popup_record. With no label, lists available recordings on disk ({label, count, startedAt, stoppedAt}). With a label, projects the recorded library_popup events three ways via `mode`: 'primary' (default — only role!=='nested' events, one stream per logical widget; paginated by offset/limit), 'flat' (the raw full-fidelity sequence including nested components; paginated), or 'tree' (a hierarchy of popup nodes — primary roots with nested children attached by parentPopupId, each node summarizing popupId/role/library/detection/host/phases). Reads from <config>/pwa-debug/popup-recordings/<label>/events.jsonl. Use it to review a recorded debugging episode sequentially or hierarchically. Read-only.",
    inputSchema: inputSchema$J,
    handler: popupReplayHandler,
});

const REACT_TREE_IPC_TIMEOUT_MS = 5000;
const inputSchema$I = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    root_index: numberType().int().nonnegative().optional(),
    depth_limit: numberType().int().positive().max(64).optional(),
    max_nodes: numberType().int().positive().max(5000).optional(),
};
const isTreeNode$1 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return (typeof r['stableId'] === 'string' &&
        typeof r['displayName'] === 'string' &&
        typeof r['hasState'] === 'boolean' &&
        typeof r['hasHooks'] === 'boolean' &&
        Array.isArray(r['children']));
};
const readPayload$3 = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (!Array.isArray(r['roots']))
        return null;
    if (typeof r['truncated'] !== 'boolean')
        return null;
    if (typeof r['rootCount'] !== 'number')
        return null;
    const roots = r['roots'].filter(isTreeNode$1);
    return Object.freeze({
        roots,
        truncated: r['truncated'],
        rootCount: r['rootCount'],
    });
};
const reactTreeHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension at brave://extensions so Chrome respawns the NMH.',
        ]);
    }
    const wirePayload = {};
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.root_index !== undefined)
        wirePayload['root_index'] = args.root_index;
    if (args.depth_limit !== undefined)
        wirePayload['depth_limit'] = args.depth_limit;
    if (args.max_nodes !== undefined)
        wirePayload['max_nodes'] = args.max_nodes;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'react_tree',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: REACT_TREE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`react_tree failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Check the extension service worker console; confirm the SW is connected to the host. If the SW responder is missing the react_tree handler, the request will time out.',
        ]);
    }
    if (response.error) {
        return errorResponse(`react_tree nmh error: ${response.error.message}`, [
            "NMH-mode rejected the request. Common causes: no active tab (open an http(s) tab to a React page), explicit tab_id not found, page-bridge timeout (page-world script not attached on chrome:// or chrome web store pages), or the page-world react module threw. Inspect the SW console for [pwa-debug] errors.",
        ]);
    }
    const payload = readPayload$3(response.payload);
    if (payload === null) {
        return errorResponse('react_tree returned a malformed payload (missing roots/truncated/rootCount).', [
            'The page-world handler returned a shape that does not match ReactTreeResult. Check packages/extension/src/react/serialize_tree.ts and confirm wire JSON encoding preserved the structure.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        roots: payload.roots,
        truncated: payload.truncated,
        rootCount: payload.rootCount,
    };
    const nextSteps = [
        'roots[] contains ReactTreeNode { stableId, displayName, key?, hasState, hasHooks, children }. Pass a stableId to react.getState to fetch the full component state (props, hooks, class state). The id format is bijective with the tree shape — re-call react.tree after re-renders that preserve identity to refresh; the same id resolves the same component.',
    ];
    if (payload.rootCount === 0) {
        nextSteps.push('rootCount===0 means no React roots detected on the page. Verify the page actually renders React (use evaluate with __REACT_DEVTOOLS_GLOBAL_HOOK__) or that ReactDOM.createRoot has run before this call.');
    }
    if (args.root_index !== undefined && args.root_index >= payload.rootCount) {
        nextSteps.push(`root_index=${args.root_index} is out of range — only ${payload.rootCount} root(s) exist. Re-call without root_index to see all roots.`);
    }
    if (payload.truncated) {
        nextSteps.push('truncated:true — depth_limit or max_nodes was hit before the full tree was emitted. Re-call with higher depth_limit (default 8) or max_nodes (default 200), or pass a specific root_index to scope the walk.');
    }
    return okResponse(data, nextSteps);
};
const reactTreeTool = Object.freeze({
    name: 'react_tree',
    description: "Return the React component tree of the active (or specified) tab as a structured ReactTreeNode[]. Each node has { stableId, displayName, key?, hasState, hasHooks, children } where stableId is a re-render-stable component identity (path + displayName + key/index). Args: { extension_id?, tab_id?, root_index?: pick one root (default: all), depth_limit?: max depth (default 8, cap 64), max_nodes?: total cap (default 200, cap 5000) }. Returns { extensionId, tabId, roots, truncated, rootCount }. truncated:true means the walk hit depth_limit or max_nodes; re-call with a tighter root_index or higher caps. Pass any node's stableId to react_get_state for that component's props/state/hooks. Runs in page-world (MAIN world) via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see which extensions are connected.",
    inputSchema: inputSchema$I,
    handler: reactTreeHandler,
});

const REACT_GET_STATE_IPC_TIMEOUT_MS = 5000;
const inputSchema$H = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    stable_id: stringType().min(1),
    root_index: numberType().int().nonnegative().optional(),
    include_props: booleanType().optional(),
    include_hooks: booleanType().optional(),
};
const isToolErrorPayload$g = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    const e = r['error'];
    return typeof e['message'] === 'string';
};
const isComponentSuccess$1 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return typeof r['stableId'] === 'string' && typeof r['displayName'] === 'string';
};
const reactGetStateHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension at brave://extensions.',
        ]);
    }
    const wirePayload = { stable_id: args.stable_id };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.root_index !== undefined)
        wirePayload['root_index'] = args.root_index;
    if (args.include_props !== undefined)
        wirePayload['include_props'] = args.include_props;
    if (args.include_hooks !== undefined)
        wirePayload['include_hooks'] = args.include_hooks;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'react_get_state',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: REACT_GET_STATE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`react_get_state failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected to the host and the react_get_state handler is wired in the SW.',
        ]);
    }
    if (response.error) {
        return errorResponse(`react_get_state nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
        ]);
    }
    if (isToolErrorPayload$g(response.payload)) {
        return errorResponse(`react_get_state: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler (NOT a transport error). Most common: stable_id not resolvable — re-call react.tree to refresh ids; the React tree may have re-rendered into a different shape.',
        ]);
    }
    if (!isComponentSuccess$1(response.payload)) {
        return errorResponse('react_get_state returned a malformed payload (missing stableId/displayName).', [
            'The page-world handler did not match the ReactComponentInfo shape. Check packages/extension/src/react/serialize_component.ts.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        ...response.payload,
    };
    const nextSteps = [
        'Component info shape: { stableId, displayName, key?, props?, state?, hooks?: SerializedHook[], truncated? }. SerializedHook entries are typed as "state"|"memo"|"effect"|"ref"|"custom" (state and reducer are conflated; memo covers useMemo and useCallback). Values are serialized with a 16KB cap.',
    ];
    if (response.payload.truncated === true) {
        nextSteps.push('truncated:true — one or more of props/state/hooks exceeded the 16KB serializer cap. Re-call with include_props:false or include_hooks:false to isolate the bloated field, or use evaluate() to read a narrower projection of the offending field.');
    }
    if (args.include_hooks === false && response.payload.hooks === undefined) {
        nextSteps.push('include_hooks:false suppressed the hooks field; pass include_hooks:true (default) to retrieve them.');
    }
    return okResponse(data, nextSteps);
};
const reactGetStateTool = Object.freeze({
    name: 'react_get_state',
    description: "Return the props, state, and hooks of a single React component identified by stable_id (obtained from a prior react_tree call). Args: { extension_id?, tab_id?, stable_id: required non-empty string, root_index?: number=0 (must match the root used to compute the id), include_props?: bool=true, include_hooks?: bool=true }. Returns { extensionId, tabId, stableId, displayName, key?, props?, state?, hooks?: SerializedHook[], truncated? }. SerializedHook entries: { type: 'state'|'memo'|'effect'|'ref'|'custom'; index; value?; deps?; truncated? }. Tool-level error when stable_id no longer resolves — in that case re-call react_tree to refresh ids. Runs in page-world via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see connections.",
    inputSchema: inputSchema$H,
    handler: reactGetStateHandler,
});

const REACT_FIND_BY_TEXT_IPC_TIMEOUT_MS = 5000;
const inputSchema$G = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    pattern: stringType().min(1),
    exact: booleanType().optional(),
    root_index: numberType().int().nonnegative().optional(),
    max_matches: numberType().int().positive().max(500).optional(),
};
const isToolErrorPayload$f = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    const e = r['error'];
    return typeof e['message'] === 'string';
};
const isFindByTextSuccess$1 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return (Array.isArray(r['matches']) &&
        typeof r['truncated'] === 'boolean' &&
        typeof r['rootCount'] === 'number');
};
const reactFindByTextHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension at brave://extensions.',
        ]);
    }
    const wirePayload = { pattern: args.pattern };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.exact !== undefined)
        wirePayload['exact'] = args.exact;
    if (args.root_index !== undefined)
        wirePayload['root_index'] = args.root_index;
    if (args.max_matches !== undefined)
        wirePayload['max_matches'] = args.max_matches;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'react_find_by_text',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: REACT_FIND_BY_TEXT_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`react_find_by_text failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected to the host and the react_find_by_text handler is wired in the SW.',
        ]);
    }
    if (response.error) {
        return errorResponse(`react_find_by_text nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout (page-world not attached on chrome:// pages), or the page-world handler threw.',
        ]);
    }
    if (isToolErrorPayload$f(response.payload)) {
        return errorResponse(`react_find_by_text: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler (NOT a transport error). Most common: an invalid regex pattern — the pattern is compiled with new RegExp (no flags); fix the source and retry.',
        ]);
    }
    if (!isFindByTextSuccess$1(response.payload)) {
        return errorResponse('react_find_by_text returned a malformed payload (missing matches/truncated/rootCount).', [
            'The page-world handler did not match the FindByTextResult shape. Check packages/extension/src/react/find_by_text.ts.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        matches: response.payload.matches,
        truncated: response.payload.truncated,
        rootCount: response.payload.rootCount,
    };
    const nextSteps = [
        'matches[] contains { stableId, displayName, key?, matchedText }. Pass any stableId to react_get_state for that component’s props/state/hooks. matchedText is the matched substring (or the full trimmed text when exact:true).',
    ];
    if (response.payload.matches.length === 0) {
        nextSteps.push(response.payload.rootCount === 0
            ? 'rootCount===0 — no React roots detected. Verify the page renders React (try evaluate with __REACT_DEVTOOLS_GLOBAL_HOOK__) or that ReactDOM.createRoot has run.'
            : 'No components matched. The pattern is a JS regex source compiled with new RegExp (no flags, case-sensitive). Broaden it, or keep exact:false (default) for substring matching.');
    }
    if (args.root_index !== undefined &&
        args.root_index >= response.payload.rootCount) {
        nextSteps.push(`root_index=${args.root_index} is out of range — only ${response.payload.rootCount} root(s) exist. Re-call without root_index to search all roots.`);
    }
    if (response.payload.truncated) {
        nextSteps.push('truncated:true — max_matches (default 20) was reached before the walk finished. Raise max_matches or tighten the pattern / root_index.');
    }
    return okResponse(data, nextSteps);
};
const reactFindByTextTool = Object.freeze({
    name: 'react_find_by_text',
    description: "Find React components whose rendered host-node text matches a regex. Args: { extension_id?, tab_id?, pattern: required regex source string (compiled with new RegExp — no flags, case-sensitive), exact?: bool=false (true = regex must match the FULL trimmed text of the component’s host node; false = substring match), root_index?: limit to one React root (default: all), max_matches?: cap (default 20, max 500) }. Returns { extensionId, tabId, matches: { stableId, displayName, key?, matchedText }[], truncated, rootCount }. Feed any stableId into react_get_state for that component’s props/state/hooks. Tool-level error on an invalid regex pattern. Runs in page-world via the page-bridge — no CDP, coexists with the user’s DevTools. CALL host_status FIRST to see which extensions are connected.",
    inputSchema: inputSchema$G,
    handler: reactFindByTextHandler,
});

const REACT_FIND_BY_ROLE_IPC_TIMEOUT_MS = 5000;
const inputSchema$F = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    role: stringType().min(1),
    name: stringType().min(1).optional(),
    root_index: numberType().int().nonnegative().optional(),
    max_matches: numberType().int().positive().max(500).optional(),
};
const isToolErrorPayload$e = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    const e = r['error'];
    return typeof e['message'] === 'string';
};
const isFindByRoleSuccess$1 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return (Array.isArray(r['matches']) &&
        typeof r['truncated'] === 'boolean' &&
        typeof r['rootCount'] === 'number');
};
const reactFindByRoleHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension at brave://extensions.',
        ]);
    }
    const wirePayload = { role: args.role };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.name !== undefined)
        wirePayload['name'] = args.name;
    if (args.root_index !== undefined)
        wirePayload['root_index'] = args.root_index;
    if (args.max_matches !== undefined)
        wirePayload['max_matches'] = args.max_matches;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'react_find_by_role',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: REACT_FIND_BY_ROLE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`react_find_by_role failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected to the host and the react_find_by_role handler is wired in the SW.',
        ]);
    }
    if (response.error) {
        return errorResponse(`react_find_by_role nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout (page-world not attached on chrome:// pages), or the page-world handler threw.',
        ]);
    }
    if (isToolErrorPayload$e(response.payload)) {
        return errorResponse(`react_find_by_role: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler (NOT a transport error). Most common: an invalid name regex — the name filter is compiled with new RegExp (no flags); fix the source and retry.',
        ]);
    }
    if (!isFindByRoleSuccess$1(response.payload)) {
        return errorResponse('react_find_by_role returned a malformed payload (missing matches/truncated/rootCount).', [
            'The page-world handler did not match the FindByRoleResult shape. Check packages/extension/src/react/find_by_role.ts.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        matches: response.payload.matches,
        truncated: response.payload.truncated,
        rootCount: response.payload.rootCount,
    };
    const nextSteps = [
        'matches[] contains { stableId, displayName, key?, role, name? }. Pass any stableId to react_get_state for that component’s props/state/hooks. Roles are matched against an explicit role attribute or a simplified implicit-role mapping (button, link, heading, navigation, region, textbox, checkbox, img, …).',
    ];
    if (response.payload.matches.length === 0) {
        nextSteps.push(response.payload.rootCount === 0
            ? 'rootCount===0 — no React roots detected. Verify the page renders React (try evaluate with __REACT_DEVTOOLS_GLOBAL_HOOK__) or that ReactDOM.createRoot has run.'
            : 'No components matched. Role comparison is exact and lowercase (ARIA role names). Confirm the role string, drop the name filter, or use react_find_by_text instead.');
    }
    if (args.root_index !== undefined &&
        args.root_index >= response.payload.rootCount) {
        nextSteps.push(`root_index=${args.root_index} is out of range — only ${response.payload.rootCount} root(s) exist. Re-call without root_index to search all roots.`);
    }
    if (response.payload.truncated) {
        nextSteps.push('truncated:true — max_matches (default 20) was reached before the walk finished. Raise max_matches or tighten role / name / root_index.');
    }
    return okResponse(data, nextSteps);
};
const reactFindByRoleTool = Object.freeze({
    name: 'react_find_by_role',
    description: "Find React components whose rendered host node has a given ARIA role, optionally narrowed by an accessible-name regex. Args: { extension_id?, tab_id?, role: required ARIA role string (e.g. 'button','link','heading','navigation','region','textbox','checkbox','img' — matched against an explicit role attribute or a simplified implicit-role mapping; exact, lowercase), name?: regex source string matched against the element’s accessible name (aria-label > first aria-labelledby ref > text content; compiled with new RegExp, no flags), root_index?: limit to one React root (default: all), max_matches?: cap (default 20, max 500) }. Returns { extensionId, tabId, matches: { stableId, displayName, key?, role, name? }[], truncated, rootCount }. Feed any stableId into react_get_state. Tool-level error on an invalid name regex. Runs in page-world via the page-bridge — no CDP, coexists with the user’s DevTools. CALL host_status FIRST to see which extensions are connected.",
    inputSchema: inputSchema$F,
    handler: reactFindByRoleHandler,
});

const VUE_TREE_IPC_TIMEOUT_MS = 5000;
const inputSchema$E = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    root_index: numberType().int().nonnegative().optional(),
    depth_limit: numberType().int().positive().max(64).optional(),
    max_nodes: numberType().int().positive().max(5000).optional(),
};
const isTreeNode = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return (typeof r['stableId'] === 'string' &&
        typeof r['displayName'] === 'string' &&
        typeof r['hasProps'] === 'boolean' &&
        typeof r['hasState'] === 'boolean' &&
        Array.isArray(r['children']));
};
const readPayload$2 = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (!Array.isArray(r['roots']))
        return null;
    if (typeof r['truncated'] !== 'boolean')
        return null;
    if (typeof r['rootCount'] !== 'number')
        return null;
    const roots = r['roots'].filter(isTreeNode);
    return Object.freeze({
        roots,
        truncated: r['truncated'],
        rootCount: r['rootCount'],
    });
};
const vueTreeHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension at brave://extensions so Chrome respawns the NMH.',
        ]);
    }
    const wirePayload = {};
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.root_index !== undefined)
        wirePayload['root_index'] = args.root_index;
    if (args.depth_limit !== undefined)
        wirePayload['depth_limit'] = args.depth_limit;
    if (args.max_nodes !== undefined)
        wirePayload['max_nodes'] = args.max_nodes;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'vue_tree',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: VUE_TREE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`vue_tree failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Check the extension service worker console; confirm the SW is connected to the host. If the SW responder is missing the vue_tree handler, the request will time out.',
        ]);
    }
    if (response.error) {
        return errorResponse(`vue_tree nmh error: ${response.error.message}`, [
            "NMH-mode rejected the request. Common causes: no active tab (open an http(s) tab to a Vue page), explicit tab_id not found, page-bridge timeout (page-world script not attached on chrome:// or chrome web store pages), or the page-world vue module threw. Inspect the SW console for [pwa-debug] errors.",
        ]);
    }
    const payload = readPayload$2(response.payload);
    if (payload === null) {
        return errorResponse('vue_tree returned a malformed payload (missing roots/truncated/rootCount).', [
            'The page-world handler returned a shape that does not match VueTreeResult. Check packages/extension/src/vue/serialize_tree.ts and confirm wire JSON encoding preserved the structure.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        roots: payload.roots,
        truncated: payload.truncated,
        rootCount: payload.rootCount,
    };
    const nextSteps = [
        'roots[] contains VueTreeNode { stableId, displayName, key?, hasProps, hasState, children }. Pass a stableId to vue_get_state to fetch the component\'s props + setup() bindings + options-API data. The id format is stable across re-renders that preserve identity — re-call vue_tree to refresh after structural changes; the same id resolves the same component.',
    ];
    if (payload.rootCount === 0) {
        nextSteps.push('rootCount===0 means no Vue app roots detected on the page. Verify the page mounts Vue 3 (a mount container carries __vue_app__) and that app.mount() has run before this call.');
    }
    if (args.root_index !== undefined && args.root_index >= payload.rootCount) {
        nextSteps.push(`root_index=${args.root_index} is out of range — only ${payload.rootCount} root(s) exist. Re-call without root_index to see all roots.`);
    }
    if (payload.truncated) {
        nextSteps.push('truncated:true — depth_limit or max_nodes was hit before the full tree was emitted. Re-call with higher depth_limit (default 8) or max_nodes (default 200), or pass a specific root_index to scope the walk.');
    }
    return okResponse(data, nextSteps);
};
const vueTreeTool = Object.freeze({
    name: 'vue_tree',
    description: "Return the Vue 3 component tree of the active (or specified) tab as a structured VueTreeNode[]. Each node has { stableId, displayName, key?, hasProps, hasState, children } where stableId is a re-render-stable component identity (path + name + key/index). Args: { extension_id?, tab_id?, root_index?: pick one root (default: all), depth_limit?: max depth (default 8, cap 64), max_nodes?: total cap (default 200, cap 5000) }. Returns { extensionId, tabId, roots, truncated, rootCount }. truncated:true means the walk hit depth_limit or max_nodes; re-call with a tighter root_index or higher caps. Pass any node's stableId to vue_get_state for that component's props/setupState/data. Runs in page-world (MAIN world) via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see which extensions are connected.",
    inputSchema: inputSchema$E,
    handler: vueTreeHandler,
});

const VUE_GET_STATE_IPC_TIMEOUT_MS = 5000;
const inputSchema$D = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    stable_id: stringType().min(1),
    include_props: booleanType().optional(),
    include_state: booleanType().optional(),
};
const isToolErrorPayload$d = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    const e = r['error'];
    return typeof e['message'] === 'string';
};
const isComponentSuccess = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return typeof r['stableId'] === 'string' && typeof r['displayName'] === 'string';
};
const vueGetStateHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension at brave://extensions.',
        ]);
    }
    const wirePayload = { stable_id: args.stable_id };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.include_props !== undefined)
        wirePayload['include_props'] = args.include_props;
    if (args.include_state !== undefined)
        wirePayload['include_state'] = args.include_state;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'vue_get_state',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: VUE_GET_STATE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`vue_get_state failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected to the host and the vue_get_state handler is wired in the SW.',
        ]);
    }
    if (response.error) {
        return errorResponse(`vue_get_state nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
        ]);
    }
    if (isToolErrorPayload$d(response.payload)) {
        return errorResponse(`vue_get_state: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler (NOT a transport error). Most common: stable_id not resolvable — re-call vue_tree to refresh ids; the Vue tree may have re-rendered into a different shape.',
        ]);
    }
    if (!isComponentSuccess(response.payload)) {
        return errorResponse('vue_get_state returned a malformed payload (missing stableId/displayName).', [
            'The page-world handler did not match the VueComponentInfo shape. Check packages/extension/src/vue/serialize_component.ts.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        ...response.payload,
    };
    const nextSteps = [
        'Component info shape: { stableId, displayName, key?, props?, setupState?, data?, truncated? }. setupState is the <script setup>/setup() binding object (refs auto-unwrapped); data is options-API reactive data. Values are serialized with a 16KB cap.',
    ];
    if (response.payload.truncated === true) {
        nextSteps.push('truncated:true — one or more of props/setupState/data exceeded the 16KB serializer cap. Re-call with include_props:false or include_state:false to isolate the bloated field, or use evaluate() to read a narrower projection.');
    }
    if (args.include_state === false) {
        nextSteps.push('include_state:false suppressed setupState + data; pass include_state:true (default) to retrieve them.');
    }
    return okResponse(data, nextSteps);
};
const vueGetStateTool = Object.freeze({
    name: 'vue_get_state',
    description: "Return the props, setup() bindings, and options-API data of a single Vue 3 component identified by stable_id (obtained from a prior vue_tree call). Args: { extension_id?, tab_id?, stable_id: required non-empty string, include_props?: bool=true, include_state?: bool=true }. Returns { extensionId, tabId, stableId, displayName, key?, props?, setupState?, data?, truncated? }. setupState holds <script setup>/setup() bindings (refs auto-unwrapped); data holds options-API reactive state. Empty surfaces are omitted. Tool-level error when stable_id no longer resolves — re-call vue_tree to refresh ids. Runs in page-world via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see connections.",
    inputSchema: inputSchema$D,
    handler: vueGetStateHandler,
});

const VUE_FIND_BY_TEXT_IPC_TIMEOUT_MS = 5000;
const inputSchema$C = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    pattern: stringType().min(1),
    exact: booleanType().optional(),
    root_index: numberType().int().nonnegative().optional(),
    max_matches: numberType().int().positive().max(500).optional(),
};
const isToolErrorPayload$c = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    const e = r['error'];
    return typeof e['message'] === 'string';
};
const isFindByTextSuccess = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return (Array.isArray(r['matches']) &&
        typeof r['truncated'] === 'boolean' &&
        typeof r['rootCount'] === 'number');
};
const vueFindByTextHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension at brave://extensions.',
        ]);
    }
    const wirePayload = { pattern: args.pattern };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.exact !== undefined)
        wirePayload['exact'] = args.exact;
    if (args.root_index !== undefined)
        wirePayload['root_index'] = args.root_index;
    if (args.max_matches !== undefined)
        wirePayload['max_matches'] = args.max_matches;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'vue_find_by_text',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: VUE_FIND_BY_TEXT_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`vue_find_by_text failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected to the host and the vue_find_by_text handler is wired in the SW.',
        ]);
    }
    if (response.error) {
        return errorResponse(`vue_find_by_text nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout (page-world not attached on chrome:// pages), or the page-world handler threw.',
        ]);
    }
    if (isToolErrorPayload$c(response.payload)) {
        return errorResponse(`vue_find_by_text: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler (NOT a transport error). Most common: an invalid regex pattern — the pattern is compiled with new RegExp (no flags); fix the source and retry.',
        ]);
    }
    if (!isFindByTextSuccess(response.payload)) {
        return errorResponse('vue_find_by_text returned a malformed payload (missing matches/truncated/rootCount).', [
            'The page-world handler did not match the FindVueByTextResult shape. Check packages/extension/src/vue/find_by_text.ts.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        matches: response.payload.matches,
        truncated: response.payload.truncated,
        rootCount: response.payload.rootCount,
    };
    const nextSteps = [
        'matches[] contains { stableId, displayName, key?, matchedText }. Pass any stableId to vue_get_state for that component\'s props/setupState/data. matchedText is the matched substring (or the full trimmed text when exact:true). Matches are de-duped to one entry per owning component.',
    ];
    if (response.payload.matches.length === 0) {
        nextSteps.push(response.payload.rootCount === 0
            ? 'rootCount===0 — no Vue app roots detected. Verify the page mounts Vue 3 (a mount container carries __vue_app__) and app.mount() has run.'
            : 'No components matched. The pattern is a JS regex source compiled with new RegExp (no flags, case-sensitive). Broaden it, or keep exact:false (default) for substring matching.');
    }
    if (args.root_index !== undefined &&
        args.root_index >= response.payload.rootCount) {
        nextSteps.push(`root_index=${args.root_index} is out of range — only ${response.payload.rootCount} root(s) exist. Re-call without root_index to search all roots.`);
    }
    if (response.payload.truncated) {
        nextSteps.push('truncated:true — max_matches (default 20) was reached before the walk finished. Raise max_matches or tighten the pattern / root_index.');
    }
    return okResponse(data, nextSteps);
};
const vueFindByTextTool = Object.freeze({
    name: 'vue_find_by_text',
    description: "Find Vue 3 components whose rendered DOM text matches a regex. Args: { extension_id?, tab_id?, pattern: required regex source string (compiled with new RegExp — no flags, case-sensitive), exact?: bool=false (true = regex must match the FULL trimmed text of a rendered element; false = substring match), root_index?: limit to one Vue root (default: all), max_matches?: cap (default 20, max 500) }. Returns { extensionId, tabId, matches: { stableId, displayName, key?, matchedText }[], truncated, rootCount }. Matching elements are mapped to their owning component (one entry per component). Feed any stableId into vue_get_state for that component's props/setupState/data. Tool-level error on an invalid regex pattern. Runs in page-world via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see which extensions are connected.",
    inputSchema: inputSchema$C,
    handler: vueFindByTextHandler,
});

const VUE_FIND_BY_ROLE_IPC_TIMEOUT_MS = 5000;
const inputSchema$B = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    role: stringType().min(1),
    name: stringType().min(1).optional(),
    root_index: numberType().int().nonnegative().optional(),
    max_matches: numberType().int().positive().max(500).optional(),
};
const isToolErrorPayload$b = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    const e = r['error'];
    return typeof e['message'] === 'string';
};
const isFindByRoleSuccess = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return (Array.isArray(r['matches']) &&
        typeof r['truncated'] === 'boolean' &&
        typeof r['rootCount'] === 'number');
};
const vueFindByRoleHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension at brave://extensions.',
        ]);
    }
    const wirePayload = { role: args.role };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.name !== undefined)
        wirePayload['name'] = args.name;
    if (args.root_index !== undefined)
        wirePayload['root_index'] = args.root_index;
    if (args.max_matches !== undefined)
        wirePayload['max_matches'] = args.max_matches;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'vue_find_by_role',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: VUE_FIND_BY_ROLE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`vue_find_by_role failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected to the host and the vue_find_by_role handler is wired in the SW.',
        ]);
    }
    if (response.error) {
        return errorResponse(`vue_find_by_role nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout (page-world not attached on chrome:// pages), or the page-world handler threw.',
        ]);
    }
    if (isToolErrorPayload$b(response.payload)) {
        return errorResponse(`vue_find_by_role: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler (NOT a transport error). Most common: an invalid name regex — the name filter is compiled with new RegExp (no flags); fix the source and retry.',
        ]);
    }
    if (!isFindByRoleSuccess(response.payload)) {
        return errorResponse('vue_find_by_role returned a malformed payload (missing matches/truncated/rootCount).', [
            'The page-world handler did not match the FindVueByRoleResult shape. Check packages/extension/src/vue/find_by_role.ts.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        matches: response.payload.matches,
        truncated: response.payload.truncated,
        rootCount: response.payload.rootCount,
    };
    const nextSteps = [
        'matches[] contains { stableId, displayName, key?, role, name? }. Pass any stableId to vue_get_state for that component\'s props/setupState/data. Roles are matched against an explicit role attribute or a simplified implicit-role mapping (button, link, heading, navigation, region, textbox, checkbox, img, …). Matches are de-duped to one entry per owning component.',
    ];
    if (response.payload.matches.length === 0) {
        nextSteps.push(response.payload.rootCount === 0
            ? 'rootCount===0 — no Vue app roots detected. Verify the page mounts Vue 3 (a mount container carries __vue_app__) and app.mount() has run.'
            : 'No components matched. Role comparison is exact and lowercase (ARIA role names). Confirm the role string, drop the name filter, or use vue_find_by_text instead.');
    }
    if (args.root_index !== undefined &&
        args.root_index >= response.payload.rootCount) {
        nextSteps.push(`root_index=${args.root_index} is out of range — only ${response.payload.rootCount} root(s) exist. Re-call without root_index to search all roots.`);
    }
    if (response.payload.truncated) {
        nextSteps.push('truncated:true — max_matches (default 20) was reached before the walk finished. Raise max_matches or tighten role / name / root_index.');
    }
    return okResponse(data, nextSteps);
};
const vueFindByRoleTool = Object.freeze({
    name: 'vue_find_by_role',
    description: "Find Vue 3 components whose rendered DOM node has a given ARIA role, optionally narrowed by an accessible-name regex. Args: { extension_id?, tab_id?, role: required ARIA role string (e.g. 'button','link','heading','navigation','region','textbox','checkbox','img' — matched against an explicit role attribute or a simplified implicit-role mapping; exact, lowercase), name?: regex source string matched against the element's accessible name (aria-label > first aria-labelledby ref > text content; compiled with new RegExp, no flags), root_index?: limit to one Vue root (default: all), max_matches?: cap (default 20, max 500) }. Returns { extensionId, tabId, matches: { stableId, displayName, key?, role, name? }[], truncated, rootCount }. Matching elements are mapped to their owning component (one entry per component). Feed any stableId into vue_get_state. Tool-level error on an invalid name regex. Runs in page-world via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see which extensions are connected.",
    inputSchema: inputSchema$B,
    handler: vueFindByRoleHandler,
});

const SVELTE_COMPONENTS_IPC_TIMEOUT_MS = 5000;
const inputSchema$A = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
};
const readPayload$1 = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r['present'] !== 'boolean' ||
        typeof r['dev'] !== 'boolean' ||
        typeof r['metaElementCount'] !== 'number' ||
        !Array.isArray(r['components'])) {
        return null;
    }
    return r;
};
const svelteComponentsMcpHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension at brave://extensions.',
        ]);
    }
    const wirePayload = {};
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'svelte_components',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: SVELTE_COMPONENTS_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`svelte_components failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the svelte_components handler is wired in the SW.',
        ]);
    }
    if (response.error) {
        return errorResponse(`svelte_components nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab or page-bridge timeout (page-world not attached on chrome:// pages).',
        ]);
    }
    const payload = readPayload$1(response.payload);
    if (payload === null) {
        return errorResponse('svelte_components returned a malformed payload.', [
            'The page-world handler did not match the expected shape. Check packages/extension/src/svelte/discover.ts.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        present: payload.present,
        dev: payload.dev,
        metaElementCount: payload.metaElementCount,
        components: payload.components,
    };
    const nextSteps = [
        'components[] contains { stableId, file, firstLoc?, elementCount }. Svelte is one component per .svelte file, so the file path IS the component identity (stableId). Feed a file into svelte_find_by_text/role results to cross-reference. NOTE: Svelte exposes no component-instance object, so there is no svelte_get_state — props/state are not generically readable.',
    ];
    if (!payload.present) {
        nextSteps.push('present:false — no Svelte detected. Verify the page actually runs Svelte.');
    }
    else if (!payload.dev) {
        nextSteps.push('present:true but dev:false — this looks like a PRODUCTION Svelte build. Component discovery relies on the dev-only __svelte_meta tags, which production strips, so components[] is empty. Introspection requires a dev build.');
    }
    return okResponse(data, nextSteps);
};
const svelteComponentsTool = Object.freeze({
    name: 'svelte_components',
    description: "List the Svelte components rendered on the active (or specified) tab. Args: { extension_id?, tab_id? }. Returns { extensionId, tabId, present, dev, metaElementCount, components: { stableId, file, firstLoc?, elementCount }[] }. Svelte compiles components to closures with no instance tree, so discovery uses the dev-only __svelte_meta source tags: each component == one .svelte file (the file path is its stableId), and elementCount is how many rendered elements belong to it. dev:false means a production build (no __svelte_meta) → components is empty. There is NO svelte_get_state (Svelte exposes no readable instance/state). Use svelte_find_by_text / svelte_find_by_role to locate components by content. Runs in page-world via the page-bridge — no CDP. CALL host_status FIRST.",
    inputSchema: inputSchema$A,
    handler: svelteComponentsMcpHandler,
});

const SVELTE_FIND_BY_TEXT_IPC_TIMEOUT_MS = 5000;
const inputSchema$z = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    pattern: stringType().min(1),
    exact: booleanType().optional(),
    max_matches: numberType().int().positive().max(500).optional(),
};
const isToolErrorPayload$a = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    return typeof r['error']['message'] === 'string';
};
const isFindSuccess$1 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return Array.isArray(r['matches']) && typeof r['truncated'] === 'boolean';
};
const svelteFindByTextMcpHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = { pattern: args.pattern };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.exact !== undefined)
        wirePayload['exact'] = args.exact;
    if (args.max_matches !== undefined)
        wirePayload['max_matches'] = args.max_matches;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'svelte_find_by_text',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: SVELTE_FIND_BY_TEXT_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`svelte_find_by_text failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the svelte_find_by_text handler is wired in the SW.',
        ]);
    }
    if (response.error) {
        return errorResponse(`svelte_find_by_text nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
        ]);
    }
    if (isToolErrorPayload$a(response.payload)) {
        return errorResponse(`svelte_find_by_text: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler. Most common: an invalid regex pattern (compiled with new RegExp, no flags).',
        ]);
    }
    if (!isFindSuccess$1(response.payload)) {
        return errorResponse('svelte_find_by_text returned a malformed payload (missing matches/truncated).', ['Check packages/extension/src/svelte/find_by_text.ts.']);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        matches: response.payload.matches,
        truncated: response.payload.truncated,
    };
    const nextSteps = [
        'matches[] contains { stableId, file, matchedText }, de-duped to one entry per owning component .svelte file (stableId === file). Svelte has no instance/state read; cross-reference file with svelte_components for element counts.',
    ];
    if (response.payload.matches.length === 0) {
        nextSteps.push('No matches. Either no component text matched (pattern is new RegExp, no flags, case-sensitive; keep exact:false for substring), OR this is a production build with no __svelte_meta — call svelte_components to check dev:true.');
    }
    if (response.payload.truncated) {
        nextSteps.push('truncated:true — max_matches (default 20) reached. Raise it or tighten the pattern.');
    }
    return okResponse(data, nextSteps);
};
const svelteFindByTextTool = Object.freeze({
    name: 'svelte_find_by_text',
    description: "Find Svelte components whose rendered DOM text matches a regex. Args: { extension_id?, tab_id?, pattern: regex source (new RegExp, no flags, case-sensitive), exact?: bool=false (full-text vs substring), max_matches?: cap (default 20, max 500) }. Returns { extensionId, tabId, matches: { stableId, file, matchedText }[], truncated }. Matches map to the owning component .svelte file (stableId === file), de-duped per file. DEV-mode only (relies on __svelte_meta); empty on production builds. No state read exists for Svelte. Runs in page-world via the page-bridge. CALL host_status FIRST.",
    inputSchema: inputSchema$z,
    handler: svelteFindByTextMcpHandler,
});

const SVELTE_FIND_BY_ROLE_IPC_TIMEOUT_MS = 5000;
const inputSchema$y = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    role: stringType().min(1),
    name: stringType().min(1).optional(),
    max_matches: numberType().int().positive().max(500).optional(),
};
const isToolErrorPayload$9 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    return typeof r['error']['message'] === 'string';
};
const isFindSuccess = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return Array.isArray(r['matches']) && typeof r['truncated'] === 'boolean';
};
const svelteFindByRoleMcpHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = { role: args.role };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.name !== undefined)
        wirePayload['name'] = args.name;
    if (args.max_matches !== undefined)
        wirePayload['max_matches'] = args.max_matches;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'svelte_find_by_role',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: SVELTE_FIND_BY_ROLE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`svelte_find_by_role failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the svelte_find_by_role handler is wired in the SW.',
        ]);
    }
    if (response.error) {
        return errorResponse(`svelte_find_by_role nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
        ]);
    }
    if (isToolErrorPayload$9(response.payload)) {
        return errorResponse(`svelte_find_by_role: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler. Most common: an invalid name regex (compiled with new RegExp, no flags).',
        ]);
    }
    if (!isFindSuccess(response.payload)) {
        return errorResponse('svelte_find_by_role returned a malformed payload (missing matches/truncated).', ['Check packages/extension/src/svelte/find_by_role.ts.']);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        matches: response.payload.matches,
        truncated: response.payload.truncated,
    };
    const nextSteps = [
        'matches[] contains { stableId, file, role, name? }, de-duped to one entry per owning component .svelte file. Roles use the shared simplified ARIA mapping (button, link, heading, region, textbox, …). Svelte has no instance/state read.',
    ];
    if (response.payload.matches.length === 0) {
        nextSteps.push('No matches. Either no element had that role (exact, lowercase ARIA names; drop the name filter), OR this is a production build with no __svelte_meta — call svelte_components to check dev:true.');
    }
    if (response.payload.truncated) {
        nextSteps.push('truncated:true — max_matches (default 20) reached. Raise it or tighten role / name.');
    }
    return okResponse(data, nextSteps);
};
const svelteFindByRoleTool = Object.freeze({
    name: 'svelte_find_by_role',
    description: "Find Svelte components whose rendered DOM node has a given ARIA role, optionally narrowed by an accessible-name regex. Args: { extension_id?, tab_id?, role: ARIA role string (exact, lowercase; explicit role attr or simplified implicit mapping), name?: regex source for the accessible name (new RegExp, no flags), max_matches?: cap (default 20, max 500) }. Returns { extensionId, tabId, matches: { stableId, file, role, name? }[], truncated }. Matches map to the owning component .svelte file (stableId === file), de-duped per file. DEV-mode only (relies on __svelte_meta). No state read exists for Svelte. Runs in page-world via the page-bridge. CALL host_status FIRST.",
    inputSchema: inputSchema$y,
    handler: svelteFindByRoleMcpHandler,
});

const SOLID_DETECT_IPC_TIMEOUT_MS = 5000;
const inputSchema$x = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
};
const readPayload = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r['present'] !== 'boolean' ||
        typeof r['devtoolsHook'] !== 'boolean' ||
        typeof r['hydration'] !== 'boolean' ||
        typeof r['delegatedEventCount'] !== 'number') {
        return null;
    }
    return r;
};
const solidDetectMcpHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = {};
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'solid_detect',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: SOLID_DETECT_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`solid_detect failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the solid_detect handler is wired in the SW.',
        ]);
    }
    if (response.error) {
        return errorResponse(`solid_detect nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab or page-bridge timeout.',
        ]);
    }
    const payload = readPayload(response.payload);
    if (payload === null) {
        return errorResponse('solid_detect returned a malformed payload.', [
            'The page-world handler did not match the expected shape. Check packages/extension/src/solid/detect.ts.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        present: payload.present,
        devtoolsHook: payload.devtoolsHook,
        hydration: payload.hydration,
        delegatedEventCount: payload.delegatedEventCount,
    };
    const nextSteps = [
        'Solid exposes NO persisted component tree and NO DOM->component pointer, so there is no solid_components / solid_get_state. Use solid_find_by_text / solid_find_by_role to locate DOM ELEMENTS (returned as locator + tag) on a Solid page — matches cannot be attributed to components without the @solid-devtools plugin.',
    ];
    if (!payload.present) {
        nextSteps.push('present:false — no Solid signals detected. Verify the page runs Solid.');
    }
    else if (!payload.devtoolsHook) {
        nextSteps.push('devtoolsHook:false — @solid-devtools is not installed on the page. Deep component/signal introspection is unavailable; only DOM-level find works. To get more, the app must add the solid-devtools plugin + import.');
    }
    else {
        nextSteps.push('devtoolsHook:true — @solid-devtools IS present. Its tree/signal data could be surfaced by a future bridge; today only detection + DOM-level find are wired.');
    }
    return okResponse(data, nextSteps);
};
const solidDetectTool = Object.freeze({
    name: 'solid_detect',
    description: "Detect SolidJS on the active (or specified) tab. Args: { extension_id?, tab_id? }. Returns { extensionId, tabId, present, devtoolsHook, hydration, delegatedEventCount }. Solid has no virtual DOM and no persisted component tree, so unlike React/Vue there is NO solid_components or solid_get_state — detection is best-effort (the @solid-devtools hook window.__SOLID_DEVTOOLS__, the _$HY hydration global, and a heuristic count of elements carrying Solid's $$-delegated-event props). devtoolsHook:true means @solid-devtools is installed (deeper data may be reachable). Use solid_find_by_text / solid_find_by_role for DOM-level element matching. Runs in page-world via the page-bridge. CALL host_status FIRST.",
    inputSchema: inputSchema$x,
    handler: solidDetectMcpHandler,
});

const SOLID_FIND_BY_TEXT_IPC_TIMEOUT_MS = 5000;
const inputSchema$w = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    pattern: stringType().min(1),
    exact: booleanType().optional(),
    max_matches: numberType().int().positive().max(500).optional(),
};
const isToolErrorPayload$8 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    return typeof r['error']['message'] === 'string';
};
const isSuccess$2 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return Array.isArray(r['matches']) && typeof r['truncated'] === 'boolean';
};
const solidFindByTextMcpHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = { pattern: args.pattern };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.exact !== undefined)
        wirePayload['exact'] = args.exact;
    if (args.max_matches !== undefined)
        wirePayload['max_matches'] = args.max_matches;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'solid_find_by_text',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: SOLID_FIND_BY_TEXT_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`solid_find_by_text failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the solid_find_by_text handler is wired in the SW.',
        ]);
    }
    if (response.error) {
        return errorResponse(`solid_find_by_text nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
        ]);
    }
    if (isToolErrorPayload$8(response.payload)) {
        return errorResponse(`solid_find_by_text: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler. Most common: an invalid regex pattern (new RegExp, no flags).',
        ]);
    }
    if (!isSuccess$2(response.payload)) {
        return errorResponse('solid_find_by_text returned a malformed payload (missing matches/truncated).', ['Check packages/extension/src/solid/find_by_text.ts.']);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        matches: response.payload.matches,
        truncated: response.payload.truncated,
    };
    const nextSteps = [
        'matches[] contains { locator, tag, matchedText } at the ELEMENT level — Solid exposes no component identity, so these are DOM nodes, not components. `locator` is a best-effort CSS-ish selector (tag#id / tag.class:nth-of-type(n)).',
    ];
    if (response.payload.matches.length === 0) {
        nextSteps.push('No matches. Pattern is new RegExp (no flags, case-sensitive); keep exact:false for substring. Confirm the page is a Solid app with solid_detect.');
    }
    if (response.payload.truncated) {
        nextSteps.push('truncated:true — max_matches (default 20) reached. Raise it or tighten the pattern.');
    }
    return okResponse(data, nextSteps);
};
const solidFindByTextTool = Object.freeze({
    name: 'solid_find_by_text',
    description: "Find DOM ELEMENTS whose rendered text matches a regex on a Solid page. Args: { extension_id?, tab_id?, pattern: regex source (new RegExp, no flags, case-sensitive), exact?: bool=false, max_matches?: cap (default 20, max 500) }. Returns { extensionId, tabId, matches: { locator, tag, matchedText }[], truncated }. NOTE: Solid has no component identity, so matches are ELEMENTS (locator = best-effort CSS-ish selector), NOT components — this is the documented Solid degradation. Runs in page-world via the page-bridge. CALL host_status FIRST.",
    inputSchema: inputSchema$w,
    handler: solidFindByTextMcpHandler,
});

const SOLID_FIND_BY_ROLE_IPC_TIMEOUT_MS = 5000;
const inputSchema$v = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    role: stringType().min(1),
    name: stringType().min(1).optional(),
    max_matches: numberType().int().positive().max(500).optional(),
};
const isToolErrorPayload$7 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    return typeof r['error']['message'] === 'string';
};
const isSuccess$1 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return Array.isArray(r['matches']) && typeof r['truncated'] === 'boolean';
};
const solidFindByRoleMcpHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = { role: args.role };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.name !== undefined)
        wirePayload['name'] = args.name;
    if (args.max_matches !== undefined)
        wirePayload['max_matches'] = args.max_matches;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'solid_find_by_role',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: SOLID_FIND_BY_ROLE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`solid_find_by_role failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the solid_find_by_role handler is wired in the SW.',
        ]);
    }
    if (response.error) {
        return errorResponse(`solid_find_by_role nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
        ]);
    }
    if (isToolErrorPayload$7(response.payload)) {
        return errorResponse(`solid_find_by_role: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler. Most common: an invalid name regex (new RegExp, no flags).',
        ]);
    }
    if (!isSuccess$1(response.payload)) {
        return errorResponse('solid_find_by_role returned a malformed payload (missing matches/truncated).', ['Check packages/extension/src/solid/find_by_role.ts.']);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        matches: response.payload.matches,
        truncated: response.payload.truncated,
    };
    const nextSteps = [
        'matches[] contains { locator, tag, role, name? } at the ELEMENT level — Solid exposes no component identity, so these are DOM nodes, not components (documented Solid degradation). Roles use the shared simplified ARIA mapping.',
    ];
    if (response.payload.matches.length === 0) {
        nextSteps.push('No matches. Roles are exact, lowercase ARIA names; drop the name filter to broaden. Confirm the page is a Solid app with solid_detect.');
    }
    if (response.payload.truncated) {
        nextSteps.push('truncated:true — max_matches (default 20) reached. Raise it or tighten role / name.');
    }
    return okResponse(data, nextSteps);
};
const solidFindByRoleTool = Object.freeze({
    name: 'solid_find_by_role',
    description: "Find DOM ELEMENTS with a given ARIA role on a Solid page, optionally narrowed by an accessible-name regex. Args: { extension_id?, tab_id?, role: ARIA role string (exact, lowercase), name?: regex source (new RegExp, no flags), max_matches?: cap (default 20, max 500) }. Returns { extensionId, tabId, matches: { locator, tag, role, name? }[], truncated }. NOTE: Solid has no component identity, so matches are ELEMENTS (locator = best-effort CSS-ish selector), NOT components — documented Solid degradation. Runs in page-world via the page-bridge. CALL host_status FIRST.",
    inputSchema: inputSchema$v,
    handler: solidFindByRoleMcpHandler,
});

const REDUX_GET_STATE_IPC_TIMEOUT_MS = 5000;
const inputSchema$u = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    path: stringType().min(1).optional(),
};
const isToolErrorPayload$6 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    const e = r['error'];
    return typeof e['message'] === 'string';
};
const isStoreSuccess$1 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return 'state' in r && typeof r['scopeUrl'] === 'string';
};
const reduxGetStateHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = {};
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.path !== undefined)
        wirePayload['path'] = args.path;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'redux_get_state',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: REDUX_GET_STATE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`redux_get_state failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the redux_get_state handler is wired in the SW.',
        ]);
    }
    if (response.error) {
        return errorResponse(`redux_get_state nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
        ]);
    }
    if (isToolErrorPayload$6(response.payload)) {
        return errorResponse(`redux_get_state: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler. Common causes: no Redux store detected on the page (the fixture must expose it via window.__pwaDebug_redux, or T2 production-style detection via the __REDUX_DEVTOOLS_EXTENSION__ shim must be in place); malformed path; descent into a primitive.',
        ]);
    }
    if (!isStoreSuccess$1(response.payload)) {
        return errorResponse('redux_get_state returned a malformed payload (missing state/scopeUrl).', [
            'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts redux_get_state branch.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        ...response.payload,
    };
    const nextSteps = [
        'Store value shape: { extensionId, tabId, state, path?, truncated?, scopeUrl }. The state field is the live store snapshot, optionally pruned to the path argument. truncated:true means the snapshot exceeded the 16KB serializer cap — pass a path to narrow it.',
    ];
    if (response.payload.truncated === true) {
        nextSteps.push('truncated:true — the returned value exceeded the 16KB serializer cap and was replaced with a {__type:"Truncated", approxSize, max} placeholder. Re-call with a narrower path argument (e.g., counter.value) to retrieve a smaller slice.');
    }
    return okResponse(data, nextSteps);
};
const reduxGetStateTool = Object.freeze({
    name: 'redux_get_state',
    description: "DEPRECATED — prefer store_get_state (unified, framework auto-detect). Return the current Redux store state from the active tab, optionally pruned to a dotted/bracket path. Args: { extension_id?, tab_id?, path?: 'counter.value' | 'todos[0].text' | \"users['by-id']\" }. Returns { extensionId, tabId, state, path?, truncated?, scopeUrl }. Runs in page-world via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see connections.",
    inputSchema: inputSchema$u,
    handler: reduxGetStateHandler,
});

const REDUX_SUBSCRIBE_IPC_TIMEOUT_MS = 5000;
const inputSchema$t = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    action: enumType(['start', 'stop']),
    path: stringType().min(1).optional(),
};
const isToolErrorPayload$5 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    const e = r['error'];
    return typeof e['message'] === 'string';
};
const isSubscribeSuccess$1 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return typeof r['active'] === 'boolean' && typeof r['scopeUrl'] === 'string';
};
const reduxSubscribeHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = { action: args.action };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.path !== undefined)
        wirePayload['path'] = args.path;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'redux_subscribe',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: REDUX_SUBSCRIBE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`redux_subscribe failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect).',
        ]);
    }
    if (response.error) {
        return errorResponse(`redux_subscribe nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
        ]);
    }
    if (isToolErrorPayload$5(response.payload)) {
        return errorResponse(`redux_subscribe: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler. Common causes: no Redux store detected; malformed path.',
        ]);
    }
    if (!isSubscribeSuccess$1(response.payload)) {
        return errorResponse('redux_subscribe returned a malformed payload (missing active/scopeUrl).', [
            'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts reduxSubscribeHandler.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        ...response.payload,
    };
    const nextSteps = [];
    if (response.payload.active) {
        nextSteps.push('Subscription active. Call redux_tail to read accumulated store_change events. Re-call redux_subscribe with action="start" + a new path to swap the subscription (idempotent re-config). Call action="stop" to tear it down.');
    }
    else {
        nextSteps.push('Subscription inactive. action="start" was not called or the most recent call was "stop".');
    }
    return okResponse(data, nextSteps);
};
const reduxSubscribeTool = Object.freeze({
    name: 'redux_subscribe',
    description: "DEPRECATED — prefer store_subscribe (unified, framework auto-detect). Start or stop a Redux store subscription on the active tab. While active, each store.subscribe callback whose path-narrowed snapshot differs from the prior snapshot emits a store_change event that flows through the standard capture pipeline; read accumulated events via redux_tail. Args: { extension_id?, tab_id?, action: 'start' | 'stop', path?: 'counter' | 'todos.items' }. Returns { extensionId, tabId, active, path?, scopeUrl }. Single subscription per page-world; calling action='start' again replaces any prior subscription. CALL host_status FIRST to see connections.",
    inputSchema: inputSchema$t,
    handler: reduxSubscribeHandler,
});

const inputSchema$s = {
    extension_id: stringType().min(1).optional(),
    filter: filterSchema,
};
const reduxTailHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension.',
            FILTER_SPEC_HINT,
        ]);
    }
    const captures = ctx.capturesRegistry.get(target.extensionId);
    if (captures === undefined) {
        return okResponse({ entries: [], cursor: null, hasMore: false }, [
            `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. Call redux_subscribe(action="start") first, then dispatch in the page to produce store_change events.`,
            FILTER_SPEC_HINT,
        ]);
    }
    const sessionId = captures.getStats().sessionId;
    const storeBuffer = captures.buffer('store_change');
    const filterSpec = toFilterSpec(args.filter);
    const result = await tailWithFilterMerged({
        buffer: storeBuffer,
        spec: filterSpec,
        ctx: { currentSessionId: sessionId },
        kind: 'store_change',
    });
    if (!result.ok) {
        return tailErrorToResponse(result.error);
    }
    const entries = result.entries.map((e) => ({
        ...e,
        cursor: encodeCursor({
            sessionId: e.sessionId,
            sequenceNumber: e.sequenceNumber,
        }),
    }));
    const nextSteps = [
        `Returned ${entries.length} StoreChangeEntry record(s) for extension ${target.extensionId} (host session ${sessionId}). Each entry carries page-world fields (ts, frameUrl, frameKey, storeId, path?, diff, snapshot, truncated?) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor).`,
    ];
    if (result.hasMore) {
        nextSteps.push(`hasMore=true: more matching events exist beyond limit. Page forward by passing the response top-level cursor as filter.since on your next call.`);
    }
    else if (result.cursor === null) {
        nextSteps.push('No store_change events match the current filter; cursor is null. Confirm redux_subscribe(action="start") is active and at least one dispatch has occurred.');
    }
    else {
        nextSteps.push('Latest tail returned (hasMore=false). To poll for new events as they arrive, retry with filter.since=cursor (top-level field of this response).');
    }
    nextSteps.push(FILTER_SPEC_HINT);
    return okResponse({ entries, cursor: result.cursor, hasMore: result.hasMore }, nextSteps);
};
const reduxTailTool = Object.freeze({
    name: 'redux_tail',
    description: "DEPRECATED — prefer store_tail (unified, framework-tagged entries). Tail the host-side store_change ring buffer (populated while redux_subscribe is active) for a target extension. Returns { entries: StoreChangeEntry[]; cursor: Cursor|null; hasMore: bool }. Each StoreChangeEntry carries page-world fields (ts, frameUrl, frameKey, storeId, path?, diff{added, changed, removed}, snapshot, truncated?) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). FilterSpec (all optional): pattern={include?: regex sources[], exclude?: regex sources[]}; since/until=opaque cursor strings; limit=int 1..1000 (default 200). level is ignored (store_change has no console-level field). Call redux_subscribe(action='start') first to start producing events.",
    inputSchema: inputSchema$s,
    handler: reduxTailHandler,
});

const REDUX_DISPATCH_IPC_TIMEOUT_MS = 5000;
const inputSchema$r = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    action: objectType({
        type: stringType().min(1),
        payload: unknownType().optional(),
    }),
};
const isToolErrorPayload$4 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    const e = r['error'];
    return typeof e['message'] === 'string';
};
const isDispatchSuccess$1 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return r['dispatched'] === true && typeof r['scopeUrl'] === 'string';
};
const reduxDispatchHandler = async (args, ctx) => {
    // Setting gate FIRST — never even build an IPC envelope if disabled.
    const allowed = ctx.settingsStore.getSetting('capture.stores.allowDispatch');
    if (allowed !== true) {
        return errorResponse('redux_dispatch is disabled (capture.stores.allowDispatch=false).', [
            "Enable writes via settings.set { key: 'capture.stores.allowDispatch', value: true } and retry. Default false because dispatching mutates user-visible application state; only opt in when intentionally driving the app from the AI side.",
        ]);
    }
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called.',
        ]);
    }
    const wirePayload = { action: args.action };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'redux_dispatch',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: REDUX_DISPATCH_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`redux_dispatch failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect).',
        ]);
    }
    if (response.error) {
        return errorResponse(`redux_dispatch nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
        ]);
    }
    if (isToolErrorPayload$4(response.payload)) {
        return errorResponse(`redux_dispatch: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler. Common causes: no Redux store detected; malformed action; store.dispatch threw (e.g. an unknown action.type slipped through a stricter user reducer).',
        ]);
    }
    if (!isDispatchSuccess$1(response.payload)) {
        return errorResponse('redux_dispatch returned a malformed payload (missing dispatched/scopeUrl).', [
            'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts reduxDispatchHandler.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        ...response.payload,
    };
    return okResponse(data, [
        'Action dispatched. Call redux_get_state (optionally with a path) to verify the post-state, or redux_tail to read the resulting store_change events if redux_subscribe is active.',
    ]);
};
const reduxDispatchTool = Object.freeze({
    name: 'redux_dispatch',
    description: "DEPRECATED — prefer store_dispatch (unified, framework auto-detect). Dispatch an action into the active Redux store (the only WRITE surface in the store-introspection family). DISABLED BY DEFAULT — opt in via settings.set { key: 'capture.stores.allowDispatch', value: true }. Args: { extension_id?, tab_id?, action: { type: non-empty string; payload? } }. Returns { extensionId, tabId, dispatched: true, action, scopeUrl } on success. Tool-level errors (no store detected; user reducer threw) follow the same { error: { message } } convention as redux_get_state. CALL host_status FIRST to see connections.",
    inputSchema: inputSchema$r,
    handler: reduxDispatchHandler,
});

/**
 * Shared host-side request helper for the unified store_* MCP tools (Path 4
 * M2). Centralizes the target-resolution + IPC request + standard error
 * mapping that store_get_state / store_subscribe / store_dispatch all repeat,
 * so each tool file stays a thin schema + payload-shaping + success-validation
 * orchestrator. The legacy redux_* tools are intentionally left on their own
 * inline boilerplate (no behavior change); future cleanup can migrate them.
 *
 * The optional `framework` selector is threaded into the wire payload only when
 * supplied — when absent, the page-world registry auto-detects the live store.
 */
const DEFAULT_STORE_IPC_TIMEOUT_MS = 5000;
const isToolErrorPayload$3 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    const e = r['error'];
    return typeof e['message'] === 'string';
};
/**
 * Resolve the target NMH, send the store tool's IPC request, and map every
 * failure mode (no connection, transport error, NMH-level error, page-world
 * tool-level error) to a ready-to-return errorResponse. On success returns the
 * raw page-world payload plus the resolved extensionId/tabId for the caller to
 * shape and validate.
 */
const requestStoreTool = async (ctx, args) => {
    const target = resolveTarget$1(ctx, args.extensionId);
    if (!target.ok) {
        return {
            ok: false,
            response: errorResponse(target.error, [
                'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
            ]),
        };
    }
    const wirePayload = { ...(args.payload ?? {}) };
    if (args.tabId !== undefined)
        wirePayload['tab_id'] = args.tabId;
    if (args.framework !== undefined)
        wirePayload['framework'] = args.framework;
    const env = Object.freeze({
        type: 'request',
        requestId: randomUUID(),
        tool: args.wireTool,
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: args.timeoutMs ?? DEFAULT_STORE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return {
            ok: false,
            response: errorResponse(`${args.toolName} failed: ${err.message}`, [
                'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the store handler is wired in the SW.',
            ]),
        };
    }
    if (response.error) {
        return {
            ok: false,
            response: errorResponse(`${args.toolName} nmh error: ${response.error.message}`, [
                'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
            ]),
        };
    }
    if (isToolErrorPayload$3(response.payload)) {
        return {
            ok: false,
            response: errorResponse(`${args.toolName}: ${response.payload.error.message}`, [
                "Tool-level error from the page-world handler. Common causes: no supported store detected on the page (e.g. Redux on window.__pwaDebug_redux or via the __REDUX_DEVTOOLS_EXTENSION__ shim); a malformed path; or, when an explicit framework arg was passed, no adapter registered for that framework.",
            ]),
        };
    }
    return {
        ok: true,
        payload: response.payload,
        extensionId: target.extensionId,
        tabId: args.tabId ?? null,
    };
};

const inputSchema$q = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    path: stringType().min(1).optional(),
    framework: stringType().min(1).optional(),
};
const isStoreSuccess = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return 'state' in r && typeof r['scopeUrl'] === 'string';
};
const storeGetStateHandler = async (args, ctx) => {
    const result = await requestStoreTool(ctx, {
        toolName: 'store_get_state',
        wireTool: 'store_get_state',
        ...(args.extension_id !== undefined ? { extensionId: args.extension_id } : {}),
        ...(args.tab_id !== undefined ? { tabId: args.tab_id } : {}),
        ...(args.framework !== undefined ? { framework: args.framework } : {}),
        payload: args.path !== undefined ? { path: args.path } : {},
    });
    if (!result.ok)
        return result.response;
    if (!isStoreSuccess(result.payload)) {
        return errorResponse('store_get_state returned a malformed payload (missing state/scopeUrl).', [
            'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts store_get_state branch.',
        ]);
    }
    const data = {
        extensionId: result.extensionId,
        tabId: result.tabId,
        ...result.payload,
    };
    const nextSteps = [
        'Store value shape: { extensionId, tabId, framework, state, path?, truncated?, scopeUrl }. framework names the detected store library (e.g. "redux"). state is the live snapshot, optionally pruned to the path argument. Pass framework to force a specific adapter; omit it to auto-detect.',
    ];
    if (result.payload.truncated === true) {
        nextSteps.push('truncated:true — the returned value exceeded the 16KB serializer cap and was replaced with a {__type:"Truncated", approxSize, max} placeholder. Re-call with a narrower path argument (e.g. counter.value) to retrieve a smaller slice.');
    }
    return okResponse(data, nextSteps);
};
const storeGetStateTool = Object.freeze({
    name: 'store_get_state',
    description: "Return the current state of the active tab's JS store, optionally pruned to a dotted/bracket path. Auto-detects the store framework (Redux today; Zustand/Pinia/Jotai as adapters land), or pass framework to force one. Args: { extension_id?, tab_id?, path?: 'counter.value' | 'todos[0].text', framework?: 'redux' }. Returns { extensionId, tabId, framework, state, path?, truncated?, scopeUrl }. Runs in page-world via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see connections.",
    inputSchema: inputSchema$q,
    handler: storeGetStateHandler,
});

const inputSchema$p = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    framework: stringType().min(1).optional(),
    action: enumType(['start', 'stop']),
    path: stringType().min(1).optional(),
};
const isSubscribeSuccess = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return typeof r['active'] === 'boolean' && typeof r['scopeUrl'] === 'string';
};
const storeSubscribeHandler = async (args, ctx) => {
    const wirePayload = { action: args.action };
    if (args.path !== undefined)
        wirePayload['path'] = args.path;
    const result = await requestStoreTool(ctx, {
        toolName: 'store_subscribe',
        wireTool: 'store_subscribe',
        ...(args.extension_id !== undefined ? { extensionId: args.extension_id } : {}),
        ...(args.tab_id !== undefined ? { tabId: args.tab_id } : {}),
        ...(args.framework !== undefined ? { framework: args.framework } : {}),
        payload: wirePayload,
    });
    if (!result.ok)
        return result.response;
    if (!isSubscribeSuccess(result.payload)) {
        return errorResponse('store_subscribe returned a malformed payload (missing active/scopeUrl).', [
            'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts store_subscribe branch.',
        ]);
    }
    const data = {
        extensionId: result.extensionId,
        tabId: result.tabId,
        ...result.payload,
    };
    const nextSteps = [];
    if (result.payload.active) {
        nextSteps.push('Subscription active (framework field names the detected store). Call store_tail to read accumulated store_change events. Re-call store_subscribe with action="start" + a new path to swap the subscription (idempotent re-config). Call action="stop" to tear it down.');
    }
    else {
        nextSteps.push('Subscription inactive. action="start" was not called or the most recent call was "stop".');
    }
    return okResponse(data, nextSteps);
};
const storeSubscribeTool = Object.freeze({
    name: 'store_subscribe',
    description: "Start or stop a store subscription on the active tab. While active, each store change whose path-narrowed snapshot differs from the prior snapshot emits a store_change event (tagged with the detecting framework) that flows through the standard capture pipeline; read accumulated events via store_tail. Auto-detects the framework or pass framework to force one. Args: { extension_id?, tab_id?, framework?, action: 'start' | 'stop', path?: 'counter' | 'todos.items' }. Returns { extensionId, tabId, active, framework?, path?, scopeUrl }. Single subscription per page-world; calling action='start' again replaces any prior subscription. CALL host_status FIRST to see connections.",
    inputSchema: inputSchema$p,
    handler: storeSubscribeHandler,
});

const inputSchema$o = {
    extension_id: stringType().min(1).optional(),
    filter: filterSchema,
};
const storeTailHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension.',
            FILTER_SPEC_HINT,
        ]);
    }
    const captures = ctx.capturesRegistry.get(target.extensionId);
    if (captures === undefined) {
        return okResponse({ entries: [], cursor: null, hasMore: false }, [
            `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. Call store_subscribe(action="start") first, then mutate the store in the page to produce store_change events.`,
            FILTER_SPEC_HINT,
        ]);
    }
    const sessionId = captures.getStats().sessionId;
    const storeBuffer = captures.buffer('store_change');
    const filterSpec = toFilterSpec(args.filter);
    const result = await tailWithFilterMerged({
        buffer: storeBuffer,
        spec: filterSpec,
        ctx: { currentSessionId: sessionId },
        kind: 'store_change',
    });
    if (!result.ok) {
        return tailErrorToResponse(result.error);
    }
    const entries = result.entries.map((e) => ({
        ...e,
        cursor: encodeCursor({
            sessionId: e.sessionId,
            sequenceNumber: e.sequenceNumber,
        }),
    }));
    const nextSteps = [
        `Returned ${entries.length} StoreChangeEntry record(s) for extension ${target.extensionId} (host session ${sessionId}). Each entry carries page-world fields (ts, frameUrl, frameKey, storeId, framework?, path?, diff, snapshot, truncated?) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). framework names the store library that produced the event.`,
    ];
    if (result.hasMore) {
        nextSteps.push(`hasMore=true: more matching events exist beyond limit. Page forward by passing the response top-level cursor as filter.since on your next call.`);
    }
    else if (result.cursor === null) {
        nextSteps.push('No store_change events match the current filter; cursor is null. Confirm store_subscribe(action="start") is active and at least one store change has occurred.');
    }
    else {
        nextSteps.push('Latest tail returned (hasMore=false). To poll for new events as they arrive, retry with filter.since=cursor (top-level field of this response).');
    }
    nextSteps.push(FILTER_SPEC_HINT);
    return okResponse({ entries, cursor: result.cursor, hasMore: result.hasMore }, nextSteps);
};
const storeTailTool = Object.freeze({
    name: 'store_tail',
    description: "Tail the host-side store_change ring buffer (populated while store_subscribe is active) for a target extension. Framework-agnostic: each entry's framework field names the store library that produced it. Returns { entries: StoreChangeEntry[]; cursor: Cursor|null; hasMore: bool }. Each StoreChangeEntry carries page-world fields (ts, frameUrl, frameKey, storeId, framework?, path?, diff{added, changed, removed}, snapshot, truncated?) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). FilterSpec (all optional): pattern={include?: regex sources[], exclude?: regex sources[]}; since/until=opaque cursor strings; limit=int 1..1000 (default 200). level is ignored (store_change has no console-level field). Call store_subscribe(action='start') first to start producing events.",
    inputSchema: inputSchema$o,
    handler: storeTailHandler,
});

const inputSchema$n = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    framework: stringType().min(1).optional(),
    action: objectType({
        type: stringType().min(1),
        payload: unknownType().optional(),
    }),
};
const isDispatchSuccess = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return r['dispatched'] === true && typeof r['scopeUrl'] === 'string';
};
const storeDispatchHandler = async (args, ctx) => {
    // Setting gate FIRST — never even build an IPC envelope if disabled.
    const allowed = ctx.settingsStore.getSetting('capture.stores.allowDispatch');
    if (allowed !== true) {
        return errorResponse('store_dispatch is disabled (capture.stores.allowDispatch=false).', [
            "Enable writes via settings.set { key: 'capture.stores.allowDispatch', value: true } and retry. Default false because dispatching mutates user-visible application state; only opt in when intentionally driving the app from the AI side.",
        ]);
    }
    const result = await requestStoreTool(ctx, {
        toolName: 'store_dispatch',
        wireTool: 'store_dispatch',
        ...(args.extension_id !== undefined ? { extensionId: args.extension_id } : {}),
        ...(args.tab_id !== undefined ? { tabId: args.tab_id } : {}),
        ...(args.framework !== undefined ? { framework: args.framework } : {}),
        payload: { action: args.action },
    });
    if (!result.ok)
        return result.response;
    if (!isDispatchSuccess(result.payload)) {
        return errorResponse('store_dispatch returned a malformed payload (missing dispatched/scopeUrl).', [
            'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts store_dispatch branch.',
        ]);
    }
    const data = {
        extensionId: result.extensionId,
        tabId: result.tabId,
        ...result.payload,
    };
    return okResponse(data, [
        'Action dispatched (framework field names the target store). Call store_get_state (optionally with a path) to verify the post-state, or store_tail to read the resulting store_change events if store_subscribe is active.',
    ]);
};
const storeDispatchTool = Object.freeze({
    name: 'store_dispatch',
    description: "Dispatch an action into the active tab's store (the only WRITE surface in the store-introspection family). DISABLED BY DEFAULT — opt in via settings.set { key: 'capture.stores.allowDispatch', value: true }. Auto-detects the framework or pass framework to force one. Args: { extension_id?, tab_id?, framework?, action: { type: non-empty string; payload? } }. Returns { extensionId, tabId, dispatched: true, framework, action, scopeUrl }. Note: stores without a Redux-style dispatch (e.g. some Zustand/Jotai setups) return a tool-level error from the page-world handler. CALL host_status FIRST to see connections.",
    inputSchema: inputSchema$n,
    handler: storeDispatchHandler,
});

const SOURCE_MAP_RESOLVE_IPC_TIMEOUT_MS = 8000;
const inputSchema$m = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    script_url: stringType().min(1),
    line: numberType().int().min(1),
    column: numberType().int().min(0),
};
const isToolErrorPayload$2 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    const e = r['error'];
    return typeof e['message'] === 'string';
};
const isSuccess = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return typeof r['scopeUrl'] === 'string';
};
const sourceMapResolveHandler = async (args, ctx) => {
    const enabled = ctx.settingsStore.getSetting('capture.sourceMap.enabled');
    if (enabled !== true) {
        return errorResponse('source_map_resolve is disabled (capture.sourceMap.enabled=false).', [
            "Enable via settings.set { key: 'capture.sourceMap.enabled', value: true } and retry. Default is true; the setting exists so users can opt out of the script + map fetch overhead in privacy-sensitive sessions.",
        ]);
    }
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called.',
        ]);
    }
    const wirePayload = {
        script_url: args.script_url,
        line: args.line,
        column: args.column,
    };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'source_map_resolve',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: SOURCE_MAP_RESOLVE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`source_map_resolve failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Script + map fetch can take longer than other tools; the 8s timeout reflects that.',
        ]);
    }
    if (response.error) {
        return errorResponse(`source_map_resolve nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout.',
        ]);
    }
    if (isToolErrorPayload$2(response.payload)) {
        return errorResponse(`source_map_resolve: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler. Common causes: script fetch failed (CORS or 4xx/5xx); malformed input.',
        ]);
    }
    if (!isSuccess(response.payload)) {
        return errorResponse('source_map_resolve returned a malformed payload (missing scopeUrl).', [
            'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts sourceMapResolveHandler.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        ...response.payload,
    };
    const nextSteps = [];
    if (response.payload.original !== undefined) {
        const f = response.payload.original;
        nextSteps.push(`Resolved to ${f.source}:${f.line}:${f.column}${f.name !== undefined ? ` (${f.name})` : ''}.`);
    }
    else {
        nextSteps.push('No mapping returned. Either the script has no sourceMappingURL comment, the .map URL was unreachable, or the (line, column) fell outside the map\'s segments. Call console_tail to see what raw frames look like; they typically include script_url, line, column you can pass back here.');
    }
    return okResponse(data, nextSteps);
};
const sourceMapResolveTool = Object.freeze({
    name: 'source_map_resolve',
    description: "Resolve a single generated stack frame (script_url + line + column) to its original-source location using the script's source map. Args: { extension_id?, tab_id?, script_url: non-empty string, line: int >= 1, column: int >= 0 }. Returns { extensionId, tabId, original?: { source, line, column, name? }, scopeUrl }. original is undefined when no map is available or no mapping exists at the requested coordinates. Disabled via capture.sourceMap.enabled=false. M13 ships query-time resolution; M13.5 will add capture-time auto-annotation when needed.",
    inputSchema: inputSchema$m,
    handler: sourceMapResolveHandler,
});

const SESSION_RECORD_IPC_TIMEOUT_MS = 5000;
const inputSchema$l = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    action: enumType(['start', 'stop']),
    session_id: stringType().min(1).optional(),
    duration_cap_ms: numberType().int().positive().optional(),
};
const isToolErrorPayload$1 = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    if (r['error'] === null || typeof r['error'] !== 'object')
        return false;
    const e = r['error'];
    return typeof e['message'] === 'string';
};
const isRecordSuccess = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return typeof r['active'] === 'boolean' && typeof r['scopeUrl'] === 'string';
};
const sessionRecordHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called.',
        ]);
    }
    const wirePayload = { action: args.action };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.session_id !== undefined)
        wirePayload['session_id'] = args.session_id;
    if (args.duration_cap_ms !== undefined)
        wirePayload['duration_cap_ms'] = args.duration_cap_ms;
    const requestId = randomUUID();
    const env = Object.freeze({
        type: 'request',
        requestId,
        tool: 'session_record',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: SESSION_RECORD_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`session_record failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect).',
        ]);
    }
    if (response.error) {
        return errorResponse(`session_record nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout.',
        ]);
    }
    if (isToolErrorPayload$1(response.payload)) {
        return errorResponse(`session_record: ${response.payload.error.message}`, [
            'Tool-level error from the page-world handler.',
        ]);
    }
    if (!isRecordSuccess(response.payload)) {
        return errorResponse('session_record returned a malformed payload (missing active/scopeUrl).', ['The page-world handler did not match the expected shape.']);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        ...response.payload,
    };
    const nextSteps = [];
    if (response.payload.active) {
        nextSteps.push('Recording active. rrweb events accumulate in the host store_change ... actually the "replay" ring buffer; call session_replay to read them with cursor pagination. Re-call session_record(start) to replace the recording with a new sessionId; call session_record(stop) to tear it down.');
        if (response.payload.durationCapMs !== undefined) {
            nextSteps.push(`durationCapMs=${response.payload.durationCapMs} — recording will auto-stop after this many ms.`);
        }
    }
    else {
        nextSteps.push('Recording inactive. Either action="stop" was called or no recording was ever started.');
    }
    return okResponse(data, nextSteps);
};
const sessionRecordTool = Object.freeze({
    name: 'session_record',
    description: "Start or stop a rrweb session recording on the active tab. Each recorded event flows through the capture pipeline as a 'replay' CaptureKind and accumulates in the host replay ring buffer (readable via session_replay). Args: { extension_id?, tab_id?, action: 'start' | 'stop', session_id?: stable id for grouping (auto-generated when missing), duration_cap_ms?: int > 0 (auto-stop deadline) }. Single recording per page-world; action='start' replaces any prior recording. CALL host_status FIRST to see connections.",
    inputSchema: inputSchema$l,
    handler: sessionRecordHandler,
});

const inputSchema$k = {
    extension_id: stringType().min(1).optional(),
    filter: filterSchema,
};
const sessionReplayHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called.',
            FILTER_SPEC_HINT,
        ]);
    }
    const captures = ctx.capturesRegistry.get(target.extensionId);
    if (captures === undefined) {
        return okResponse({ entries: [], cursor: null, hasMore: false }, [
            `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. Call session_record(action="start") first.`,
            FILTER_SPEC_HINT,
        ]);
    }
    const sessionId = captures.getStats().sessionId;
    const replayBuffer = captures.buffer('replay');
    const filterSpec = toFilterSpec(args.filter);
    const result = await tailWithFilterMerged({
        buffer: replayBuffer,
        spec: filterSpec,
        ctx: { currentSessionId: sessionId },
        kind: 'replay',
    });
    if (!result.ok) {
        return tailErrorToResponse(result.error);
    }
    const entries = result.entries.map((e) => ({
        ...e,
        cursor: encodeCursor({
            sessionId: e.sessionId,
            sequenceNumber: e.sequenceNumber,
        }),
    }));
    const nextSteps = [
        `Returned ${entries.length} ReplayEntry record(s) for extension ${target.extensionId} (host session ${sessionId}). Each entry carries page-world fields (ts, frameUrl, frameKey, sessionId, rrwebType, data, timestamp) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor).`,
    ];
    if (result.hasMore) {
        nextSteps.push(`hasMore=true: more matching events exist beyond limit. Page forward by passing the response top-level cursor as filter.since on your next call.`);
    }
    else if (result.cursor === null) {
        nextSteps.push('No replay events match the current filter; cursor is null. Confirm session_record(action="start") is active and the page has produced rrweb events.');
    }
    else {
        nextSteps.push('Latest tail returned (hasMore=false). To poll for new events, retry with filter.since=cursor (top-level field of this response).');
    }
    nextSteps.push(FILTER_SPEC_HINT);
    return okResponse({ entries, cursor: result.cursor, hasMore: result.hasMore }, nextSteps);
};
const sessionReplayTool = Object.freeze({
    name: 'session_replay',
    description: "Tail the host-side replay ring buffer (populated while session_record is active) for a target extension. Returns { entries: ReplayEntry[]; cursor; hasMore }. Each ReplayEntry carries page-world fields (ts, frameUrl, frameKey, sessionId, rrwebType, data, timestamp) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). FilterSpec: pattern (regex over JSON.stringify), since/until cursors, limit. level is ignored. Call session_record(action='start') first to start producing events.",
    inputSchema: inputSchema$k,
    handler: sessionReplayHandler,
});

const SW_STATUS_IPC_TIMEOUT_MS = 5000;
const inputSchema$j = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
};
const isWorkerRecord = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const r = v;
    return typeof r['scriptURL'] === 'string' && typeof r['state'] === 'string';
};
const readSnapshot = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r['supported'] !== 'boolean')
        return null;
    if (typeof r['hasWaitingUpdate'] !== 'boolean')
        return null;
    if (!Array.isArray(r['registrations']))
        return null;
    const controller = r['controller'];
    if (controller !== null && !isWorkerRecord(controller))
        return null;
    return raw;
};
const swStatusHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension so Chrome respawns the NMH.',
        ]);
    }
    const wirePayload = {};
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    const env = Object.freeze({
        type: 'request',
        requestId: randomUUID(),
        tool: 'sw_status',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: SW_STATUS_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`sw_status failed: ${err.message}`, [
            'IPC request did not complete (timeout, send error, or NMH disconnect). Check the extension service worker console and confirm the SW is connected to the host.',
        ]);
    }
    if (response.error) {
        return errorResponse(`sw_status nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Common causes: no active tab (open an http(s) tab to the PWA), explicit tab_id not found, or the page-world bridge is not attached (chrome:// / web-store pages cannot be read).',
        ]);
    }
    const snapshot = readSnapshot(response.payload);
    if (snapshot === null) {
        return errorResponse('sw_status returned a malformed payload (missing supported/registrations/hasWaitingUpdate).', [
            'The page-world handler returned a shape that does not match SwStatusSnapshot. Check packages/extension/src/sw_app/projection.ts and the page_dispatch sw_status handler.',
        ]);
    }
    const data = {
        extensionId: target.extensionId,
        tabId: args.tab_id ?? null,
        ...snapshot,
    };
    const nextSteps = [
        'SwStatusSnapshot: { supported, controller, registrations[], hasWaitingUpdate }. Each registration has { scope, updateViaCache, installing, waiting, active, activeScriptURL, hasWaitingUpdate }. controller is the worker currently driving the page.',
    ];
    if (!snapshot.supported) {
        nextSteps.push('supported:false — navigator.serviceWorker is absent here (insecure context / unsupported browser). The page cannot use service workers at this origin.');
    }
    else if (snapshot.registrations.length === 0) {
        nextSteps.push('No service worker is registered for this scope. If you expected one, the app may not have called navigator.serviceWorker.register() yet, or the SW failed to install (check console_tail / error_tail).');
    }
    if (snapshot.hasWaitingUpdate) {
        nextSteps.push('hasWaitingUpdate:true — a new worker is installed and WAITING (the page keeps running the active worker until all clients close or the SW calls skipWaiting). This is the classic "my update is not showing" state. Inspect registrations[].waiting; the fix is skipWaiting() + clients.claim() or closing every tab/window of the app.');
    }
    if (snapshot.supported && snapshot.controller === null) {
        nextSteps.push('controller:null — no worker is controlling the page. Normal on the very first load before activation, or after a shift-reload (which bypasses the SW). A hard navigation should let the active worker take control.');
    }
    return okResponse(data, nextSteps);
};
const swStatusTool = Object.freeze({
    name: 'sw_status',
    description: "Inspect the DEBUGGED PWA's service worker(s). Returns SwStatusSnapshot { supported, controller, registrations[], hasWaitingUpdate } read from the page's navigator.serviceWorker — the installing/waiting/active worker for each registration (with script URLs + lifecycle state), which worker controls the page, and whether an update is stuck WAITING (the #1 'why isn't my update showing' signal). Reads the app's real SW state in your actual browser profile — something CDP / chrome-devtools-mcp does not surface. Args: { extension_id?, tab_id? }. Runs in page-world via the page-bridge (no CDP). For the lifecycle event stream (updatefound/statechange/controllerchange) use sw_lifecycle_tail. CALL host_status FIRST to see connected extensions.",
    inputSchema: inputSchema$j,
    handler: swStatusHandler,
});

const inputSchema$i = {
    extension_id: stringType().min(1).optional(),
    filter: filterSchema,
};
const swLifecycleTailHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension at chrome://extensions.',
            FILTER_SPEC_HINT,
        ]);
    }
    const captures = ctx.capturesRegistry.get(target.extensionId);
    if (captures === undefined) {
        return okResponse({ entries: [], cursor: null, hasMore: false }, [
            `Extension ${target.extensionId} is connected but no captured events have arrived yet. The CapturesIn instance is created lazily on first event — service-worker lifecycle events only fire on transitions (an update installing, a state change, a controller change), so a stable app may emit none. Use sw_status for a point-in-time snapshot instead.`,
            FILTER_SPEC_HINT,
        ]);
    }
    const sessionId = captures.getStats().sessionId;
    const buffer = captures.buffer('sw_state');
    const filterSpec = toFilterSpec(args.filter);
    const result = await tailWithFilterMerged({
        buffer,
        spec: filterSpec,
        ctx: { currentSessionId: sessionId },
        kind: 'sw_state',
    });
    if (!result.ok) {
        return tailErrorToResponse(result.error);
    }
    const entries = result.entries.map((e) => ({
        ...e,
        cursor: encodeCursor({
            sessionId: e.sessionId,
            sequenceNumber: e.sequenceNumber,
        }),
    }));
    const nextSteps = [
        `Returned ${entries.length} SwStateEntry record(s) for extension ${target.extensionId} (host session ${sessionId}). Each entry has { subkind, scope?, scriptURL?, state?, slot? } plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). subkind: 'updatefound' (a new worker began installing), 'statechange' (a worker advanced installing→installed→activating→activated→redundant), 'controllerchange' (a new worker took control of the page). For the current snapshot (waiting/active/controller) call sw_status.`,
    ];
    if (result.hasMore) {
        nextSteps.push('hasMore=true: more matching events exist beyond limit. Page forward by passing the response top-level cursor as filter.since on your next call.');
    }
    else if (result.cursor === null) {
        nextSteps.push("No sw_state events captured yet. They only fire on lifecycle transitions — trigger one (deploy a new SW, or reload to install an update), or the app may have a stable, already-activated worker. sw_status shows the steady-state snapshot.");
    }
    else {
        nextSteps.push('Latest tail returned (hasMore=false). To watch for new transitions as they happen, retry with filter.since=cursor (top-level field of this response).');
    }
    nextSteps.push(FILTER_SPEC_HINT);
    return okResponse({ entries, cursor: result.cursor, hasMore: result.hasMore }, nextSteps);
};
const swLifecycleTailTool = Object.freeze({
    name: 'sw_lifecycle_tail',
    description: "Tail the DEBUGGED PWA's service-worker lifecycle event stream (kind 'sw_state') with cursor pagination + FilterSpec. Returns { entries: SwStateEntry[]; cursor: Cursor|null; hasMore: bool }. Each SwStateEntry: { subkind, scope?, scriptURL?, state?, slot? } + host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). subkind: 'updatefound' = a new worker started installing; 'statechange' = a worker advanced lifecycle state (installing→installed→activating→activated→redundant); 'controllerchange' = the page's controlling worker changed. This is the EVENT STREAM (transitions over time) — for the point-in-time snapshot (waiting/active/controller, hasWaitingUpdate) use sw_status. Captured in page-world against your real profile; CDP/chrome-devtools-mcp does not surface this. Events only fire on transitions, so a stable app may return none. With no extension_id, targets the single connected NMH. CALL host_status FIRST.",
    inputSchema: inputSchema$i,
    handler: swLifecycleTailHandler,
});

const CACHE_LIST_IPC_TIMEOUT_MS = 5000;
const inputSchema$h = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
};
const readResult$8 = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r['supported'] !== 'boolean')
        return null;
    if (!Array.isArray(r['caches']))
        return null;
    return raw;
};
const cacheListHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = {};
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    const env = Object.freeze({
        type: 'request',
        requestId: randomUUID(),
        tool: 'cache_list',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: CACHE_LIST_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`cache_list failed: ${err.message}`, [
            'IPC request did not complete. Check the extension service worker console and confirm the SW is connected.',
        ]);
    }
    if (response.error) {
        return errorResponse(`cache_list nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Open an http(s) tab to the PWA (chrome:// / web-store pages cannot be read).',
        ]);
    }
    const result = readResult$8(response.payload);
    if (result === null) {
        return errorResponse('cache_list returned a malformed payload.', [
            'The page-world handler returned a shape that does not match CacheListResult. Check packages/extension/src/cache_storage/read.ts.',
        ]);
    }
    const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
    const nextSteps = [
        'CacheListResult: { supported, caches: [{ name, entryCount }] }. Pass a cache name to cache_inspect to see its entries (url, age, content-type, size), or cache_match(url) to find which cache serves a given URL.',
    ];
    if (!result.supported) {
        nextSteps.push('supported:false — caches.* is unavailable here (insecure context / unsupported browser).');
    }
    else if (result.caches.length === 0) {
        nextSteps.push('No caches exist. The app has not populated CacheStorage (no service worker precache / runtime caching yet).');
    }
    return okResponse(data, nextSteps);
};
const cacheListTool = Object.freeze({
    name: 'cache_list',
    description: "List the debugged PWA's CacheStorage caches. Returns CacheListResult { supported, caches: [{ name, entryCount }] } read from the page's caches.* API. Use to see what the service worker has cached, then cache_inspect(cache_name) for per-entry detail (age/size/type) or cache_match(url) to find which cache serves a URL — the core of diagnosing stale-cache bugs. Reads your real profile's caches; CDP/chrome-devtools-mcp does not surface this. Args: { extension_id?, tab_id? }. Runs in page-world via the page-bridge. CALL host_status FIRST.",
    inputSchema: inputSchema$h,
    handler: cacheListHandler,
});

const CACHE_INSPECT_IPC_TIMEOUT_MS = 8000;
const inputSchema$g = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    cache_name: stringType().min(1),
    limit: numberType().int().positive().max(1000).optional(),
};
const readResult$7 = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r['supported'] !== 'boolean')
        return null;
    if (typeof r['found'] !== 'boolean')
        return null;
    if (!Array.isArray(r['entries']))
        return null;
    if (typeof r['entryCount'] !== 'number')
        return null;
    if (typeof r['truncated'] !== 'boolean')
        return null;
    return raw;
};
const cacheInspectHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = { cache_name: args.cache_name };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.limit !== undefined)
        wirePayload['limit'] = args.limit;
    const env = Object.freeze({
        type: 'request',
        requestId: randomUUID(),
        tool: 'cache_inspect',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: CACHE_INSPECT_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`cache_inspect failed: ${err.message}`, [
            'IPC request did not complete. A very large cache can take a while to enumerate — retry with a smaller limit, or check the SW console.',
        ]);
    }
    if (response.error) {
        return errorResponse(`cache_inspect nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Open an http(s) tab to the PWA and confirm the cache name (from cache_list).',
        ]);
    }
    const result = readResult$7(response.payload);
    if (result === null) {
        return errorResponse('cache_inspect returned a malformed payload.', [
            'The page-world handler returned a shape that does not match CacheInspectResult. Check packages/extension/src/cache_storage/read.ts.',
        ]);
    }
    const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
    const nextSteps = [
        'CacheInspectResult.entries[]: { url, method, status, contentType, contentLength, dateHeader, ageSeconds, cacheControl }. ageSeconds = how long ago the response was generated (from its Date header) — high values on app shell / API responses are the stale-cache smell.',
    ];
    if (!result.supported) {
        nextSteps.push('supported:false — caches.* is unavailable here.');
    }
    else if (!result.found) {
        nextSteps.push(`No cache named "${args.cache_name}". Call cache_list to see the exact names.`);
    }
    else if (result.truncated) {
        nextSteps.push(`Showing ${result.entries.length} of ${result.entryCount} entries (capped by limit). Re-call with a higher limit to see more.`);
    }
    return okResponse(data, nextSteps);
};
const cacheInspectTool = Object.freeze({
    name: 'cache_inspect',
    description: "Inspect one CacheStorage cache's entries. Returns CacheInspectResult { supported, found, name, entries: [{ url, method, status, contentType, contentLength, dateHeader, ageSeconds, cacheControl }], entryCount, truncated }. ageSeconds (now − the response's Date header) is the staleness signal — old app-shell HTML or API responses are the usual 'why won't my update show' / 'why is my data stale' cause. Get the cache name from cache_list first. Bodies are NOT read (size is from content-length). Args: { extension_id?, tab_id?, cache_name (required), limit?: default 200, max 1000 }. Page-world read; CDP cannot do this. CALL host_status FIRST.",
    inputSchema: inputSchema$g,
    handler: cacheInspectHandler,
});

const CACHE_MATCH_IPC_TIMEOUT_MS = 5000;
const inputSchema$f = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    url: stringType().min(1),
};
const readResult$6 = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r['supported'] !== 'boolean')
        return null;
    if (typeof r['matched'] !== 'boolean')
        return null;
    if (typeof r['url'] !== 'string')
        return null;
    return raw;
};
const cacheMatchHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = { url: args.url };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    const env = Object.freeze({
        type: 'request',
        requestId: randomUUID(),
        tool: 'cache_match',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: CACHE_MATCH_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`cache_match failed: ${err.message}`, [
            'IPC request did not complete. Check the extension service worker console and confirm the SW is connected.',
        ]);
    }
    if (response.error) {
        return errorResponse(`cache_match nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Open an http(s) tab to the PWA.',
        ]);
    }
    const result = readResult$6(response.payload);
    if (result === null) {
        return errorResponse('cache_match returned a malformed payload.', [
            'The page-world handler returned a shape that does not match CacheMatchResult. Check packages/extension/src/cache_storage/read.ts.',
        ]);
    }
    const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
    const nextSteps = [
        'CacheMatchResult: { supported, url, matched, cacheName, entry }. When matched, cacheName is the cache that would serve this URL and entry.ageSeconds is how stale that cached response is. Note: this is what CacheStorage would return — the actual fetch strategy (cache-first vs network-first vs stale-while-revalidate) lives in the service worker\'s fetch handler and is not directly observable; treat a hit as "a cached copy exists", not "this is definitely served".',
    ];
    if (!result.supported) {
        nextSteps.push('supported:false — caches.* is unavailable here.');
    }
    else if (!result.matched) {
        nextSteps.push('No cache serves this URL — it would go to the network (or fail offline). Check the exact URL (query string + trailing slash matter for cache keys).');
    }
    return okResponse(data, nextSteps);
};
const cacheMatchTool = Object.freeze({
    name: 'cache_match',
    description: "Find which CacheStorage cache would serve a URL. Returns CacheMatchResult { supported, url, matched, cacheName, entry } — iterates the caches in order and reports the first hit plus the matched entry (status, content-type, ageSeconds, cache-control). Answers 'is /app.js cached, by which cache, and how old is it'. CAVEAT: a hit means a cached copy EXISTS; the SW's fetch handler decides whether it's actually served (cache-first / network-first / SWR) and that strategy is not observable from here — reported as a heuristic, not a guarantee. Args: { extension_id?, tab_id?, url (required) }. Page-world read. CALL host_status FIRST.",
    inputSchema: inputSchema$f,
    handler: cacheMatchHandler,
});

const PWA_STATUS_IPC_TIMEOUT_MS = 5000;
const inputSchema$e = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
};
const readResult$5 = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r['displayMode'] !== 'string')
        return null;
    if (typeof r['standalone'] !== 'boolean')
        return null;
    if (typeof r['controlledBySW'] !== 'boolean')
        return null;
    if (r['permissions'] === null || typeof r['permissions'] !== 'object')
        return null;
    if (r['capabilities'] === null || typeof r['capabilities'] !== 'object')
        return null;
    return raw;
};
const pwaStatusHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = {};
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    const env = Object.freeze({
        type: 'request',
        requestId: randomUUID(),
        tool: 'pwa_status',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: PWA_STATUS_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`pwa_status failed: ${err.message}`, [
            'IPC request did not complete. Check the extension service worker console and confirm the SW is connected.',
        ]);
    }
    if (response.error) {
        return errorResponse(`pwa_status nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Open an http(s) tab to the PWA (chrome:// / web-store pages cannot be read).',
        ]);
    }
    const result = readResult$5(response.payload);
    if (result === null) {
        return errorResponse('pwa_status returned a malformed payload.', [
            'The page-world handler returned a shape that does not match PwaStatusSnapshot. Check packages/extension/src/pwa_status/read.ts.',
        ]);
    }
    const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
    const nextSteps = [
        'PwaStatusSnapshot: { displayMode, standalone, controlledBySW, controllerScriptURL, permissions: { notifications, push, periodicBackgroundSync }, capabilities: { serviceWorker, pushManager, backgroundSync, periodicBackgroundSync, badging, fileSystemAccess, windowControlsOverlay, webShare, notifications } }. capabilities are live feature-detection (is the API present in THIS browser); permissions are the Permissions-API state.',
    ];
    if (!result.standalone) {
        nextSteps.push('standalone:false — running as a normal browser tab, not an installed app. For why it may not be installable, use pwa_installability (when available) or check the manifest + service worker.');
    }
    if (!result.controlledBySW) {
        nextSteps.push('controlledBySW:false — no service worker controls the page (first load before activation, hard-reload, or none registered). See sw_status for registration detail.');
    }
    return okResponse(data, nextSteps);
};
const pwaStatusTool = Object.freeze({
    name: 'pwa_status',
    description: "Snapshot the debugged PWA's runtime status + capability matrix. Returns PwaStatusSnapshot { displayMode, standalone (installed?), controlledBySW + controllerScriptURL, permissions: { notifications, push, periodicBackgroundSync }, capabilities: { serviceWorker, pushManager, backgroundSync, periodicBackgroundSync, badging, fileSystemAccess, windowControlsOverlay, webShare, notifications } }. capabilities = live feature-detection in THIS browser (answers 'why does push work on Android but not here'); permissions = current Permissions-API grants. One cheap call assembles what DevTools makes you gather piecemeal. Reads your real profile. Args: { extension_id?, tab_id? }. Page-world read. CALL host_status FIRST.",
    inputSchema: inputSchema$e,
    handler: pwaStatusHandler,
});

const PWA_INSTALLABILITY_IPC_TIMEOUT_MS = 8000;
const inputSchema$d = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
};
const readResult$4 = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r['supported'] !== 'boolean')
        return null;
    if (typeof r['installable'] !== 'boolean')
        return null;
    if (typeof r['manifestFound'] !== 'boolean')
        return null;
    if (!Array.isArray(r['gaps']))
        return null;
    return raw;
};
const pwaInstallabilityHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = {};
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    const env = Object.freeze({
        type: 'request',
        requestId: randomUUID(),
        tool: 'pwa_installability',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: PWA_INSTALLABILITY_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`pwa_installability failed: ${err.message}`, [
            'IPC request did not complete (the manifest fetch may have hung). Check the SW console and confirm the SW is connected.',
        ]);
    }
    if (response.error) {
        return errorResponse(`pwa_installability nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Open an http(s) tab to the PWA.',
        ]);
    }
    const result = readResult$4(response.payload);
    if (result === null) {
        return errorResponse('pwa_installability returned a malformed payload.', [
            'The page-world handler returned a shape that does not match InstallabilityResult. Check packages/extension/src/pwa_installability/.',
        ]);
    }
    const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
    const errors = result.gaps.filter((g) => g.severity === 'error');
    const warnings = result.gaps.filter((g) => g.severity === 'warning');
    const nextSteps = [
        `installable=${result.installable}. InstallabilityResult: { installable, manifestUrl, manifestFound, secureContext, hasServiceWorker, manifest, gaps: [{ code, severity, message, fix }] }. severity 'error' blocks install; 'warning' is recommended.`,
    ];
    if (errors.length > 0) {
        nextSteps.push(`BLOCKERS (${errors.length}): ${errors.map((g) => `[${g.code}] ${g.message} FIX: ${g.fix}`).join(' | ')}`);
    }
    if (warnings.length > 0) {
        nextSteps.push(`Recommended (${warnings.length}): ${warnings.map((g) => `[${g.code}] ${g.fix}`).join(' | ')}`);
    }
    if (result.installable && result.gaps.length === 0) {
        nextSteps.push('No gaps — the PWA meets the core installability criteria checked here.');
    }
    return okResponse(data, nextSteps);
};
const pwaInstallabilityTool = Object.freeze({
    name: 'pwa_installability',
    description: "Diagnose whether the debugged PWA is installable, with actionable gaps instead of 'manifest invalid'. Fetches + parses the web app manifest and checks: manifest present/valid, name/short_name, start_url, app display mode, icons (192 AND 512 AND a maskable purpose), secure context (HTTPS/localhost), and a registered service worker. Returns InstallabilityResult { installable, manifestUrl, manifestFound, secureContext, hasServiceWorker, manifest, gaps: [{ code, severity('error' blocks / 'warning' recommended), message, fix }] }. Each gap names exactly what's wrong and how to fix it. Reads your real page. Args: { extension_id?, tab_id? }. Page-world read. CALL host_status FIRST.",
    inputSchema: inputSchema$d,
    handler: pwaInstallabilityHandler,
});

/**
 * Pure classification of a cached/requested asset into a coarse AssetKind, by
 * content-type first (authoritative) then URL extension (fallback when the
 * cached response had no content-type). No I/O — used by the update-skew
 * analyzer to separate HTML from JS when reasoning about version skew.
 */
const stripUrl = (url) => {
    // Drop query + fragment so `app.abc123.js?v=2` classifies by its .js path.
    const q = url.indexOf('?');
    const h = url.indexOf('#');
    const cut = [q, h].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    return cut === undefined ? url : url.slice(0, cut);
};
const extensionKind = (url) => {
    const path = stripUrl(url).toLowerCase();
    if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs'))
        return 'js';
    if (path.endsWith('.css'))
        return 'css';
    if (path.endsWith('.html') || path.endsWith('.htm'))
        return 'html';
    // A bare navigation URL (no file extension, e.g. "/", "/app") is HTML.
    const lastSegment = path.split('/').pop() ?? '';
    if (!lastSegment.includes('.'))
        return 'html';
    return 'other';
};
const contentTypeKind = (contentType) => {
    const ct = contentType.toLowerCase();
    if (ct.includes('html'))
        return 'html';
    if (ct.includes('javascript') || ct.includes('ecmascript'))
        return 'js';
    if (ct.includes('css'))
        return 'css';
    return null;
};
/**
 * Classify an asset. content-type wins when it maps to a known kind; otherwise
 * fall back to the URL extension (a bare navigation path counts as HTML).
 */
const classifyAsset = (url, contentType) => {
    if (contentType !== null) {
        const byType = contentTypeKind(contentType);
        if (byType !== null)
            return byType;
    }
    return extensionKind(url);
};

/**
 * Pure update-propagation / version-skew analyzer. Correlates three
 * already-exposed primitives — a service-worker snapshot, cached asset ages,
 * and recent network failures — into a structured UpdateAnalysisResult. No I/O:
 * the host tool gathers the inputs and hands them in, keeping this unit-testable
 * with plain objects.
 *
 * Detections:
 *  - waiting_update_active_client: a worker is installed and WAITING while this
 *    client is still controlled by the old active worker (the classic "update
 *    won't show until all tabs close / skipWaiting").
 *  - html_older_js: cached navigation HTML is materially OLDER than cached JS,
 *    so the stale HTML references chunk hashes the newer JS no longer ships —
 *    the setup for chunk 404s.
 *  - chunk_404: recent JS/CSS chunk requests that failed (status ≥ 400),
 *    corroborating the skew with observed misses.
 */
/** Cached HTML older than cached JS by this many seconds ⇒ flag version skew. */
const SKEW_THRESHOLD_SECONDS = 3600;
/** Keep result arrays bounded so a large cache cannot blow the payload. */
const MAX_LISTED = 50;
const toAssetAge = (entry) => ({
    url: entry.url,
    kind: classifyAsset(entry.url, entry.contentType),
    ageSeconds: entry.ageSeconds,
    cacheName: entry.cacheName,
});
const hasAge = (a) => a.ageSeconds !== null;
/** Analyze the gathered SW + cache + network inputs into a structured diagnosis. */
const analyzeUpdateSkew = (sw, cacheEntries, failures, options = {}) => {
    const threshold = options.skewThresholdSeconds ?? SKEW_THRESHOLD_SECONDS;
    const assets = cacheEntries.map(toAssetAge);
    // HTML oldest first; JS newest first (smallest age first).
    const cachedHtml = assets
        .filter((a) => a.kind === 'html')
        .sort((a, b) => (b.ageSeconds ?? -1) - (a.ageSeconds ?? -1))
        .slice(0, MAX_LISTED);
    const cachedJs = assets
        .filter((a) => a.kind === 'js')
        .sort((a, b) => (a.ageSeconds ?? Infinity) - (b.ageSeconds ?? Infinity))
        .slice(0, MAX_LISTED);
    const chunk404s = failures
        .filter((f) => {
        const kind = classifyAsset(f.url, null);
        return (kind === 'js' || kind === 'css') && f.status >= 400;
    })
        .slice(0, MAX_LISTED);
    const findings = [];
    if (sw.hasWaitingUpdate && sw.controller !== null) {
        findings.push({
            code: 'waiting_update_active_client',
            severity: 'warning',
            message: 'An updated service worker is installed and WAITING, but this page is still controlled by the old active worker. The update will not take effect until every client (tab) for this scope is closed, or the worker calls skipWaiting() + clients.claim().',
        });
    }
    const htmlAges = cachedHtml.filter(hasAge);
    const jsAges = cachedJs.filter(hasAge);
    if (htmlAges.length > 0 && jsAges.length > 0) {
        const oldestHtml = Math.max(...htmlAges.map((a) => a.ageSeconds));
        const newestJs = Math.min(...jsAges.map((a) => a.ageSeconds));
        if (oldestHtml - newestJs >= threshold) {
            findings.push({
                code: 'html_older_js',
                severity: 'warning',
                message: `Cached HTML is ~${Math.round((oldestHtml - newestJs) / 60)} min older than cached JS (oldest HTML ${oldestHtml}s vs newest JS ${newestJs}s). Stale cached HTML can reference chunk hashes the newer JS no longer ships — the cause of chunk 404s after a deploy. Consider a network-first / shorter cache for navigation HTML.`,
            });
        }
    }
    if (chunk404s.length > 0) {
        findings.push({
            code: 'chunk_404',
            severity: 'error',
            message: `${chunk404s.length} recent JS/CSS chunk request(s) failed (status ≥ 400) — e.g. ${chunk404s[0].url} → ${chunk404s[0].status}. This is the live symptom of version skew: clients running stale HTML are requesting chunks that no longer exist.`,
        });
    }
    const summary = !sw.supported
        ? 'Service workers are unavailable in this context — no update-propagation analysis possible.'
        : findings.length === 0
            ? 'No update-propagation or version-skew issues detected.'
            : findings.map((f) => f.code).join(', ');
    return {
        supported: sw.supported,
        hasWaitingUpdate: sw.hasWaitingUpdate,
        controller: sw.controller,
        findings,
        cachedHtml,
        cachedJs,
        chunk404s,
        summary,
    };
};

const UPDATE_ANALYZE_IPC_TIMEOUT_MS = 8000;
const inputSchema$c = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    per_cache_limit: numberType().int().positive().max(1000).optional(),
    skew_threshold_seconds: numberType().int().nonnegative().optional(),
};
const readGather = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    const sw = r['sw'];
    if (sw === null || typeof sw !== 'object')
        return null;
    if (typeof sw['supported'] !== 'boolean')
        return null;
    if (!Array.isArray(r['cacheEntries']))
        return null;
    return raw;
};
/**
 * Extract recent network failures (status ≥ 400) from the host's `network` ring
 * buffer, deduped by URL (latest status wins). The analyzer narrows these to
 * JS/CSS chunk misses.
 */
const networkFailures = (events) => {
    const byUrl = new Map();
    for (const e of events) {
        if (e.kind !== 'fetch' && e.kind !== 'xhr')
            continue;
        const url = e['url'];
        const status = e['status'];
        if (typeof url !== 'string' || typeof status !== 'number' || status < 400)
            continue;
        byUrl.set(url, status);
    }
    return [...byUrl.entries()].map(([url, status]) => ({ url, status }));
};
const pwaUpdateAnalyzeHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = {};
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.per_cache_limit !== undefined)
        wirePayload['per_cache_limit'] = args.per_cache_limit;
    const env = Object.freeze({
        type: 'request',
        requestId: randomUUID(),
        tool: 'pwa_update_gather',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: UPDATE_ANALYZE_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`pwa_update_analyze failed: ${err.message}`, [
            'IPC request did not complete. Gathering many caches can take a moment — check the extension service worker console and confirm the SW is connected.',
        ]);
    }
    if (response.error) {
        return errorResponse(`pwa_update_analyze nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Open an http(s) tab to the PWA (chrome:// / web-store pages cannot be read).',
        ]);
    }
    const gathered = readGather(response.payload);
    if (gathered === null) {
        return errorResponse('pwa_update_analyze returned a malformed gather payload.', [
            'The page-world gather returned a shape that does not match UpdateGatherResult. Check packages/extension/src/update_analysis/gather.ts.',
        ]);
    }
    // Pull recent network failures from this extension's network ring buffer.
    // Absent (no captures-flavor events yet) → analyze with SW + cache only.
    const captures = ctx.capturesRegistry.get(target.extensionId);
    const failures = captures === undefined ? [] : networkFailures(captures.tail('network'));
    const result = analyzeUpdateSkew(gathered.sw, gathered.cacheEntries, failures, {
        ...(args.skew_threshold_seconds !== undefined
            ? { skewThresholdSeconds: args.skew_threshold_seconds }
            : {}),
    });
    const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
    const nextSteps = [
        'UpdateAnalysisResult: { supported, hasWaitingUpdate, controller, findings: [{ code, severity, message }], cachedHtml, cachedJs, chunk404s, summary }. Codes: waiting_update_active_client, html_older_js, chunk_404.',
    ];
    if (!result.supported) {
        nextSteps.push('supported:false — service workers are unavailable in this context.');
    }
    else if (result.findings.length === 0) {
        nextSteps.push('No issues detected. If users still report stale code, confirm the page was loaded fresh (the network buffer only holds requests seen since the extension attached) and re-run after reproducing.');
    }
    else {
        if (result.findings.some((f) => f.code === 'waiting_update_active_client')) {
            nextSteps.push('A waiting SW is blocked behind open clients — close all tabs for the scope or add skipWaiting()+clients.claim() to activate. sw_status shows the worker states.');
        }
        if (result.findings.some((f) => f.code === 'html_older_js')) {
            nextSteps.push('Version skew: use cache_inspect on the navigation/HTML cache to confirm ageSeconds, and prefer a network-first strategy for HTML so it cannot outlive the JS it references.');
        }
        if (result.findings.some((f) => f.code === 'chunk_404')) {
            nextSteps.push('Live chunk 404s observed — network_tail (filter status>=400) lists them in full.');
        }
    }
    return okResponse(data, nextSteps);
};
const pwaUpdateAnalyzeTool = Object.freeze({
    name: 'pwa_update_analyze',
    description: "Diagnose service-worker update propagation + version skew for the debugged PWA. Composes sw_status (waiting worker + controller), CacheStorage entry ages (cached HTML vs JS), and recent network 404s into UpdateAnalysisResult { supported, hasWaitingUpdate, controller, findings: [{ code, severity, message }], cachedHtml, cachedJs, chunk404s, summary }. Detects: waiting_update_active_client (an installed SW is waiting while this client stays on the old worker — 'my update won't show'), html_older_js (stale cached HTML referencing chunk hashes the newer JS dropped), and chunk_404 (live chunk misses corroborating the skew). Use for 'why are some users on old code' / 'why are chunks 404ing after deploy'. Analysis over existing reads; no new capture. Args: { extension_id?, tab_id?, per_cache_limit?: default 100, skew_threshold_seconds?: default 3600 }. CALL host_status FIRST.",
    inputSchema: inputSchema$c,
    handler: pwaUpdateAnalyzeHandler,
});

const SNAPSHOT_IPC_TIMEOUT_MS = 10000;
const inputSchema$b = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
};
const readResult$3 = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r['url'] !== 'string')
        return null;
    if (typeof r['capturedAt'] !== 'number')
        return null;
    const sw = r['sw'];
    if (sw === null || typeof sw !== 'object')
        return null;
    const webStorage = r['webStorage'];
    if (webStorage === null || typeof webStorage !== 'object')
        return null;
    if (r['idb'] === null || typeof r['idb'] !== 'object')
        return null;
    if (r['cacheNames'] === null || typeof r['cacheNames'] !== 'object')
        return null;
    // `store` is RuntimeStoreState (object or null) — both are valid.
    return raw;
};
const pwaSnapshotHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = {};
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    const env = Object.freeze({
        type: 'request',
        requestId: randomUUID(),
        tool: 'pwa_snapshot_gather',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: SNAPSHOT_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`pwa_snapshot failed: ${err.message}`, [
            'IPC request did not complete. Composing the snapshot opens every IndexedDB database — a very large one can take a while; check the extension service worker console and confirm the SW is connected.',
        ]);
    }
    if (response.error) {
        return errorResponse(`pwa_snapshot nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Open an http(s) tab to the PWA (chrome:// / web-store pages cannot be read).',
        ]);
    }
    const result = readResult$3(response.payload);
    if (result === null) {
        return errorResponse('pwa_snapshot returned a malformed payload.', [
            'The page-world gather returned a shape that does not match RuntimeSnapshot. Check packages/extension/src/runtime_snapshot/gather.ts.',
        ]);
    }
    const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
    const nextSteps = [
        'RuntimeSnapshot: { url, title, capturedAt, sw, store, webStorage: { local, session }, idb (db/store schema), cacheNames }. One capped moment-in-time blob for repro — hand it off as deterministic bug context. For deeper detail drill in: idb_query (records), cache_inspect (entries), store_get_state (a state path).',
    ];
    if (result.store === null) {
        nextSteps.push('store:null — no Redux/Pinia/Jotai/Zustand store was auto-detected. If the app has one, expose it via a window.__pwaDebug_* handoff.');
    }
    if (!result.sw.supported) {
        nextSteps.push('sw.supported:false — service workers are unavailable in this context.');
    }
    return okResponse(data, nextSteps);
};
const pwaSnapshotTool = Object.freeze({
    name: 'pwa_snapshot',
    description: "Capture ONE capped runtime-state blob of the debugged PWA for deterministic bug-repro context. Returns RuntimeSnapshot { url, title, capturedAt, sw (service-worker status), store (auto-detected Redux/Pinia/Jotai/Zustand state, value-capped, or null), webStorage: { local, session }, idb (IndexedDB db/store schema — not records), cacheNames (CacheStorage names + counts) }. Composes the existing sw_status / store_get_state / storage_get / idb_list / cache_list reads into one moment-in-time record you can reason over or hand off to reproduce a bug. Read-only; no new capture surface. For deeper detail use idb_query / cache_inspect / store_get_state. Args: { extension_id?, tab_id? }. Page-world read. CALL host_status FIRST.",
    inputSchema: inputSchema$b,
    handler: pwaSnapshotHandler,
});

const STORAGE_GET_IPC_TIMEOUT_MS = 5000;
const inputSchema$a = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    area: enumType(['local', 'session']).optional(),
    limit: numberType().int().positive().max(2000).optional(),
};
const readResult$2 = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r['supported'] !== 'boolean')
        return null;
    if (r['area'] !== 'local' && r['area'] !== 'session')
        return null;
    if (!Array.isArray(r['entries']))
        return null;
    if (typeof r['entryCount'] !== 'number')
        return null;
    if (typeof r['truncated'] !== 'boolean')
        return null;
    return raw;
};
const storageGetHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = {};
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.area !== undefined)
        wirePayload['area'] = args.area;
    if (args.limit !== undefined)
        wirePayload['limit'] = args.limit;
    const env = Object.freeze({
        type: 'request',
        requestId: randomUUID(),
        tool: 'storage_get',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: STORAGE_GET_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`storage_get failed: ${err.message}`, [
            'IPC request did not complete. Check the extension service worker console and confirm the SW is connected.',
        ]);
    }
    if (response.error) {
        return errorResponse(`storage_get nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Open an http(s) tab to the PWA (chrome:// / web-store pages cannot be read).',
        ]);
    }
    const result = readResult$2(response.payload);
    if (result === null) {
        return errorResponse('storage_get returned a malformed payload.', [
            'The page-world handler returned a shape that does not match StorageGetResult. Check packages/extension/src/storage/web_storage.ts.',
        ]);
    }
    const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
    const nextSteps = [
        'StorageGetResult: { supported, area, entries: [{ key, value, truncated? }], entryCount, truncated }. Long values are capped (truncated:true). For IndexedDB use idb_list / idb_query instead — web storage holds only string key/value pairs.',
    ];
    if (!result.supported) {
        nextSteps.push(`supported:false — ${result.area}Storage is unavailable here (disabled / blocked context).`);
    }
    else if (result.entries.length === 0) {
        nextSteps.push(`No keys in ${result.area}Storage. Try area:'${result.area === 'local' ? 'session' : 'local'}', or the app stores its state in IndexedDB (idb_list).`);
    }
    else if (result.truncated) {
        nextSteps.push(`Showing ${result.entries.length} of ${result.entryCount} keys (capped by limit). Re-call with a higher limit to see more.`);
    }
    return okResponse(data, nextSteps);
};
const storageGetTool = Object.freeze({
    name: 'storage_get',
    description: "Snapshot the debugged PWA's web storage. Returns StorageGetResult { supported, area, entries: [{ key, value, truncated? }], entryCount, truncated } read from the page's localStorage or sessionStorage. Use to inspect auth tokens, feature flags, cached app state, and 'why is the app in this state' bugs that live in storage. Reads your REAL profile's storage; CDP/chrome-devtools-mcp does not surface this. Values over 8KB are truncated. For structured/large data the app keeps in IndexedDB, use idb_list + idb_query instead. Args: { extension_id?, tab_id?, area?: 'local' (default) | 'session', limit?: default 500, max 2000 }. Page-world read. CALL host_status FIRST.",
    inputSchema: inputSchema$a,
    handler: storageGetHandler,
});

const IDB_LIST_IPC_TIMEOUT_MS = 8000;
const inputSchema$9 = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
};
const readResult$1 = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r['supported'] !== 'boolean')
        return null;
    if (!Array.isArray(r['databases']))
        return null;
    return raw;
};
const idbListHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = {};
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    const env = Object.freeze({
        type: 'request',
        requestId: randomUUID(),
        tool: 'idb_list',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: IDB_LIST_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`idb_list failed: ${err.message}`, [
            'IPC request did not complete. Opening many databases can take a moment — check the extension service worker console and confirm the SW is connected.',
        ]);
    }
    if (response.error) {
        return errorResponse(`idb_list nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Open an http(s) tab to the PWA (chrome:// / web-store pages cannot be read).',
        ]);
    }
    const result = readResult$1(response.payload);
    if (result === null) {
        return errorResponse('idb_list returned a malformed payload.', [
            'The page-world handler returned a shape that does not match IdbListResult. Check packages/extension/src/storage/idb_read.ts.',
        ]);
    }
    const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
    const nextSteps = [
        'IdbListResult: { supported, databases: [{ name, version, stores: [{ name, keyPath, autoIncrement, indexes }], error? }] }. Pass a db + store name to idb_query to read a slice of records.',
    ];
    if (!result.supported) {
        nextSteps.push('supported:false — indexedDB is unavailable here (insecure context / unsupported browser).');
    }
    else if (result.databases.length === 0) {
        nextSteps.push('No IndexedDB databases. The app stores nothing in IndexedDB (it may use web storage instead — try storage_get).');
    }
    return okResponse(data, nextSteps);
};
const idbListTool = Object.freeze({
    name: 'idb_list',
    description: "List the debugged PWA's IndexedDB databases and their schema. Returns IdbListResult { supported, databases: [{ name, version, stores: [{ name, keyPath, autoIncrement, indexes: [{ name, keyPath, unique, multiEntry }] }], error? }] } read from the page's indexedDB API. Use to discover where the app keeps structured/offline data, then idb_query(db, store) to read records — the recurring 'inspect IndexedDB live' need that CDP/chrome-devtools-mcp does not surface for your real profile. Read-only: opening a database never creates one. Args: { extension_id?, tab_id? }. Page-world read. CALL host_status FIRST.",
    inputSchema: inputSchema$9,
    handler: idbListHandler,
});

const IDB_QUERY_IPC_TIMEOUT_MS = 8000;
const inputSchema$8 = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    db: stringType().min(1),
    store: stringType().min(1),
    limit: numberType().int().positive().max(1000).optional(),
};
const readResult = (raw) => {
    if (raw === null || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r['supported'] !== 'boolean')
        return null;
    if (typeof r['found'] !== 'boolean')
        return null;
    if (!Array.isArray(r['records']))
        return null;
    if (typeof r['returned'] !== 'number')
        return null;
    if (typeof r['truncated'] !== 'boolean')
        return null;
    return raw;
};
const idbQueryHandler = async (args, ctx) => {
    const target = resolveTarget$1(ctx, args.extension_id);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
        ]);
    }
    const wirePayload = { db: args.db, store: args.store };
    if (args.tab_id !== undefined)
        wirePayload['tab_id'] = args.tab_id;
    if (args.limit !== undefined)
        wirePayload['limit'] = args.limit;
    const env = Object.freeze({
        type: 'request',
        requestId: randomUUID(),
        tool: 'idb_query',
        extensionId: target.extensionId,
        payload: wirePayload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: IDB_QUERY_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`idb_query failed: ${err.message}`, [
            'IPC request did not complete. A large store can take a while to read — retry with a smaller limit, or check the SW console.',
        ]);
    }
    if (response.error) {
        return errorResponse(`idb_query nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request. Open an http(s) tab to the PWA and confirm the db + store names (from idb_list).',
        ]);
    }
    const result = readResult(response.payload);
    if (result === null) {
        return errorResponse('idb_query returned a malformed payload.', [
            'The page-world handler returned a shape that does not match IdbQueryResult. Check packages/extension/src/storage/idb_read.ts.',
        ]);
    }
    const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
    const nextSteps = [
        'IdbQueryResult: { supported, found, db, store, records: [{ key, value, truncated? }], returned, truncated }. Records are read read-only; large values are capped (truncated:true).',
    ];
    if (!result.supported) {
        nextSteps.push('supported:false — indexedDB is unavailable here.');
    }
    else if (!result.found) {
        nextSteps.push(`No "${args.store}" store in db "${args.db}". Call idb_list to see the exact db + store names.`);
    }
    else if (result.error !== undefined) {
        nextSteps.push(`The store exists but the read failed: ${result.error}`);
    }
    else if (result.truncated) {
        nextSteps.push(`Showing ${result.returned} records (capped by limit). Re-call with a higher limit to see more.`);
    }
    return okResponse(data, nextSteps);
};
const idbQueryTool = Object.freeze({
    name: 'idb_query',
    description: "Read a capped slice of records from one IndexedDB object store. Returns IdbQueryResult { supported, found, db, store, records: [{ key, value, truncated? }], returned, truncated } read read-only from the page's indexedDB. Get the db + store names from idb_list first. Use to inspect the app's offline/cached structured data — the 'what's actually in IndexedDB' need CDP/chrome-devtools-mcp does not surface for your real profile. Read-only (no writes); values over 16KB are truncated. Args: { extension_id?, tab_id?, db (required), store (required), limit?: default 100, max 1000 }. Page-world read. CALL host_status FIRST.",
    inputSchema: inputSchema$8,
    handler: idbQueryHandler,
});

const toWire = (key) => {
    const e = getSettingEntry(key);
    return {
        key: e.key,
        type: e.type,
        default: e.default,
        scope: e.scope,
        description: e.description,
        ...(e.enumValues ? { enumValues: e.enumValues } : {}),
    };
};
const settingsListSchemaHandler = async () => {
    const schema = settingKeys().map(toWire);
    return okResponse({ schema }, [
        'Call settings_get({ key }) to read the current value of a single setting, or settings_get({}) to read every value.',
        'Call settings_set({ key, value }) to update a setting. The value MUST match the entry’s "type" tag: number, boolean, string[], or enum[] (subset of enumValues, no duplicates).',
        'Default values are shown under "default". Persistence: ~/.config/pwa-debug/settings.json — survives host restart.',
    ]);
};
const settingsListSchemaTool = Object.freeze({
    name: 'settings_list_schema',
    description: 'Returns every user-tunable host setting as data: key, runtime type tag (number | boolean | string[] | enum[]), default, consuming scope (host | extension | both), human description, and enumValues (for enum[] entries). Order is stable schema-declaration order. Use this BEFORE settings_set so the value shape matches the entry type — settings_set rejects invalid shapes with a schema-contextualized error.',
    inputSchema: {},
    handler: settingsListSchemaHandler,
});

const isKnownKey$1 = (k) => settingKeys().includes(k);
const wireEntry = (key) => {
    const e = getSettingEntry(key);
    return {
        key: e.key,
        type: e.type,
        default: e.default,
        scope: e.scope,
        description: e.description,
        ...(e.enumValues ? { enumValues: e.enumValues } : {}),
    };
};
const inputSchema$7 = {
    key: stringType().optional(),
};
const settingsGetHandler = async (args, ctx) => {
    if (args.key === undefined) {
        return okResponse({ values: ctx.settingsStore.getAll() }, [
            'Call settings_get({ key }) for a single setting, or settings_list_schema for the typed schema.',
            'Persistence: ~/.config/pwa-debug/settings.json — survives host restart.',
        ]);
    }
    if (!isKnownKey$1(args.key)) {
        return errorResponse(`unknown setting key: '${args.key}'`, [
            'Call settings_list_schema to see the valid key set + each entry’s expected type.',
        ]);
    }
    return okResponse({
        key: args.key,
        value: ctx.settingsStore.getSetting(args.key),
        entry: wireEntry(args.key),
    }, [
        'Call settings_set({ key, value }) to update. value must match entry.type (number | boolean | string[] | enum[] subset).',
    ]);
};
const settingsGetTool = Object.freeze({
    name: 'settings_get',
    description: 'Reads host settings. Omit key to receive every value. Provide key to receive { value, entry } where entry is the wire-safe schema metadata (type, default, scope, description, enumValues). Unknown keys return an error referencing settings_list_schema.',
    inputSchema: inputSchema$7,
    handler: settingsGetHandler,
});

const isKnownKey = (k) => settingKeys().includes(k);
const LIST_SCHEMA_HINT = 'Call settings_list_schema to see the expected type tag (number | boolean | string[] | enum[]) and enumValues for this key.';
// `value` is polymorphic across setting keys (boolean | number | string |
// string[] | record). z.unknown() rendered to an untyped `{}` JSON schema, which
// led MCP clients to ship the value with no type — a boolean `true` arrived as
// the string "true" and the per-key validator rejected it ("expected boolean").
// An explicit union gives the schema concrete branches so clients send the right
// JSON type; the precise per-key check still happens in settingsStore.setSetting.
const inputSchema$6 = {
    key: stringType(),
    value: unionType([
        booleanType(),
        numberType(),
        stringType(),
        arrayType(stringType()),
        recordType(unknownType()),
    ]),
};
const settingsSetHandler = async (args, ctx) => {
    if (!isKnownKey(args.key)) {
        return errorResponse(`unknown setting key: '${args.key}'`, [
            LIST_SCHEMA_HINT,
        ]);
    }
    // The store re-validates at runtime via validateSettingValue; the cast here
    // is the bridge from MCP-layer unknown to the per-key typed setSetting.
    const result = await ctx.settingsStore.setSetting(args.key, args.value);
    if (!result.ok) {
        return errorResponse(result.error, [LIST_SCHEMA_HINT]);
    }
    return okResponse({
        key: args.key,
        value: ctx.settingsStore.getSetting(args.key),
    }, [
        'Persisted to ~/.config/pwa-debug/settings.json — survives host restart.',
        'In-process subscribers (capture pipeline once T4 lands, ext_settings_cache once T3 lands) are notified immediately.',
    ]);
};
const settingsSetTool = Object.freeze({
    name: 'settings_set',
    description: 'Writes a single host setting. Validates the value against the per-key schema validator (rejects with a schema-contextualized error). On accept: atomic-persists to ~/.config/pwa-debug/settings.json and notifies in-process subscribers. Unknown keys and invalid values are rejected with a next_step pointing at settings_list_schema.',
    inputSchema: inputSchema$6,
    handler: settingsSetHandler,
});

const LINUX_BINARIES = Object.freeze([
    {
        name: 'chrome',
        pathNames: Object.freeze(['google-chrome', 'google-chrome-stable']),
        standardPaths: Object.freeze([
            '/opt/google/chrome/chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
        ]),
    },
    {
        name: 'chromium',
        pathNames: Object.freeze(['chromium', 'chromium-browser']),
        standardPaths: Object.freeze([
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
        ]),
    },
    {
        name: 'edge',
        pathNames: Object.freeze(['microsoft-edge', 'microsoft-edge-stable']),
        standardPaths: Object.freeze([
            '/opt/microsoft/msedge/msedge',
            '/usr/bin/microsoft-edge',
        ]),
    },
    {
        name: 'brave',
        pathNames: Object.freeze(['brave-browser', 'brave']),
        standardPaths: Object.freeze([
            '/opt/brave.com/brave/brave-browser',
            '/usr/bin/brave-browser',
        ]),
    },
    {
        name: 'vivaldi',
        pathNames: Object.freeze(['vivaldi', 'vivaldi-stable']),
        standardPaths: Object.freeze(['/opt/vivaldi/vivaldi', '/usr/bin/vivaldi']),
    },
    {
        name: 'opera',
        pathNames: Object.freeze(['opera']),
        standardPaths: Object.freeze(['/usr/bin/opera', '/opt/opera/opera']),
    },
]);
const MAC_BINARIES = Object.freeze([
    {
        name: 'chrome',
        execPath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
    {
        name: 'chromium',
        execPath: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    },
    {
        name: 'edge',
        execPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    },
    {
        name: 'brave',
        execPath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    },
    {
        name: 'vivaldi',
        execPath: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
    },
    { name: 'opera', execPath: '/Applications/Opera.app/Contents/MacOS/Opera' },
]);
const WIN_BINARIES = Object.freeze([
    {
        name: 'chrome',
        segments: Object.freeze(['Google', 'Chrome', 'Application', 'chrome.exe']),
    },
    {
        name: 'chromium',
        segments: Object.freeze(['Chromium', 'Application', 'chrome.exe']),
    },
    {
        name: 'edge',
        segments: Object.freeze(['Microsoft', 'Edge', 'Application', 'msedge.exe']),
    },
    {
        name: 'brave',
        segments: Object.freeze([
            'BraveSoftware',
            'Brave-Browser',
            'Application',
            'brave.exe',
        ]),
    },
    {
        name: 'vivaldi',
        segments: Object.freeze(['Vivaldi', 'Application', 'vivaldi.exe']),
    },
    {
        name: 'opera',
        segments: Object.freeze(['Opera', 'launcher.exe']),
    },
]);
const DESKTOP_TO_BROWSER = Object.freeze([
    { pattern: 'google-chrome', name: 'chrome' },
    { pattern: 'microsoft-edge', name: 'edge' },
    { pattern: 'brave', name: 'brave' },
    { pattern: 'vivaldi', name: 'vivaldi' },
    { pattern: 'opera', name: 'opera' },
    // chromium last: 'chromium' would otherwise shadow nothing here, but keeping
    // it after the branded browsers documents the precedence intent.
    { pattern: 'chromium', name: 'chromium' },
]);
/**
 * macOS: maps a LaunchServices handler bundle id (LSHandlerRoleAll for the
 * http/https URL scheme) to a BrowserName. Matched as a lowercased substring.
 * Non-Chromium defaults (org.mozilla.firefox, com.apple.safari) have no entry
 * and resolve to null.
 */
const MAC_BUNDLE_TO_BROWSER = Object.freeze([
    { pattern: 'com.google.chrome', name: 'chrome' },
    { pattern: 'org.chromium.chromium', name: 'chromium' },
    { pattern: 'com.microsoft.edgemac', name: 'edge' },
    { pattern: 'com.brave.browser', name: 'brave' },
    { pattern: 'com.operasoftware.opera', name: 'opera' },
    { pattern: 'com.vivaldi.vivaldi', name: 'vivaldi' },
]);
/**
 * Windows: maps an HKCU UserChoice ProgId (e.g. `ChromeHTML`, `MSEdgeHTM`,
 * `BraveHTML`, hashed variants like `BraveSSHTML.XXXX`) to a BrowserName,
 * matched as a lowercased substring. Order matters: `chromium` precedes
 * `chrome` so `ChromiumHTM` is not swallowed by the `chrome` test, and
 * `msedge` precedes `edge`. Non-Chromium ProgIds (FirefoxURL) resolve to null.
 */
const WIN_PROGID_TO_BROWSER = Object.freeze([
    { pattern: 'chromium', name: 'chromium' },
    { pattern: 'chrome', name: 'chrome' },
    { pattern: 'brave', name: 'brave' },
    { pattern: 'msedge', name: 'edge' },
    { pattern: 'edge', name: 'edge' },
    { pattern: 'vivaldi', name: 'vivaldi' },
    { pattern: 'opera', name: 'opera' },
]);

/**
 * Per-OS browser-executable detection + platform dispatcher.
 *
 * Mirrors native-messaging/browser_paths.detectBrowserInstalls: one function
 * per OS, all selected by a single `discoverBinaries(platform, …)` dispatcher,
 * every effect injected via DiscoveryDeps. Adding an OS = add a detect* fn +
 * one dispatcher branch; the data lives in binary_table.ts.
 */
/**
 * Linux packaging from the resolved exec path: a binary under /snap/ is snap-
 * confined (different profile root + sandbox); everything else is native.
 * Flatpak is detected separately (no host binary) and never reaches here.
 */
const linuxPackaging = (execPath) => execPath.includes('/snap/') ? 'snap' : 'native';
/**
 * Linux: prefer a PATH hit (honours the user's real install + snap shims),
 * fall back to known absolute package paths. First hit per browser wins.
 */
const detectLinuxBinaries = async (deps) => {
    const out = [];
    for (const entry of LINUX_BINARIES) {
        let resolved = null;
        for (const name of entry.pathNames) {
            const execPath = await deps.which(name);
            if (execPath) {
                resolved = Object.freeze({
                    browser: entry.name,
                    execPath,
                    source: 'path',
                    packaging: linuxPackaging(execPath),
                    isDefault: false,
                });
                break;
            }
        }
        if (!resolved) {
            for (const p of entry.standardPaths) {
                if (await deps.fileExists(p)) {
                    resolved = Object.freeze({
                        browser: entry.name,
                        execPath: p,
                        source: 'standard-path',
                        packaging: linuxPackaging(p),
                        isDefault: false,
                    });
                    break;
                }
            }
        }
        if (resolved)
            out.push(resolved);
    }
    return Object.freeze(out);
};
/**
 * Linux flatpak: surface installed flatpak Chromium-family apps. There is no
 * host binary to probe (the executable lives inside the flatpak), so we ask
 * flatpak directly — `flatpak info <app-id>` exits 0 when the app is installed.
 * Each hit carries source:'flatpak' + the app-id in BOTH execPath (what
 * `flatpak run` + profile-dir resolution consume) and appId (the explicit
 * spawn-builder signal). App-id↔browser mapping is reused from LINUX_FLATPAK,
 * never re-derived. Appended AFTER the PATH/standard pass so a native/snap
 * install of the same browser is preferred by first-match selection.
 */
const detectLinuxFlatpak = async (deps) => {
    const out = [];
    for (const entry of LINUX_FLATPAK) {
        const { code } = await deps.runCommand('flatpak', ['info', entry.appId]);
        if (code === 0) {
            out.push(Object.freeze({
                browser: entry.name,
                execPath: entry.appId,
                source: 'flatpak',
                packaging: 'flatpak',
                isDefault: false,
                appId: entry.appId,
            }));
        }
    }
    return Object.freeze(out);
};
/** macOS: probe the absolute .app bundle exec path. Best-effort (deferred). */
const detectDarwinBinaries = async (deps) => {
    const out = [];
    for (const entry of MAC_BINARIES) {
        if (await deps.fileExists(entry.execPath)) {
            out.push(Object.freeze({
                browser: entry.name,
                execPath: entry.execPath,
                source: 'standard-path',
                packaging: 'native',
                isDefault: false,
            }));
        }
    }
    return Object.freeze(out);
};
/** Windows: join each table row onto every available Program Files root. Best-effort (deferred). */
const detectWin32Binaries = async (env, deps) => {
    const roots = [
        env.PROGRAMFILES,
        env['PROGRAMFILES(X86)'],
        env.LOCALAPPDATA,
    ].filter((r) => typeof r === 'string' && r.length > 0);
    const out = [];
    for (const entry of WIN_BINARIES) {
        let resolved = null;
        for (const root of roots) {
            const execPath = join(root, ...entry.segments);
            if (await deps.fileExists(execPath)) {
                resolved = Object.freeze({
                    browser: entry.name,
                    execPath,
                    source: 'standard-path',
                    packaging: 'native',
                    isDefault: false,
                });
                break;
            }
        }
        if (resolved)
            out.push(resolved);
    }
    return Object.freeze(out);
};
/**
 * Locate every installed Chromium-family browser executable for the platform.
 * Unknown platforms return an empty list (no throw) so callers degrade
 * gracefully.
 */
const discoverBinaries = async (platform, env, deps) => {
    if (platform === 'linux') {
        const native = await detectLinuxBinaries(deps);
        const flatpak = await detectLinuxFlatpak(deps);
        return Object.freeze([...native, ...flatpak]);
    }
    if (platform === 'darwin')
        return detectDarwinBinaries(deps);
    if (platform === 'win32')
        return detectWin32Binaries(env, deps);
    return Object.freeze([]);
};

/**
 * System-default browser detection, per OS.
 *
 * Linux  — `xdg-settings get default-web-browser` → a `.desktop` id.
 * macOS  — `defaults read com.apple.LaunchServices/com.apple.launchservices.secure
 *           LSHandlers` → the LSHandlerRoleAll bundle id for the http scheme.
 * Windows— `reg query HKCU\…\UrlAssociations\http\UserChoice /v ProgId` → ProgId.
 *
 * Each path reduces to "find the first known pattern inside an opaque id
 * string" (BrowserPatternEntry tables in binary_table.ts), so all three share
 * one matcher. All command execution is injected via DiscoveryDeps; a missing
 * binary or non-zero exit is a graceful null, never a throw.
 *
 * NOTE: the macOS + Windows paths are written but NOT yet verified on a real
 * machine (dev box is Linux). The parsers are unit-tested against captured-
 * format fixtures; live verification is tracked under task 82.
 */
/** First pattern (lowercased substring) contained in `raw`, or null. */
const matchBrowserPattern = (raw, table) => {
    const id = raw.trim().toLowerCase();
    if (id.length === 0)
        return null;
    for (const entry of table) {
        if (id.includes(entry.pattern))
            return entry.name;
    }
    return null;
};
const detectDefaultLinux = async (deps) => {
    const { code, stdout } = await deps.runCommand('xdg-settings', [
        'get',
        'default-web-browser',
    ]);
    if (code !== 0)
        return null;
    return matchBrowserPattern(stdout, DESKTOP_TO_BROWSER);
};
/**
 * Extract the http(s)-scheme handler bundle id from `defaults read … LSHandlers`
 * old-style-plist output. The array is a list of `{ … }` dicts; the relevant
 * one carries `LSHandlerURLScheme = http(s)` plus `LSHandlerRoleAll = "<id>"`.
 * Keys appear in any order within a dict, so we scan per-dict blocks.
 */
const parseDarwinHttpHandler = (stdout) => {
    for (const block of stdout.split('}')) {
        if (!/LSHandlerURLScheme\s*=\s*"?https?"?\s*;/.test(block))
            continue;
        const role = block.match(/LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?\s*;/);
        if (role?.[1])
            return role[1];
    }
    return null;
};
const detectDarwinDefault = async (deps) => {
    const { code, stdout } = await deps.runCommand('defaults', [
        'read',
        'com.apple.LaunchServices/com.apple.launchservices.secure',
        'LSHandlers',
    ]);
    if (code !== 0)
        return null;
    const bundleId = parseDarwinHttpHandler(stdout);
    return bundleId ? matchBrowserPattern(bundleId, MAC_BUNDLE_TO_BROWSER) : null;
};
/**
 * Extract the ProgId value from `reg query … /v ProgId` output. The value line
 * is `    ProgId    REG_SZ    <ProgId>`; the ProgId is the final whitespace-
 * delimited token on that line.
 */
const parseWinProgId = (stdout) => {
    for (const line of stdout.split(/\r?\n/)) {
        if (!/\bProgId\b/.test(line) || !/REG_SZ/.test(line))
            continue;
        const token = line.trim().split(/\s+/).at(-1);
        if (token && token !== 'REG_SZ')
            return token;
    }
    return null;
};
const detectWin32Default = async (deps) => {
    const { code, stdout } = await deps.runCommand('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
        '/v',
        'ProgId',
    ]);
    if (code !== 0)
        return null;
    const progId = parseWinProgId(stdout);
    return progId ? matchBrowserPattern(progId, WIN_PROGID_TO_BROWSER) : null;
};
/**
 * Resolve the system-default web browser as a BrowserName, or null when it is
 * unknown, non-Chromium, or the OS is unsupported.
 */
const detectDefaultBrowser = async (platform, deps) => {
    if (platform === 'linux')
        return detectDefaultLinux(deps);
    if (platform === 'darwin')
        return detectDarwinDefault(deps);
    if (platform === 'win32')
        return detectWin32Default(deps);
    return null;
};

/**
 * Browser-discovery orchestrator — the single public entry point.
 *
 * Thin composition: locate executables (discover_binaries) + the system
 * default (default_browser), then stamp `isDefault` on the matching row. No OS
 * logic lives here. The future pdl_browser_status MCP tool (M17) consumes this.
 */
const discoverBrowsers = async (platform, env, deps) => {
    const located = await discoverBinaries(platform, env, deps);
    const defaultBrowser = await detectDefaultBrowser(platform, deps);
    const browsers = Object.freeze(located.map((b) => Object.freeze({ ...b, isDefault: b.browser === defaultBrowser })));
    return Object.freeze({ platform, browsers, defaultBrowser });
};

/**
 * The impure edge: real DiscoveryDeps backed by node:fs + node:child_process.
 *
 * Kept isolated from all detection logic so the rest of the module stays pure
 * and unit-testable with fakes. Mirrors host_io's "side effects live here,
 * callers stay pure" boundary.
 */
/** Resolve a PATH name to an absolute path via `command -v`; null if absent. */
const whichImpl = (name) => new Promise((resolve) => {
    // `command -v` is POSIX-portable and avoids depending on the `which` binary.
    execFile('/bin/sh', ['-c', `command -v -- "${name}"`], (err, stdout) => {
        if (err)
            return resolve(null);
        const line = stdout.trim();
        resolve(line.length > 0 ? line : null);
    });
});
/** True when the path exists and is a regular, executable file. */
const fileExistsImpl = async (absPath) => {
    try {
        const s = await stat(absPath);
        if (!s.isFile())
            return false;
        await access(absPath, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
};
/** Run a command, capturing stdout + exit code. Never rejects. */
const runCommandImpl$1 = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, [...args], (err, stdout) => {
        if (err) {
            const code = typeof err.code === 'number'
                ? (err.code)
                : 1;
            resolve({ code, stdout: stdout ?? '' });
            return;
        }
        resolve({ code: 0, stdout: stdout ?? '' });
    });
});
/** Production DiscoveryDeps wiring real OS effects. */
const defaultDiscoveryDeps = () => Object.freeze({
    which: whichImpl,
    fileExists: fileExistsImpl,
    runCommand: runCommandImpl$1,
});

/**
 * Default user-data-dir resolution per OS — the profile dir passed to
 * --user-data-dir when spawning fresh in 'existing' mode.
 *
 * OS-modularized: one frozen row per browser per OS. Linux native is
 * first-class; macOS / Windows rows are present but unverified on a real
 * machine (see task 82). Linux SNAP confinement is handled: a snap browser
 * (execPath under /snap/) stores its profile at ~/snap/<snap>/common/<cfg>,
 * NOT ~/.config, so the native path would be wrong. Linux FLATPAK is handled
 * too: a flatpak browser (execPath is the slash-free app-id) stores its profile
 * at ~/.var/app/<app-id>/config/<cfg>, resolved against the shared LINUX_FLATPAK
 * table. Resolver returns null when it cannot resolve, so the orchestrator can
 * degrade with a clear message rather than spawn against the wrong profile.
 *
 * NOTE: the Linux segment data overlaps native-messaging/browser_paths
 * LINUX_NATIVE (both describe ~/.config/<browser>). A future consolidation
 * could lift a shared profile-dir resolver; kept separate for M15 to avoid
 * refactoring the NMH-install path. See evolution note.
 */
/** Linux: <config>/<segments> (config = XDG_CONFIG_HOME or HOME/.config). */
const LINUX_PROFILE_DIRS = Object.freeze([
    { name: 'chrome', segments: Object.freeze(['google-chrome']) },
    { name: 'chromium', segments: Object.freeze(['chromium']) },
    { name: 'edge', segments: Object.freeze(['microsoft-edge']) },
    { name: 'brave', segments: Object.freeze(['BraveSoftware', 'Brave-Browser']) },
    { name: 'vivaldi', segments: Object.freeze(['vivaldi']) },
    { name: 'opera', segments: Object.freeze(['opera']) },
]);
/** macOS: ~/Library/Application Support/<segments> (deferred — best-effort). */
const MAC_PROFILE_DIRS = Object.freeze([
    { name: 'chrome', segments: Object.freeze(['Google', 'Chrome']) },
    { name: 'chromium', segments: Object.freeze(['Chromium']) },
    { name: 'edge', segments: Object.freeze(['Microsoft Edge']) },
    { name: 'brave', segments: Object.freeze(['BraveSoftware', 'Brave-Browser']) },
    { name: 'vivaldi', segments: Object.freeze(['Vivaldi']) },
    { name: 'opera', segments: Object.freeze(['com.operasoftware.Opera']) },
]);
/** Windows: %LOCALAPPDATA%/<segments>/User Data (deferred — best-effort). */
const WIN_PROFILE_DIRS = Object.freeze([
    { name: 'chrome', segments: Object.freeze(['Google', 'Chrome']) },
    { name: 'chromium', segments: Object.freeze(['Chromium']) },
    { name: 'edge', segments: Object.freeze(['Microsoft', 'Edge']) },
    { name: 'brave', segments: Object.freeze(['BraveSoftware', 'Brave-Browser']) },
    { name: 'vivaldi', segments: Object.freeze(['Vivaldi']) },
    { name: 'opera', segments: Object.freeze(['Opera Software', 'Opera Stable']) },
]);
const SNAP_PROFILE_DIRS = Object.freeze([
    { name: 'chromium', snap: 'chromium', segments: Object.freeze(['chromium']) },
]);
const rowFor = (table, browser) => table.find((r) => r.name === browser);
/** True when an execPath denotes a snap-packaged browser (e.g. /snap/bin/…). */
const isSnapExec = (execPath) => execPath !== undefined && execPath.includes('/snap/');
/**
 * True when `execPath` is actually a flatpak app-id rather than a real binary
 * path. Discovery sets execPath to the app-id for flatpak browsers; app-ids are
 * reverse-DNS (e.g. org.chromium.Chromium) and never contain a path separator,
 * so a non-empty, slash-free value is a flatpak app-id. A real exec path always
 * contains '/'.
 */
const isFlatpakExec = (execPath) => execPath !== undefined && execPath.length > 0 && !execPath.includes('/');
/** snap confined profile dir, or null when HOME is missing / browser unknown. */
const snapProfileDir = (browser, env) => {
    const row = SNAP_PROFILE_DIRS.find((r) => r.name === browser);
    return row && env.HOME
        ? join(env.HOME, 'snap', row.snap, 'common', ...row.segments)
        : null;
};
/**
 * Flatpak profile dir: ~/.var/app/<app-id>/config/<configSegments>. Resolved by
 * app-id (the flatpak execPath) against LINUX_FLATPAK — the same table the NMH
 * install path and launch-side discovery use, so the app-id↔segment mapping
 * lives in exactly one place. Null when HOME is missing or the app-id is unknown.
 */
const flatpakProfileDir = (appId, env) => {
    const row = LINUX_FLATPAK.find((r) => r.appId === appId);
    return row && env.HOME
        ? join(env.HOME, '.var', 'app', row.appId, 'config', ...row.configSegments)
        : null;
};
const linuxConfigRoot = (env) => {
    if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0)
        return env.XDG_CONFIG_HOME;
    if (env.HOME && env.HOME.length > 0)
        return join(env.HOME, '.config');
    return null;
};
/**
 * Resolve the browser's default user-data-dir, or null when unresolvable
 * (unsupported OS, missing env, or a browser absent from the table).
 *
 * `execPath` (the located browser binary) disambiguates Linux packaging: a
 * snap browser is confined to ~/snap/… so the native ~/.config path would be
 * wrong. Omitting it preserves the native-path behavior (back-compat).
 */
const defaultUserDataDir = (browser, platform, env, execPath) => {
    if (platform === 'linux') {
        if (isSnapExec(execPath))
            return snapProfileDir(browser, env);
        if (isFlatpakExec(execPath))
            return flatpakProfileDir(execPath, env);
        const row = rowFor(LINUX_PROFILE_DIRS, browser);
        const root = linuxConfigRoot(env);
        return row && root ? join(root, ...row.segments) : null;
    }
    if (platform === 'darwin') {
        const row = rowFor(MAC_PROFILE_DIRS, browser);
        return row && env.HOME
            ? join(env.HOME, 'Library', 'Application Support', ...row.segments)
            : null;
    }
    if (platform === 'win32') {
        const row = rowFor(WIN_PROFILE_DIRS, browser);
        return row && env.LOCALAPPDATA
            ? join(env.LOCALAPPDATA, ...row.segments, 'User Data')
            : null;
    }
    return null;
};

/** Classify the browser's runtime state. A live port implies it is running. */
const classifyRunState = (portLive, processRunning) => portLive ? 'port-live' : processRunning ? 'running-no-port' : 'not-running';
/** Choose the launch action for a run state. */
const chooseLaunchAction = (state) => state === 'port-live'
    ? 'attach'
    : state === 'running-no-port'
        ? 'new-window'
        : 'spawn-fresh';

/** CDP endpoint for a debug port. */
const browserUrlFor = (port) => `http://127.0.0.1:${port}`;
/**
 * Chromium flags for a fresh launch — shared by the exec-by-path and flatpak
 * builders so the two command forms differ ONLY in the command prefix, never in
 * the flag set. --no-first-run / --no-default-browser-check keep it non-interactive.
 */
const freshFlags = (port, userDataDir) => Object.freeze([
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
]);
/**
 * Chromium flags for a sandbox launch (dedicated profile + preloaded extension).
 * Shared by the exec-by-path and flatpak builders. See buildSandboxSpawnArgs for
 * why the crash-restore-bubble suppressors are sandbox-only.
 *
 * The extension-preload flags vary by ExtensionLoadStrategy (see extension_load):
 *  - 'load-flag': --load-extension + --disable-extensions-except (the norm).
 *  - 'load-flag-escape-hatch': the same PLUS
 *    --disable-features=DisableLoadExtensionCommandLineSwitch, which re-enables
 *    --load-extension on branded Google Chrome 137..141.
 *  - 'manual-guided': NEITHER flag — branded Google Chrome >=142 ignores
 *    --load-extension, and --disable-extensions-except would additionally block
 *    the manual Load-unpack the user is steered to. The profile/port still come
 *    up; the extension is provisioned by hand afterward.
 *
 * `isolate` (default true) controls --disable-extensions-except, which pins the
 * profile to ONLY pwa-debug — Chromium disables every other extension, including
 * ones already in the persistent profile or Load-unpacked/installed after launch.
 * Pass false to drop it so other extensions coexist: --load-extension still
 * preloads pwa-debug, while the profile's other extensions stay enabled. No-op
 * under 'manual-guided' (the flag is already omitted there).
 */
const sandboxFlags = (port, userDataDir, extensionPath, strategy, isolate) => {
    const extensionFlags = strategy === 'manual-guided'
        ? []
        : [
            `--load-extension=${extensionPath}`,
            ...(isolate ? [`--disable-extensions-except=${extensionPath}`] : []),
            ...(strategy === 'load-flag-escape-hatch'
                ? ['--disable-features=DisableLoadExtensionCommandLineSwitch']
                : []),
        ];
    return Object.freeze([
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        ...extensionFlags,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--hide-crash-restore-bubble',
    ]);
};
/**
 * Wrap chromium flags as a `flatpak run <app-id> <flags>` invocation. Used by
 * every flatpak builder; a flatpak browser has no host exec path, so it can only
 * be launched through `flatpak run`.
 *
 * NO `--` separator: `flatpak run`'s own options precede the app-id, and
 * everything after it is forwarded verbatim to the app. The org.chromium.Chromium
 * wrapper relays those args to chrome, so a literal `--` would reach chrome as
 * its end-of-switches marker — turning --remote-debugging-port etc. into
 * positional "URL" args and silently dropping the debug port. (Verified live
 * 2026-05-29: with `--` the port never binds; without it, it binds in ~1s.)
 */
const flatpakRun = (appId, browserFlags) => Object.freeze({
    cmd: 'flatpak',
    args: Object.freeze(['run', appId, ...browserFlags]),
});
/**
 * Fresh launch (sub-state c): bring up the debug port on the user's profile.
 */
const buildFreshSpawnArgs = (execPath, port, userDataDir) => Object.freeze({ cmd: execPath, args: freshFlags(port, userDataDir) });
/** Fresh launch for a flatpak browser: `flatpak run <app-id> <fresh flags>`. */
const buildFreshFlatpakArgs = (appId, port, userDataDir) => flatpakRun(appId, freshFlags(port, userDataDir));
/**
 * New-window launch (sub-state b): re-invoke the binary so it opens a window
 * in the already-running session via IPC. No debug port — that requires a full
 * restart of the running process, which we never force.
 */
const buildNewWindowArgs = (execPath) => Object.freeze({ cmd: execPath, args: Object.freeze(['--new-window']) });
/** New-window launch for a flatpak browser: `flatpak run <app-id> --new-window`. */
const buildNewWindowFlatpakArgs = (appId) => flatpakRun(appId, Object.freeze(['--new-window']));
/**
 * Sandbox launch: dedicated profile + the pwa-debug extension preloaded BEFORE
 * any tab opens (so the content-script injection race cannot occur).
 * --disable-extensions-except pins the profile to only our extension when
 * `isolate` is true (the default); pass false to let other extensions coexist.
 *
 * --disable-session-crashed-bubble + --hide-crash-restore-bubble suppress the
 * "Brave/Chrome didn't shut down correctly — restore tabs?" prompt on the NEXT
 * launch of this dedicated dev profile. The prompt is decided at startup from
 * the profile's exited_cleanly flag, NOT by how the browser was closed — so
 * this is the durable fix (works regardless of CDP close / SIGTERM / SIGKILL),
 * matching how Puppeteer / chrome-devtools-mcp launch their managed browsers.
 * Applied to sandbox modes only — an 'existing'-mode launch is the user's real
 * profile, where a genuine restore prompt should be left intact.
 */
const buildSandboxSpawnArgs = (execPath, port, userDataDir, extensionPath, strategy, isolate = true) => Object.freeze({
    cmd: execPath,
    args: sandboxFlags(port, userDataDir, extensionPath, strategy, isolate),
});
/**
 * Sandbox launch for a flatpak browser: `flatpak run <app-id> <sandbox flags>`.
 * NOTE: the dedicated --user-data-dir and --load-extension paths live on the
 * host filesystem, so the flatpak app needs host filesystem access
 * (`flatpak override --user --filesystem=host <app-id>`) for these to resolve
 * inside the sandbox — the same prerequisite the NMH path documents.
 */
const buildSandboxFlatpakArgs = (appId, port, userDataDir, extensionPath, strategy, isolate = true) => flatpakRun(appId, sandboxFlags(port, userDataDir, extensionPath, strategy, isolate));

/**
 * 'existing'-mode launch: the graceful-degradation triad orchestrated over the
 * pure run_state decision + spawn_args builders, with all effects injected.
 *
 *   (a) port-live      → attach (no spawn)        attached=true,  browserUrl set
 *   (b) running-no-port → open a new window        attached=false, browserUrl null, degradation
 *   (c) not-running     → spawn fresh with debug   attached=true,  browserUrl set
 */
const degradationMessage = (browser) => `${browser} is already running without a remote-debugging port. Opened a new window in your existing session — pwa-debug extension tools work, but chrome-devtools-mcp (CDP) tools are unavailable this run. To enable CDP, fully quit ${browser} and re-run, or use mode 'sandbox-persistent'.`;
const portBlockedMessage = (browser) => `${browser} (Chromium 136+) was launched, but Chromium refuses a remote-debugging port on your DEFAULT profile, so chrome-devtools-mcp (CDP) cannot attach this run. pwa-debug extension tools work if the extension is installed in this profile. For CDP, use mode 'sandbox-persistent' — a dedicated profile where the debug port works.`;
const launchExisting = async (input, deps) => {
    const portLive = await deps.probeDebugPort(input.port);
    const processRunning = portLive
        ? true
        : await deps.isProcessRunning(input.browser, input.execPath);
    const action = chooseLaunchAction(classifyRunState(portLive, processRunning));
    const base = {
        ok: true,
        browser: input.browser,
        profileType: 'existing',
        action,
    };
    if (action === 'attach') {
        return Object.freeze({
            ...base,
            browserUrl: browserUrlFor(input.port),
            attached: true,
            pid: null,
        });
    }
    if (action === 'new-window') {
        const { cmd, args } = input.appId
            ? buildNewWindowFlatpakArgs(input.appId)
            : buildNewWindowArgs(input.execPath);
        const { pid } = await deps.spawnBrowser(cmd, args);
        return Object.freeze({
            ...base,
            browserUrl: null,
            attached: false,
            pid,
            degradation: degradationMessage(input.browser),
        });
    }
    // spawn-fresh
    const { cmd, args } = input.appId
        ? buildFreshFlatpakArgs(input.appId, input.port, input.userDataDir)
        : buildFreshSpawnArgs(input.execPath, input.port, input.userDataDir);
    const { pid } = await deps.spawnBrowser(cmd, args);
    // Chromium 136+ ignores --remote-debugging-port on the default profile: the
    // browser comes up (pwa-debug extension still usable) but the port never
    // listens. Degrade honestly instead of reporting a dead browserUrl.
    if (input.debugPortBlockedOnDefaultProfile) {
        return Object.freeze({
            ...base,
            browserUrl: null,
            attached: false,
            pid,
            degradation: portBlockedMessage(input.browser),
        });
    }
    return Object.freeze({
        ...base,
        browserUrl: browserUrlFor(input.port),
        attached: true,
        pid,
    });
};

/**
 * Sandbox-mode launch: spawn a dedicated-profile browser process with the
 * pwa-debug extension preloaded, beside the user's normal browser.
 *
 * No triad — a sandbox always uses its own --user-data-dir, so there is no
 * profile-lock collision and no "running without a port" middle state. We only
 * probe our own port to stay idempotent: if our sandbox is already up, attach;
 * otherwise spawn. sandbox-temp additionally registers its dir for shutdown
 * cleanup.
 */
const launchSandbox = async (input, deps) => {
    const base = {
        ok: true,
        browser: input.browser,
        browserUrl: browserUrlFor(input.port),
        profileType: input.mode,
        attached: true,
        userDataDir: input.userDataDir,
    };
    if (await deps.probeDebugPort(input.port)) {
        // Attaching to an already-live sandbox-persistent profile: it may be serving
        // stale extension code from before a rebuild, so refresh on request (#318).
        if (input.refreshExtension)
            await deps.refreshExtension(input.port);
        return Object.freeze({ ...base, action: 'attach', pid: null });
    }
    // ANY Chromium launched with a custom --user-data-dir (which every sandbox
    // mode is) searches <user-data-dir>/NativeMessagingHosts/ for the host
    // manifest — NOT the install-location config dir. This holds for native
    // browsers too (FINDING #3): a native sandbox never inherits the default
    // profile's manifest, so its SW connectNative fails silently without this.
    // Drop a copy into the sandbox profile before spawn. snapPackage routes the
    // manifest at the snap relay launcher; flatpak/native at the node launcher.
    await deps.writeSandboxManifest(input.userDataDir, input.snapPackage);
    // A fresh sandbox profile has Developer Mode OFF, which makes a flatpak Chromium
    // refuse the unpacked --load-extension (#318). Seed developer_mode=true into the
    // profile's Preferences before spawn so the extension loads with no manual step.
    await deps.seedDeveloperMode(input.userDataDir);
    // Default to isolation (clean-room) when unset; false lets other extensions coexist.
    const isolate = input.isolateExtensions ?? true;
    const { cmd, args } = input.appId
        ? buildSandboxFlatpakArgs(input.appId, input.port, input.userDataDir, input.extensionPath, input.loadStrategy, isolate)
        : buildSandboxSpawnArgs(input.execPath, input.port, input.userDataDir, input.extensionPath, input.loadStrategy, isolate);
    const { pid } = await deps.spawnBrowser(cmd, args);
    if (input.mode === 'sandbox-temp') {
        deps.registerTempProfile(input.userDataDir);
    }
    // On a sandbox-persistent relaunch the profile can serve cached extension code,
    // so a refresh re-reads the rebuilt source once the port + SW come up. The
    // effect polls the port itself, tolerating the not-yet-bound spawn (#318).
    if (input.refreshExtension)
        await deps.refreshExtension(input.port);
    const spawned = { ...base, action: 'spawn-fresh', pid };
    // manual-guided (branded Google Chrome >=142): the extension was NOT
    // preloaded — the CDP port is live but pwa-debug stays disconnected until the
    // user completes a one-time Load-unpack. Flag it; launch_browser's next_steps
    // carries the step-by-step. The per-profile manifest is already written above,
    // so connectNative succeeds the moment the extension is loaded.
    return Object.freeze(input.loadStrategy === 'manual-guided'
        ? {
            ...spawned,
            degradation: 'The pwa-debug extension was NOT auto-loaded (branded Google Chrome >=142 ignores --load-extension). The debug port is live for chrome-devtools-mcp, but pwa-debug tools stay disconnected until the extension is loaded manually.',
        }
        : spawned);
};

/** mkdtemp name prefix for sandbox-temp profile dirs (under os.tmpdir()). */
const TEMP_PROFILE_PREFIX = 'pwa-debug-';
/**
 * Filter a directory listing (os.tmpdir() entries) down to pwa-debug sandbox-
 * temp profiles. Used at boot to detect dirs left by a previous crashed run —
 * graceful shutdown cleans its own, so survivors imply a SIGKILL/crash.
 */
const filterTempProfileNames = (names) => names.filter((n) => n.startsWith(TEMP_PROFILE_PREFIX));
const createTempCleanupRegistry = (deps) => {
    const dirs = new Set();
    return Object.freeze({
        register: (dir) => {
            dirs.add(dir);
        },
        cleanupAll: () => {
            for (const dir of dirs) {
                try {
                    deps.removeDir(dir);
                }
                catch {
                    // best-effort; a lingering temp dir is acceptable across crashes.
                }
            }
            dirs.clear();
        },
        list: () => Object.freeze([...dirs]),
    });
};

const BROWSERS$2 = [
    'chrome',
    'chromium',
    'edge',
    'brave',
    'vivaldi',
    'opera',
];
const PROFILE_TYPES = [
    'existing',
    'sandbox-persistent',
    'sandbox-temp',
];
/**
 * A debug port serves exactly one browser at a time, so a new launch on a port
 * supersedes any prior record for it (keeps the list bounded across restarts).
 * Result is ordered newest-last.
 */
const mergeLaunch = (records, rec) => Object.freeze([...records.filter((r) => r.port !== rec.port), rec]);
/** Drop the record for `port` (port is the unique key — see mergeLaunch). */
const removeLaunch = (records, port) => Object.freeze(records.filter((r) => r.port !== port));
/**
 * Validate persisted JSON back into LaunchRecords, dropping malformed entries
 * (a corrupt launches.json must never crash boot). Non-array input → [].
 */
const parseLaunchRecords = (raw) => {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object')
            continue;
        const o = r;
        if (!BROWSERS$2.includes(o['browser']))
            continue;
        if (!PROFILE_TYPES.includes(o['profileType']))
            continue;
        if (typeof o['port'] !== 'number')
            continue;
        if (typeof o['launchedAt'] !== 'number')
            continue;
        const pid = o['pid'];
        const browserUrl = o['browserUrl'];
        const userDataDir = o['userDataDir'];
        out.push(Object.freeze({
            browser: o['browser'],
            profileType: o['profileType'],
            port: o['port'],
            pid: typeof pid === 'number' ? pid : null,
            browserUrl: typeof browserUrl === 'string' ? browserUrl : null,
            ...(typeof userDataDir === 'string' ? { userDataDir } : {}),
            launchedAt: o['launchedAt'],
        }));
    }
    return Object.freeze(out);
};
const createLaunchRegistry = (deps) => {
    let records = deps.load ? [...deps.load()] : [];
    return Object.freeze({
        record: (rec) => {
            records = mergeLaunch(records, Object.freeze({ ...rec, launchedAt: deps.now() }));
            deps.persist?.(records);
        },
        list: () => Object.freeze([...records]),
        remove: (port) => {
            records = removeLaunch(records, port);
            deps.persist?.(records);
        },
    });
};

/**
 * Sandbox profile-dir + extension-path resolution (pure).
 *
 * The persistent profile dir is deterministic (~/.pwa-debug/profiles/<browser>).
 * The extension path is picked from an ordered candidate list — env override,
 * a host-bundled location (populated by M17 packaging), then the monorepo
 * sibling for dev — choosing the first that holds a LOADABLE unpacked extension
 * (manifest.json AND a built entry script). The built-script check is what
 * keeps the picker from selecting the extension SOURCE root, which carries a
 * manifest.json but none of the rollup output it references (Chromium then
 * fails the load with "Could not load javascript 'content-script.js'").
 * All effects (HOME lookup, file existence) are passed in.
 */
/** Per-browser subdir under the sandbox profile root. */
const PROFILE_SUBDIR = Object.freeze({
    chrome: 'chrome',
    chromium: 'chromium',
    edge: 'edge',
    brave: 'brave',
    vivaldi: 'vivaldi',
    opera: 'opera',
});
/** ~/.pwa-debug/profiles/<browser> — stable across host restarts, or null without HOME. */
const persistentProfileDir = (browser, env) => env.HOME && env.HOME.length > 0
    ? join(env.HOME, '.pwa-debug', 'profiles', PROFILE_SUBDIR[browser])
    : null;
/**
 * Ordered extension-dir candidates, most-authoritative first:
 *   1. PWA_DEBUG_EXTENSION_PATH (explicit override)
 *   2. <hostDir>/extension (host-bundled dist — populated by M17 packaging)
 *   3. <hostDir>/../extension/dist (monorepo sibling, dev)
 */
const defaultExtensionCandidates = (env, hostDir) => {
    const out = [];
    if (env.PWA_DEBUG_EXTENSION_PATH && env.PWA_DEBUG_EXTENSION_PATH.length > 0) {
        out.push(env.PWA_DEBUG_EXTENSION_PATH);
    }
    out.push(join(hostDir, 'extension'));
    out.push(join(hostDir, '..', 'extension', 'dist'));
    return Object.freeze(out);
};
/**
 * Files that must BOTH exist for a dir to be a loadable unpacked extension: the
 * manifest and a built entry script. Requiring the script rejects the extension
 * source root (manifest.json present, rollup output absent) — the trap that made
 * the launcher preload a dir Chromium couldn't actually load.
 */
const REQUIRED_EXTENSION_FILES = Object.freeze([
    'manifest.json',
    'content-script.js',
]);
/** True when `dir` holds every REQUIRED_EXTENSION_FILES entry (existence injected). */
const isLoadableExtensionDir = (dir, exists) => REQUIRED_EXTENSION_FILES.every((f) => exists(join(dir, f)));
/** First candidate dir that holds a loadable unpacked extension, else null. */
const pickExtensionPath = (candidates, isLoadable) => {
    for (const dir of candidates) {
        if (isLoadable(dir))
            return dir;
    }
    return null;
};

/**
 * Pure browser brand+version → launch capabilities (unpacked-extension load +
 * debug-port-on-default-profile). One place for "what can this browser version
 * do at launch", all keyed off the BrowserVersion parsed from `--version`.
 *
 * Branded Google Chrome removed the --load-extension CLI flag: at 137 (with a
 * temporary escape hatch, --disable-features=DisableLoadExtensionCommandLineSwitch)
 * and FULLY at 142+ (escape hatch also removed). Every OTHER Chromium-family
 * browser — unbranded Chromium, Chrome-for-Testing, Brave, Edge, Opera, Vivaldi —
 * still honors --load-extension. So the sandbox extension-preload behavior is a
 * function of brand + major version, computed here (pure) and consumed by the
 * spawn-arg builder + the launch guidance. The version string is produced at the
 * edge (`<binary> --version`) and parsed by parseBrowserVersion;
 * extensionLoadStrategy maps the result to the launch behavior.
 *
 * Refs: research note #331, decision note #332.
 */
/** Brand matchers against the leading product name of `<binary> --version`,
 *  most-specific first (Chrome-for-Testing before the google-chrome prefix). */
const BRAND_MATCHERS = Object.freeze([
    [/google chrome for testing/i, 'chrome-for-testing'],
    [/google chrome/i, 'google-chrome'],
    [/brave browser/i, 'brave'],
    [/microsoft edge/i, 'edge'],
    [/\bchromium\b/i, 'chromium'],
    [/\bvivaldi\b/i, 'vivaldi'],
    [/\bopera\b/i, 'opera'],
]);
/**
 * Parse the stdout of `<binary> --version` into a brand + major version.
 * Examples: "Google Chrome 148.0.7778.215", "Brave Browser 148.1.90.122",
 * "Chromium 148.0.7778.167 snap", "Microsoft Edge 141.0.3537.57". Returns null
 * when no dotted version number is present; an unrecognized product name still
 * parses (brand 'unknown') as long as a version is found.
 */
const parseBrowserVersion = (stdout) => {
    const text = stdout.trim();
    if (text.length === 0)
        return null;
    const m = text.match(/(\d+)\.\d+\.\d+/);
    if (!m)
        return null;
    const major = Number(m[1]);
    if (!Number.isInteger(major))
        return null;
    const brand = BRAND_MATCHERS.find(([re]) => re.test(text))?.[1] ?? 'unknown';
    return Object.freeze({ brand, major });
};
/** Chrome major at which --load-extension started being gated (escape-hatch era). */
const CHROME_GATED_FROM = 137;
/** Chrome major at which --load-extension AND the escape hatch are both gone. */
const CHROME_DEAD_FROM = 142;
/**
 * Map a parsed version to the sandbox extension-load strategy. Only branded
 * Google Chrome is constrained; every other brand (and an unknown brand) gets
 * the plain flag, which still works. A null version (couldn't read `--version`)
 * is treated optimistically as 'load-flag' — better to attempt the flag than to
 * force the manual path on a browser that very likely supports it.
 */
const extensionLoadStrategy = (version) => {
    if (!version || version.brand !== 'google-chrome')
        return 'load-flag';
    if (version.major >= CHROME_DEAD_FROM)
        return 'manual-guided';
    if (version.major >= CHROME_GATED_FROM)
        return 'load-flag-escape-hatch';
    return 'load-flag';
};
/** Chromium major from which --remote-debugging-port is refused on the DEFAULT
 *  profile (must use a custom --user-data-dir). Brand-agnostic Chromium change. */
const DEBUG_PORT_CUSTOM_DIR_FROM = 136;
/**
 * True when this browser refuses --remote-debugging-port on the default profile
 * (Chromium >=136 — brand-agnostic). existing-mode uses the user's default
 * profile, so when this holds the spawned browser will NOT expose a debug port;
 * the launch degrades (no false browserUrl) and steers to a sandbox profile
 * (custom dir), where the port works. null version => false (attempt the port).
 */
const debugPortBlockedOnDefaultProfile = (version) => version !== null && version.major >= DEBUG_PORT_CUSTOM_DIR_FROM;
/**
 * Edge (effect injected): read a browser's brand+version by invoking its
 * `--version`. Native/snap browsers run `<execPath> --version`; a flatpak target
 * (appId set, no host binary) runs `flatpak run <appId> --version`. A non-zero
 * exit or unparseable output yields null, so the caller falls back to the
 * optimistic 'load-flag' strategy rather than blocking a launch on a version
 * read it couldn't complete.
 */
const readBrowserVersion = async (runCommand, target) => {
    const { cmd, args } = target.appId
        ? { cmd: 'flatpak', args: ['run', target.appId, '--version'] }
        : { cmd: target.execPath, args: ['--version'] };
    const res = await runCommand(cmd, args);
    if (res.code !== 0)
        return null;
    return parseBrowserVersion(res.stdout);
};

/**
 * Pure profile-Preferences seeding for sandbox launches.
 *
 * A fresh Chromium profile (every sandbox-temp dir, and a sandbox-persistent dir
 * on its first launch) starts with Developer Mode OFF. A flatpak Chromium then
 * REFUSES to honor --load-extension for an unpacked extension, so the pwa-debug
 * extension never loads/connects until the user toggles Developer Mode by hand
 * at chrome://extensions (note 318). Chromium reads the profile's
 * <user-data-dir>/Default/Preferences at startup, so writing
 * extensions.ui.developer_mode=true into it BEFORE spawn unblocks --load-extension
 * with no manual step.
 *
 * Pure here: the path derivation and the non-destructive merge. The read/write
 * effect lives at the edge (node_deps.seedDeveloperModeImpl).
 */
/**
 * The profile Preferences file Chromium reads at startup:
 * <user-data-dir>/Default/Preferences. Seeding it before spawn is how a flag we
 * cannot pass on the command line (developer_mode) gets applied on first run.
 */
const profilePreferencesPath = (userDataDir) => join(userDataDir, 'Default', 'Preferences');
/** Read an object-valued subkey from a prefs object, or {} when absent/non-object. */
const objAt = (obj, key) => {
    const v = obj[key];
    return v !== null && typeof v === 'object' && !Array.isArray(v)
        ? v
        : {};
};
/**
 * Merge extensions.ui.developer_mode=true into an existing Preferences object
 * (or a fresh one when `existing` is null), preserving every other key. Returns a
 * NEW object — the input is never mutated. Only the developer_mode leaf is forced;
 * any sibling extensions.* / extensions.ui.* settings carry through untouched, so
 * re-seeding a persistent profile that already has real prefs is safe.
 */
const mergeDeveloperModePref = (existing) => {
    const base = existing ?? {};
    const extensions = objAt(base, 'extensions');
    const ui = objAt(extensions, 'ui');
    return {
        ...base,
        extensions: {
            ...extensions,
            ui: { ...ui, developer_mode: true },
        },
    };
};

/**
 * Pure CDP-target selection for the persistent-profile extension auto-refresh.
 *
 * A sandbox-persistent profile caches the unpacked extension and serves STALE
 * page-world/SW code on relaunch — newly added pdl_* tools report "unknown tool"
 * even though the on-disk bundle is current (note 318). The fix is to force
 * chrome.runtime.reload() in the extension's MV3 service worker over CDP, which
 * makes it re-read the source dir. To do that we need the SW's
 * webSocketDebuggerUrl from the browser's /json/list — the pure pick lives here;
 * the websocket effect lives at the edge (node_deps.refreshExtensionImpl).
 */
/** A loaded MV3 extension surfaces its service worker as a chrome-extension:// target. */
const EXTENSION_SW_URL_RE = /^chrome-extension:\/\//;
/**
 * The webSocketDebuggerUrl of the first loaded-extension service-worker target in
 * a CDP /json/list body, or null when none is present (port not up yet, or the
 * extension's SW hasn't started). Tolerant of arbitrary/malformed entries — only
 * an object with type==='service_worker', a chrome-extension:// url, and a string
 * webSocketDebuggerUrl qualifies.
 */
const extensionSwWsUrl = (targets) => {
    for (const t of targets) {
        if (t === null || typeof t !== 'object')
            continue;
        const o = t;
        if (o.type === 'service_worker' &&
            typeof o.url === 'string' &&
            EXTENSION_SW_URL_RE.test(o.url) &&
            typeof o.webSocketDebuggerUrl === 'string') {
            return o.webSocketDebuggerUrl;
        }
    }
    return null;
};

/**
 * The impure edge: real LaunchDeps backed by fetch + node:child_process.
 * Isolated from all decision logic so launch_existing stays pure + testable.
 */
const PROBE_TIMEOUT_MS = 800;
/** GET /json/version on the debug port; a 2xx JSON body means the port is live. */
const probeDebugPortImpl = async (port) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: controller.signal,
        });
        if (!res.ok)
            return false;
        const body = (await res.json().catch(() => null));
        return body !== null && typeof body === 'object';
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timer);
    }
};
/** pgrep -f the executable basename; exit 0 with output means it is running. */
const isProcessRunningImpl = (_browser, execPath) => new Promise((resolve) => {
    execFile('pgrep', ['-f', basename(execPath)], (err, stdout) => {
        // pgrep exits 1 (→ err) when no process matches; treat as not-running.
        if (err)
            return resolve(false);
        resolve(stdout.trim().length > 0);
    });
});
/** Spawn detached + unref so the browser outlives the host process. */
const spawnBrowserImpl = (cmd, args) => new Promise((resolve, reject) => {
    try {
        const child = spawn(cmd, [...args], {
            detached: true,
            stdio: 'ignore',
        });
        // Surface synchronous spawn failures (e.g. ENOENT) before unref/resolve.
        child.once('error', reject);
        const pid = child.pid ?? null;
        child.unref();
        resolve({ pid });
    }
    catch (e) {
        reject(e);
    }
});
/** Production LaunchDeps wiring real OS effects. */
const defaultLaunchDeps = () => Object.freeze({
    probeDebugPort: probeDebugPortImpl,
    isProcessRunning: isProcessRunningImpl,
    spawnBrowser: spawnBrowserImpl,
});
/** Create a fresh mkdtemp profile dir for a sandbox-temp launch. */
const makeTempProfileDir = () => mkdtempSync(join(tmpdir(), TEMP_PROFILE_PREFIX));
/**
 * Resolve a sandbox-mode profile dir, packaging-aware. Snap browsers cannot use
 * ~/.pwa-debug (a hidden dir the snap home interface blocks → the browser exits
 * instantly), so they route to ~/snap/<pkg>/common: a persistent
 * pwa-debug-profile dir, or a fresh mkdtemp under common for sandbox-temp. The
 * snap-common dir already exists (the snap is installed). Native/flatpak keep
 * the ~/.pwa-debug layout. Returns null when the dir can't be resolved.
 */
const resolveSandboxProfileDir = (browser, mode, packaging, env) => {
    if (packaging === 'snap') {
        const pkg = snapPackageForBrowser(browser);
        if (!pkg || !env.HOME)
            return null;
        if (mode === 'sandbox-temp') {
            const common = join(env.HOME, 'snap', pkg, 'common');
            return mkdtempSync(join(common, TEMP_PROFILE_PREFIX));
        }
        return snapSandboxProfileDir(pkg, env);
    }
    return mode === 'sandbox-temp'
        ? makeTempProfileDir()
        : persistentProfileDir(browser, env);
};
/**
 * Absolute paths of sandbox-temp profile dirs lingering under os.tmpdir() from
 * a previous run. Graceful shutdown removes its own, so any survivors imply a
 * crash/SIGKILL. Warn-only at boot: mkdtemp names don't identify the owning
 * host process, so auto-removal could delete a concurrently-running host's
 * active profile. Never throws (a missing/unreadable tmpdir yields []).
 */
const findLingeringTempProfiles = () => {
    try {
        const base = tmpdir();
        return filterTempProfileNames(readdirSync(base)).map((n) => join(base, n));
    }
    catch {
        return [];
    }
};
// Lazy module-singleton temp-cleanup registry: created on first sandbox-temp
// launch, with process signal handlers installed exactly once.
let tempRegistry = null;
const getTempRegistry = () => {
    if (tempRegistry)
        return tempRegistry;
    const registry = createTempCleanupRegistry({
        removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
    });
    const onSignal = () => {
        registry.cleanupAll();
        process.exit(0);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('exit', () => registry.cleanupAll());
    tempRegistry = registry;
    return registry;
};
/**
 * Absolute host-package root. The host bundles to a single packages/host/dist/
 * main.js, so this module's dir is packages/host/dist — ONE level below the
 * package root. (The earlier '..','..' overshot to packages/, making the
 * candidate `<pkg>/extension` resolve to the extension SOURCE root.)
 */
const hostPackageDir = () => resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Resolve the unpacked extension dir to preload, or null when none is found. */
const resolveExtensionPath = (env) => pickExtensionPath(defaultExtensionCandidates(env, hostPackageDir()), (dir) => isLoadableExtensionDir(dir, (p) => existsSync(p)));
/** execFile wrapped as a never-rejecting {code, stdout} runner (for --version). */
const runCommandImpl = (cmd, args) => new Promise((resolveCmd) => {
    execFile(cmd, [...args], (err, stdout) => {
        const code = err && typeof err.code === 'number'
            ? err.code
            : err
                ? 1
                : 0;
        resolveCmd({ code, stdout: stdout ?? '' });
    });
});
/**
 * Production readVersion: run the target's `--version` (native/snap by execPath;
 * flatpak via `flatpak run <appId>`) and parse it into a BrowserVersion. null on
 * any failure → the launch falls back to the optimistic 'load-flag' strategy.
 */
const readTargetBrowserVersion = (target) => readBrowserVersion(runCommandImpl, {
    execPath: target.execPath,
    ...(target.appId !== undefined ? { appId: target.appId } : {}),
});
/**
 * Sandbox manifest writer (all confinements, native included). Loads the
 * registered extension IDs, builds the host manifest, and writes it into
 * <userDataDir>/NativeMessagingHosts/ so the spawned Chromium — which searches
 * the user-data-dir, not the install location (FINDING #3 applies to native
 * custom-dir profiles too) — finds the host. The launcher the manifest points
 * at depends on the confinement: for SNAP, ensure the snap relay + launcher
 * exist under ~/snap/<pkg>/common (node is exec-denied + glibc-incompatible
 * there) and point at that launcher; otherwise (native/flatpak) point at the
 * canonical node launcher. No-op when no extension is registered (connectNative
 * would be rejected anyway; host_register_extension is the prerequisite).
 */
const writeSandboxManifestImpl = async (userDataDir, snapPackage) => {
    const state = await loadHostState(defaultStatePath());
    if (state.extensionIds.length === 0)
        return;
    let hostBinaryPath;
    if (snapPackage !== undefined) {
        const snap = await writeSnapHostFiles(snapPackage, process.env);
        if (!snap)
            return;
        hostBinaryPath = snap.launcherPath;
    }
    else {
        hostBinaryPath = defaultLauncherPath(process.platform, process.env);
    }
    const manifest = buildHostManifest({
        name: HOST_NAME$3,
        description: HOST_DESCRIPTION$1,
        hostBinaryPath,
        allowedExtensionIds: state.extensionIds,
    });
    await writeHostManifestToDir(manifest, join(userDataDir, 'NativeMessagingHosts'));
};
/**
 * Seed extensions.ui.developer_mode=true into the sandbox profile's
 * Default/Preferences before spawn (#318), so a flatpak Chromium honors the
 * unpacked --load-extension without a manual Developer-Mode toggle. Reads any
 * existing Preferences and merges non-destructively; creates Default/ as needed;
 * writes atomically (temp+rename). Best-effort: a read/parse/write failure must
 * never break the launch — the manual Developer-Mode path still works.
 */
const seedDeveloperModeImpl = async (userDataDir) => {
    try {
        const prefsPath = profilePreferencesPath(userDataDir);
        let existing = null;
        if (existsSync(prefsPath)) {
            try {
                existing = JSON.parse(readFileSync(prefsPath, 'utf-8'));
            }
            catch {
                existing = null; // corrupt Preferences → reseed from scratch
            }
        }
        const merged = mergeDeveloperModePref(existing);
        mkdirSync(dirname(prefsPath), { recursive: true });
        const tmp = `${prefsPath}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(merged));
        renameSync(tmp, prefsPath);
    }
    catch {
        // best-effort; never break the launch on a seeding failure.
    }
};
const REFRESH_POLL_ATTEMPTS = 20;
const REFRESH_POLL_INTERVAL_MS = 300;
/** GET /json/list and return its target array (any error / non-array → []). */
const fetchCdpTargets = async (port) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: controller.signal,
        });
        if (!res.ok)
            return [];
        const body = (await res.json().catch(() => null));
        return Array.isArray(body) ? body : [];
    }
    catch {
        return [];
    }
    finally {
        clearTimeout(timer);
    }
};
/**
 * Open the extension SW's CDP websocket and evaluate chrome.runtime.reload(),
 * forcing it to re-read the unpacked source. reload() tears the SW down, so the
 * evaluate response OR the socket closing both count as success; resolves false
 * on error/timeout. Uses Node's global WebSocket (Node >= 22).
 */
const cdpReloadExtension = (wsUrl) => new Promise((resolveP) => {
    let settled = false;
    const finish = (v) => {
        if (!settled) {
            settled = true;
            resolveP(v);
        }
    };
    try {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
            try {
                ws.close();
            }
            catch {
                /* ignore */
            }
            finish(false);
        }, 2000);
        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: 'chrome.runtime.reload()' },
            }));
        });
        ws.addEventListener('message', () => {
            clearTimeout(timer);
            try {
                ws.close();
            }
            catch {
                /* ignore */
            }
            finish(true);
        });
        ws.addEventListener('close', () => {
            clearTimeout(timer);
            finish(true);
        });
        ws.addEventListener('error', () => {
            clearTimeout(timer);
            finish(false);
        });
    }
    catch {
        finish(false);
    }
});
/**
 * Poll the debug port for the loaded pwa-debug extension's service worker (it
 * appears once the port binds and the SW starts), then force it to reload so a
 * sandbox-persistent relaunch serves the rebuilt code instead of cached code
 * (#318). Tolerates a not-yet-bound spawn by polling. Returns true when a reload
 * was issued, false when no extension SW surfaced in time. Never throws.
 */
const refreshExtensionImpl = async (port) => {
    for (let i = 0; i < REFRESH_POLL_ATTEMPTS; i += 1) {
        const wsUrl = extensionSwWsUrl(await fetchCdpTargets(port));
        if (wsUrl)
            return cdpReloadExtension(wsUrl);
        await sleep(REFRESH_POLL_INTERVAL_MS);
    }
    return false;
};
/** Production LaunchSandboxDeps: probe + spawn reused, temp dirs auto-tracked. */
const defaultSandboxDeps = () => Object.freeze({
    probeDebugPort: probeDebugPortImpl,
    spawnBrowser: spawnBrowserImpl,
    registerTempProfile: (dir) => getTempRegistry().register(dir),
    writeSandboxManifest: writeSandboxManifestImpl,
    seedDeveloperMode: seedDeveloperModeImpl,
    refreshExtension: refreshExtensionImpl,
});
// Lazy module-singleton launch registry, persisted to launches.json beside the
// host config so pdl_browser_status survives a host restart.
let launchRegistry = null;
/** Path to the persisted launch registry (dedicated file, not state.json). */
const launchesStatePath = () => xdgConfigPath('launches.json');
/** Read persisted launches; any error (missing/corrupt/no-HOME) → []. */
const loadPersistedLaunches = () => {
    try {
        return parseLaunchRecords(JSON.parse(readFileSync(launchesStatePath(), 'utf-8')));
    }
    catch {
        return [];
    }
};
/** Crash-safe write of the launch registry; best-effort (never throws). */
const persistLaunches = (records) => {
    try {
        const path = launchesStatePath();
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp.${process.pid}`;
        writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`);
        renameSync(tmp, path);
    }
    catch {
        // best-effort; a failed persist must never break the launch path.
    }
};
/** The host-process launch registry (created on first use). */
const getLaunchRegistry = () => {
    if (!launchRegistry) {
        launchRegistry = createLaunchRegistry({
            now: Date.now,
            load: loadPersistedLaunches,
            persist: persistLaunches,
        });
    }
    return launchRegistry;
};
// ── pdl_close_browser effects ──────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll the debug port until it stops answering (browser gone) or attempts run out. */
const waitForPortDown = async (port, attempts) => {
    for (let i = 0; i < attempts; i += 1) {
        if (!(await probeDebugPortImpl(port)))
            return true;
        await sleep(250);
    }
    return !(await probeDebugPortImpl(port));
};
/** Read the browser-level CDP WebSocket URL from /json/version (null if absent). */
const fetchBrowserWsUrl = async (port) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: controller.signal,
        });
        if (!res.ok)
            return null;
        const body = (await res.json().catch(() => null));
        const url = body?.webSocketDebuggerUrl;
        return typeof url === 'string' ? url : null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
};
/**
 * Canonical graceful quit: connect the browser CDP WebSocket and send
 * Browser.close. The browser exits cleanly (no crash-restore bubble) and the
 * socket closes. Resolves true once the socket closes, false on error/timeout.
 * Uses Node's global WebSocket (Node >= 22).
 */
const cdpBrowserClose = (wsUrl) => new Promise((resolveP) => {
    let settled = false;
    const finish = (v) => {
        if (!settled) {
            settled = true;
            resolveP(v);
        }
    };
    try {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
            try {
                ws.close();
            }
            catch {
                /* ignore */
            }
            finish(false);
        }, 2000);
        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
        });
        // Browser.close makes the browser exit → the socket closes: that's success.
        ws.addEventListener('close', () => {
            clearTimeout(timer);
            finish(true);
        });
        ws.addEventListener('error', () => {
            clearTimeout(timer);
            finish(false);
        });
    }
    catch {
        finish(false);
    }
});
/**
 * Stop a managed launch, preferring a clean shutdown:
 *  1. port already down → already-down (idempotent).
 *  2. CDP Browser.close over the WebSocket → clean quit, no restore bubble.
 *  3. SIGTERM the spawned pid (graceful) → 4. SIGKILL last resort.
 * Each step waits for the debug port to go down before reporting success.
 */
const terminateManagedBrowserImpl = async (record) => {
    if (!(await probeDebugPortImpl(record.port))) {
        return { closed: true, method: 'already-down' };
    }
    const wsUrl = await fetchBrowserWsUrl(record.port);
    if (wsUrl) {
        await cdpBrowserClose(wsUrl);
        if (await waitForPortDown(record.port, 8)) {
            return { closed: true, method: 'cdp' };
        }
    }
    if (record.pid !== null) {
        try {
            process.kill(record.pid, 'SIGTERM');
        }
        catch {
            /* already gone */
        }
        if (await waitForPortDown(record.port, 8)) {
            return { closed: true, method: 'sigterm' };
        }
        try {
            process.kill(record.pid, 'SIGKILL');
        }
        catch {
            /* already gone */
        }
        if (await waitForPortDown(record.port, 8)) {
            return { closed: true, method: 'sigkill' };
        }
    }
    return { closed: false, method: 'failed' };
};
/** Regex-escape a string for safe use as a pgrep -f pattern. */
const escapeForPgrep = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * True when any process still has `dir` in its command line — i.e. a browser
 * instance is still using this profile. Uses pgrep -f over the escaped path.
 * pgrep exits 1 (→ err) when nothing matches; treat that as not-referenced.
 */
const profileDirReferenced = (dir) => new Promise((resolveP) => {
    execFile('pgrep', ['-f', escapeForPgrep(dir)], (err, stdout) => {
        if (err)
            return resolveP(false);
        resolveP(stdout.trim().length > 0);
    });
});
/** Poll until no process references the profile dir (browser fully exited) or attempts run out. */
const waitForProfileReleased = async (dir, attempts) => {
    for (let i = 0; i < attempts; i += 1) {
        if (!(await profileDirReferenced(dir)))
            return;
        await sleep(250);
    }
};
/**
 * Remove a sandbox profile dir, GUARDED: only paths under ~/.pwa-debug/profiles
 * or an os.tmpdir() entry with the sandbox-temp prefix are eligible — defense in
 * depth so a bad caller can never rm an arbitrary (e.g. user-profile) dir.
 *
 * A clean CDP Browser.close drops the debug port early, but the browser's child
 * processes keep flushing the profile to disk for a few seconds after — an
 * immediate rmSync races those writes and the dir gets repopulated. So we first
 * wait until no process still references the dir (the browser has fully exited),
 * then delete and re-check once. Returns true only when the dir is actually gone.
 */
const discardProfileDirImpl = async (dir) => {
    const resolved = resolve(dir);
    const underPwaProfiles = resolved.includes(join('.pwa-debug', 'profiles'));
    const isTempProfile = dirname(resolved) === resolve(tmpdir()) &&
        basename(resolved).startsWith(TEMP_PROFILE_PREFIX);
    if (!underPwaProfiles && !isTempProfile)
        return false;
    await waitForProfileReleased(resolved, 40); // up to ~10s for graceful shutdown
    try {
        rmSync(resolved, { recursive: true, force: true });
    }
    catch {
        /* best-effort */
    }
    // A final shutdown write can race the delete; retry once if it reappeared.
    if (existsSync(resolved)) {
        await sleep(250);
        try {
            rmSync(resolved, { recursive: true, force: true });
        }
        catch {
            /* best-effort */
        }
    }
    return !existsSync(resolved);
};
const BROWSER_URL_ARG_RE = /--browserUrl(?:[=\s]+)(\S+)/;
/**
 * Read the REAL chrome-devtools-mcp registration from Claude Code via
 * `claude mcp get chrome-devtools`. A zero exit means it is registered; the
 * configured --browserUrl is regex-extracted from the (human-readable) output.
 * This MCP is Claude-Code-targeted, so the `claude` CLI is the source of truth —
 * we deliberately do NOT fall back to parsing ~/.claude.json. Never rejects:
 * returns { registered: false } when `claude` is absent, errors, or times out.
 */
const readChromeDevtoolsRegistration = () => new Promise((resolveP) => {
    execFile('claude', ['mcp', 'get', 'chrome-devtools'], { timeout: 10_000 }, (err, stdout) => {
        if (err) {
            resolveP({ registered: false, browserUrl: null });
            return;
        }
        const match = BROWSER_URL_ARG_RE.exec(stdout ?? '');
        resolveP({ registered: true, browserUrl: match?.[1] ?? null });
    });
});
const runClaudeMcp = (args) => new Promise((resolveP) => {
    execFile('claude', [...args], { timeout: 15_000 }, (err, _stdout, stderr) => {
        if (err) {
            const detail = (stderr ?? '').trim() || err.message;
            resolveP({ ok: false, error: detail });
            return;
        }
        resolveP({ ok: true, error: null });
    });
});
/**
 * Register chrome-devtools-mcp with Claude Code (user scope) pointed at the
 * given CDP browserUrl, via `claude mcp add`. This writes a DIRECT MCP
 * registration — Claude Code must be restarted for the new server to load.
 */
const addChromeDevtoolsRegistration = (browserUrl) => runClaudeMcp([
    'mcp',
    'add',
    'chrome-devtools',
    '--scope',
    'user',
    '--',
    'npx',
    '-y',
    'chrome-devtools-mcp@latest',
    '--browserUrl',
    browserUrl,
]);
/** Remove the chrome-devtools-mcp registration via `claude mcp remove`. */
const removeChromeDevtoolsRegistration = () => runClaudeMcp(['mcp', 'remove', 'chrome-devtools']);
const EXTENSION_URL_RE = /^chrome-extension:\/\/([a-p]{32})\//;
/**
 * GET /json/list on a live debug port and return the distinct extension IDs of
 * loaded MV3 service-worker targets (an extension surfaces its SW here once
 * loaded). Lets the host spot an extension that is loaded in a managed browser
 * but whose ID is not whitelisted in allowed_origins — the failure mode where
 * the SW loads yet connectNative is rejected. Never rejects: returns [] on any
 * error, a dead port, or a non-array body.
 */
const fetchLoadedExtensionIds = async (port) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: controller.signal,
        });
        if (!res.ok)
            return [];
        const body = (await res.json().catch(() => null));
        if (!Array.isArray(body))
            return [];
        const ids = new Set();
        for (const target of body) {
            if (target === null ||
                typeof target !== 'object' ||
                target.type !== 'service_worker') {
                continue;
            }
            const url = target.url;
            if (typeof url !== 'string')
                continue;
            const id = EXTENSION_URL_RE.exec(url)?.[1];
            if (id)
                ids.add(id);
        }
        return [...ids];
    }
    catch {
        return [];
    }
    finally {
        clearTimeout(timer);
    }
};
/** Recursively copy the unpacked extension dir to a destination. */
const copyDir = (src, dest) => cp(src, dest, { recursive: true });
/** Default install target: ~/Downloads/pwa-debug-extension (or HOME fallback). */
const defaultExtensionTargetDir = (env = process.env) => {
    const home = env.HOME && env.HOME.length > 0 ? env.HOME : '.';
    return join(home, 'Downloads', 'pwa-debug-extension');
};

const BROWSERS$1 = [
    'chrome',
    'chromium',
    'edge',
    'brave',
    'vivaldi',
    'opera',
];
const MODES = ['existing', 'sandbox-persistent', 'sandbox-temp'];
const PACKAGINGS = ['native', 'snap', 'flatpak'];
const inputSchema$5 = {
    browser: enumType(BROWSERS$1).optional(),
    port: numberType().int().min(1).max(65535).optional(),
    mode: enumType(MODES).optional(),
    packaging: enumType(PACKAGINGS).optional(),
    isolateExtensions: booleanType().optional(),
};
const isSandboxMode = (mode) => mode === 'sandbox-persistent' || mode === 'sandbox-temp';
/**
 * Opt-in: after a sandbox-persistent launch, force the extension to reload so a
 * rebuild's new code is served instead of the profile's cached copy (#318). OFF
 * by default — end-user launches are unchanged; set PWA_DEBUG_REFRESH_EXTENSION=1
 * for AI-driven re-verification. Only meaningful for the persistent profile (a
 * temp profile is always fresh).
 */
const refreshExtensionEnabled = (mode, env) => {
    if (mode !== 'sandbox-persistent')
        return false;
    const v = env.PWA_DEBUG_REFRESH_EXTENSION;
    return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
};
/** Tiebreak order when several packagings of the requested browser exist and the
 *  caller did not pin one: prefer a normal system install, then snap, then flatpak. */
const PACKAGING_PREFERENCE = {
    native: 0,
    snap: 1,
    flatpak: 2,
};
/**
 * Pure target selection. Resolves the requested (or system-default, or first)
 * browser NAME, optionally narrows to a requested packaging, and tiebreaks by
 * PACKAGING_PREFERENCE. Also reports the OTHER packagings of the chosen browser
 * so the caller can tell the user/AI it could re-target (e.g. snap vs flatpak).
 */
const resolveTarget = (discovery, requested, packaging) => {
    const name = requested ?? discovery.defaultBrowser ?? discovery.browsers[0]?.browser;
    const sameBrowser = discovery.browsers.filter((b) => b.browser === name);
    const filtered = packaging
        ? sameBrowser.filter((b) => b.packaging === packaging)
        : sameBrowser;
    const target = [...filtered].sort((a, b) => PACKAGING_PREFERENCE[a.packaging] - PACKAGING_PREFERENCE[b.packaging])[0];
    const alternatives = target
        ? [
            ...new Set(sameBrowser
                .filter((b) => b.packaging !== target.packaging)
                .map((b) => b.packaging)),
        ]
        : [];
    return { target, alternatives };
};
const cdpHint = (browserUrl) => `Register chrome-devtools-mcp against it: \`claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest --browserUrl ${browserUrl}\`.`;
const nextStepsFor = (result) => {
    const sandbox = result.profileType !== 'existing';
    if (result.action === 'attach') {
        return [
            `Attached to the already-live debug port at ${result.browserUrl}${sandbox ? ` (${result.profileType} profile)` : ''}. ${cdpHint(result.browserUrl)}`,
        ];
    }
    if (result.action === 'spawn-fresh') {
        // Degraded spawn-fresh: existing-mode on Chromium 136+ couldn't open a debug
        // port on the default profile (browserUrl null). Don't claim a live port.
        if (!result.browserUrl) {
            return [
                result.degradation ??
                    `Spawned ${result.browser}, but no remote-debugging port is available this run.`,
                "For chrome-devtools-mcp (CDP), use pdl_launch_browser mode='sandbox-persistent' — a dedicated profile where the debug port works.",
            ];
        }
        const steps = [
            `Spawned ${result.browser} (pid ${result.pid ?? 'unknown'}) with the debug port live at ${result.browserUrl}. ${cdpHint(result.browserUrl)}`,
        ];
        if (sandbox) {
            const lifetime = result.profileType === 'sandbox-temp'
                ? ' This temp profile is removed on host shutdown.'
                : ' This profile persists across host restarts.';
            // When the launch degraded (manual-guided: branded Chrome >=142 couldn't
            // preload the extension), don't claim it's preloaded — the detailed manual
            // Load-unpack guidance is appended separately by launchOk.
            steps.push(result.degradation
                ? `${result.profileType} profile at ${result.userDataDir}.${lifetime} ${result.degradation}`
                : `${result.profileType} profile at ${result.userDataDir} with the pwa-debug extension preloaded — no chrome://extensions reload needed.${lifetime}`);
        }
        else {
            steps.push('If pwa-debug tools report no connection, ensure host_register_extension has run and reload the extension at chrome://extensions.');
        }
        return steps;
    }
    // new-window (degraded; existing mode only)
    return [
        result.degradation ??
            'Opened a new window in the existing session; CDP tools are unavailable this run.',
        'pwa-debug tools (session_ping, console_tail, react_tree, …) work now. For CDP tools, fully quit the browser and re-run pdl_launch_browser, or use mode sandbox-persistent.',
    ];
};
/**
 * Flatpak-only onboarding guidance. A flatpak-sandboxed Chromium needs three
 * user actions the host cannot perform programmatically: (1) Developer Mode ON
 * at chrome://extensions, or the --load-extension unpacked extension is disabled
 * on each start; (2) the extension's debug toggle, since its native-messaging
 * connection is user-initiated (the MV3 SW only opens the host port on demand);
 * (3) the host filesystem override so the sandboxed NMH can reach the launcher +
 * IPC socket. Surfaced as a next_step so the AI relays it verbatim — without it
 * pwa-debug tools silently report "no connection" on flatpak.
 */
const flatpakLaunchGuidance = (browser, appId) => `${browser} is a flatpak app (${appId}). For the pwa-debug extension to load AND connect, the user must: (1) open chrome://extensions and turn ON Developer Mode (top-right) — a flatpak Chromium disables --load-extension unpacked extensions without it; (2) enable the pwa-debug extension's debug toggle — its native connection is user-initiated, so host_status/session_ping show "no connection" until then; (3) ensure \`flatpak override --user --filesystem=host ${appId}\` has been applied so the sandboxed native host can reach the launcher and IPC socket. Relay these three steps to the user.`;
/**
 * Manual-provisioning guidance for branded Google Chrome 142+, where
 * --load-extension is permanently removed (no flag/policy loads an UNPACKED
 * extension). The browser is up with a live debug port, but the pwa-debug
 * extension must be loaded by hand once. Surfaced as a next_step so the AI walks
 * the user through it; the dir is the resolved unpacked extension path. The
 * per-profile NMH manifest is already written, so the extension connects to the
 * host the instant it loads — no further host step.
 */
const manualLoadUnpackGuidance = (browser, extensionPath) => `${browser} is branded Google Chrome 142+ — it permanently ignores --load-extension, and enterprise policy can't force-install an unpacked extension, so the pwa-debug extension was NOT auto-loaded (chrome-devtools-mcp still works via the live debug port). Walk the user through a one-time manual load: (1) open chrome://extensions in the launched window; (2) toggle ON "Developer mode" (top-right); (3) click "Load unpacked" and select \`${extensionPath}\`. It persists in this dedicated profile across restarts, and connects to the host immediately (the native-messaging manifest is already in place). Alternatively, re-run pdl_launch_browser with browser=brave (or chromium), where --load-extension still works and the extension preloads automatically.`;
/** Tell the AI/user the chosen browser is also installed under other packagings,
 *  so they can re-target — e.g. snap was launched but flatpak is available too. */
const packagingChoiceHint = (target, alternatives) => `${target.browser} is also installed as: ${alternatives.join(', ')}. Launched the '${target.packaging}' packaging (default preference native > snap > flatpak). To target a different one, re-run pdl_launch_browser with packaging='${alternatives[0]}'.`;
/**
 * okResponse + selection-aware next_steps: a flatpak onboarding step when the
 * target is a flatpak app, and a packaging-choice step when the chosen browser
 * is also installed under other packagings (and none was explicitly requested).
 */
const launchOk = (result, target, alternatives, packagingRequested, manualGuided) => {
    const steps = nextStepsFor(result);
    // Manual provisioning takes priority in the guidance order — it's the reason
    // pwa-debug won't connect yet, so the AI should relay it first.
    if (manualGuided) {
        steps.push(manualLoadUnpackGuidance(target.browser, manualGuided.extensionPath));
    }
    if (target.source === 'flatpak' && target.appId) {
        steps.push(flatpakLaunchGuidance(target.browser, target.appId));
    }
    if (!packagingRequested && alternatives.length > 0) {
        steps.push(packagingChoiceHint(target, alternatives));
    }
    return okResponse(result, steps);
};
/**
 * Pure-at-edges orchestration core: resolve the target browser (requested or
 * system default), then dispatch on mode — 'existing' attaches/launches the
 * user's profile (graceful triad); sandbox modes spawn a dedicated profile
 * with the extension preloaded. Effects arrive via deps.
 */
const launchBrowserCore = async (args, platform, env, deps) => {
    const port = args.port ?? deps.defaultPort();
    const mode = args.mode ?? 'existing';
    let discovery;
    try {
        discovery = await deps.discover(platform, env);
    }
    catch (err) {
        return errorResponse(`browser discovery failed: ${err.message}`, [
            'Linux is the first-class target; macOS/Windows are deferred.',
        ]);
    }
    const { target, alternatives } = resolveTarget(discovery, args.browser, args.packaging);
    if (!target) {
        const detected = discovery.browsers
            .map((b) => `${b.browser}[${b.packaging}]`)
            .join(', ') || 'none';
        const msg = args.packaging
            ? `No '${args.browser ?? 'default'}' browser with packaging '${args.packaging}' found. Detected: ${detected}.`
            : args.browser
                ? `Requested browser '${args.browser}' is not installed. Detected: ${detected}.`
                : `No Chromium-family browser detected to launch. Detected: ${detected}.`;
        return errorResponse(msg, [
            'Install a supported browser, or pass an explicit `browser` (and optional `packaging`: native|snap|flatpak) from the detected list.',
        ]);
    }
    if (isSandboxMode(mode)) {
        const userDataDir = deps.resolveSandboxProfileDir(target.browser, mode, target.packaging, env);
        if (!userDataDir) {
            return errorResponse(`Could not resolve a ${mode} profile dir for ${target.browser} on ${platform}.`, ['Linux is first-class; macOS/Windows sandbox profiles are deferred.']);
        }
        const extensionPath = deps.resolveExtensionPath(env);
        if (!extensionPath) {
            return errorResponse('Could not locate the pwa-debug extension to preload (no manifest.json found in any candidate path).', [
                'Build the extension (`pnpm --filter @pwa-debug/extension build`) or set PWA_DEBUG_EXTENSION_PATH to its unpacked dir. pdl_install_extension (M17) will bundle this automatically.',
            ]);
        }
        const snapPkg = target.packaging === 'snap'
            ? snapPackageForBrowser(target.browser)
            : null;
        // Resolve the extension-load strategy from the target's brand+version.
        // Branded Google Chrome >=142 can't preload via --load-extension, so the
        // launch comes up without the extension and steers to a manual Load-unpack.
        const loadStrategy = extensionLoadStrategy(await deps.readVersion(target));
        const result = await deps.launchSandbox({
            browser: target.browser,
            execPath: target.execPath,
            port,
            userDataDir,
            extensionPath,
            loadStrategy,
            mode,
            refreshExtension: refreshExtensionEnabled(mode, env),
            ...(args.isolateExtensions !== undefined
                ? { isolateExtensions: args.isolateExtensions }
                : {}),
            ...(target.appId !== undefined ? { appId: target.appId } : {}),
            ...(snapPkg ? { snapPackage: snapPkg } : {}),
        });
        deps.recordLaunch(result, port);
        return launchOk(result, target, alternatives, args.packaging !== undefined, loadStrategy === 'manual-guided' ? { extensionPath } : undefined);
    }
    // mode === 'existing'
    const userDataDir = deps.resolveUserDataDir(target.browser, platform, env, target.execPath);
    if (!userDataDir) {
        return errorResponse(`Could not resolve the default user-data-dir for ${target.browser} on ${platform}.`, [
            'Linux native, snap, and flatpak profiles are handled; macOS/Windows live verification is pending. Use sandbox-persistent mode as a workaround.',
        ]);
    }
    // Chromium 136+ won't open a debug port on the default profile (existing mode
    // uses it), so a spawn-fresh would report a port that never listens. Resolve
    // the version and let launch_existing degrade honestly when so.
    const portBlocked = debugPortBlockedOnDefaultProfile(await deps.readVersion(target));
    const result = await deps.launch({
        browser: target.browser,
        execPath: target.execPath,
        port,
        userDataDir,
        debugPortBlockedOnDefaultProfile: portBlocked,
        ...(target.appId !== undefined ? { appId: target.appId } : {}),
    });
    deps.recordLaunch(result, port);
    return launchOk(result, target, alternatives, args.packaging !== undefined);
};
const launchBrowserHandler = async (args, ctx) => launchBrowserCore(args, process.platform, process.env, {
    discover: (platform, env) => discoverBrowsers(platform, env, defaultDiscoveryDeps()),
    resolveUserDataDir: defaultUserDataDir,
    defaultPort: () => ctx.settingsStore.getSetting('launch.defaultPort'),
    launch: (input) => launchExisting(input, defaultLaunchDeps()),
    resolveSandboxProfileDir,
    resolveExtensionPath,
    readVersion: readTargetBrowserVersion,
    launchSandbox: (input) => launchSandbox(input, defaultSandboxDeps()),
    recordLaunch: (result, port) => getLaunchRegistry().record({
        browser: result.browser,
        profileType: result.profileType,
        port,
        pid: result.pid,
        browserUrl: result.browserUrl,
        ...(result.userDataDir !== undefined
            ? { userDataDir: result.userDataDir }
            : {}),
    }),
});
const launchBrowserTool = Object.freeze({
    name: 'pdl_launch_browser',
    description: "Launch or attach to a Chromium-family browser with a live remote-debugging port, for use alongside chrome-devtools-mcp. Modes: mode='existing' (default) targets the user's normal profile and degrades gracefully — (a) port already live → attach; (b) running without a debug port → opens a NEW WINDOW in the existing session (never kills it), attached:false + degradation message; (c) not running → spawns fresh with --remote-debugging-port + --user-data-dir=<your profile>. mode='sandbox-persistent' spawns a dedicated, persistent dev profile at ~/.pwa-debug/profiles/<browser>/ beside your normal browser, with the pwa-debug extension PRELOADED (no reload needed); mode='sandbox-temp' is the same but in a throwaway mkdtemp profile cleaned up on host shutdown. Sandbox modes always work standalone (separate profile → no lock collision) and both pwa-debug + CDP tools are available. Args: browser? (chrome|chromium|edge|brave|vivaldi|opera; defaults to system-default), port? (default 9222), mode?, packaging? (native|snap|flatpak). When the same browser is installed under multiple packagings (e.g. snap AND flatpak chromium), pass packaging to pick one; without it the default preference is native > snap > flatpak and next_steps lists the alternatives so you can re-target. isolateExtensions? (sandbox modes only, default true): true pins the dedicated profile to ONLY the pwa-debug extension (clean room — every other extension is disabled); pass false to let other extensions coexist (pwa-debug still preloads, while extensions already in the persistent profile or Load-unpacked/installed after launch stay enabled) — use this to debug a PWA alongside other extensions or to test your own extension with pwa-debug. existing mode already keeps all your normal-profile extensions. Linux is first-class; macOS/Windows deferred. Follow next_steps[] — it carries the chrome-devtools-mcp registration snippet, the profile location, the flatpak onboarding steps, or the degradation guidance.",
    inputSchema: inputSchema$5,
    handler: launchBrowserHandler,
});

const inputSchema$4 = {};
const browserStatusCore = async (deps) => {
    const launches = deps.listLaunches();
    // Re-probe each distinct launch port once for current liveness.
    const ports = [...new Set(launches.map((l) => l.port))];
    const liveness = new Map();
    await Promise.all(ports.map(async (p) => {
        liveness.set(p, await deps.probePort(p));
    }));
    const managedLaunches = launches.map((l) => Object.freeze({ ...l, debugPortLive: liveness.get(l.port) ?? false }));
    const now = deps.now();
    const activeExtensions = deps.listConnections().map((c) => Object.freeze({ ...c, heartbeatAgeMs: now - c.lastSeenAt }));
    const next_steps = [];
    if (managedLaunches.length === 0) {
        next_steps.push('No browsers launched this host session. Use pdl_launch_browser to start one.');
    }
    else {
        const dead = managedLaunches.filter((l) => !l.debugPortLive);
        if (dead.length > 0) {
            next_steps.push(`${dead.length} launched browser(s) no longer answer their debug port (closed/crashed): ${dead.map((d) => `${d.browser}:${d.port}`).join(', ')}. Re-run pdl_launch_browser to relaunch.`);
        }
        const live = managedLaunches.filter((l) => l.debugPortLive && l.browserUrl);
        if (live.length > 0) {
            next_steps.push(`Live debug ports: ${live.map((l) => l.browserUrl).join(', ')}. Register chrome-devtools-mcp against one: \`claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest --browserUrl <url>\`.`);
        }
    }
    if (activeExtensions.length === 0) {
        next_steps.push('No pwa-debug extension is connected to the host right now. Sandbox launches preload it (give it a moment); in existing mode, ensure host_register_extension has run and the extension was reloaded.');
    }
    else {
        const freshest = Math.min(...activeExtensions.map((e) => e.heartbeatAgeMs));
        next_steps.push(`${activeExtensions.length} extension(s) connected; newest heartbeat ${freshest}ms ago. Call session_ping for a full page-world round-trip.`);
    }
    return okResponse({ managedLaunches, activeExtensions }, next_steps);
};
const browserStatusHandler = async (_args, ctx) => {
    const probeDebugPort = defaultLaunchDeps().probeDebugPort;
    return browserStatusCore({
        listLaunches: () => getLaunchRegistry().list(),
        probePort: probeDebugPort,
        listConnections: () => ctx.ipcServer.listConnections(),
        now: Date.now,
    });
};
const browserStatusTool = Object.freeze({
    name: 'pdl_browser_status',
    description: 'Live state of the browsers pdl_launch_browser has started or attached to: each managed launch (browser, profile mode, port, pid, browserUrl) with a fresh debug-port liveness re-probe, plus the pwa-debug extension connections (extensionId + lastSeenAt heartbeat age). Cheap, no side effects. Use it to confirm a launch is still alive, find the browserUrl to hand to chrome-devtools-mcp, or see whether the extension SW is connected. Launch records persist across host restarts (launches.json); the liveness re-probe distinguishes still-running browsers from ones that have since closed. Follow next_steps[].',
    inputSchema: inputSchema$4,
    handler: browserStatusHandler,
});

const isSandboxProfile = (r) => r.profileType === 'sandbox-persistent' || r.profileType === 'sandbox-temp';
/**
 * AND-match a record against the selector. `all` short-circuits true; otherwise
 * every provided field must match and at least one field must be provided (so
 * an empty target deliberately matches nothing — closing requires intent).
 */
const matchesTarget = (r, t) => {
    if (t.all)
        return true;
    let provided = false;
    if (t.pid !== undefined) {
        if (r.pid !== t.pid)
            return false;
        provided = true;
    }
    if (t.port !== undefined) {
        if (r.port !== t.port)
            return false;
        provided = true;
    }
    if (t.browser !== undefined) {
        if (r.browser !== t.browser)
            return false;
        provided = true;
    }
    return provided;
};
const planClose = (records, target, session) => {
    const matched = records.filter((r) => matchesTarget(r, target));
    return Object.freeze(matched.map((record) => {
        // Attached (not spawned by us) → never kill someone else's browser.
        if (record.pid === null) {
            return Object.freeze({
                record,
                action: 'detach',
                discardProfile: false,
                ...(session === 'detach'
                    ? {}
                    : {
                        note: 'attached launch (not spawned by pwa-debug) — detached from the registry without terminating the browser.',
                    }),
            });
        }
        if (session === 'detach') {
            return Object.freeze({
                record,
                action: 'detach',
                discardProfile: false,
            });
        }
        const wantsDiscard = session === 'discard';
        const canDiscard = wantsDiscard && isSandboxProfile(record);
        return Object.freeze({
            record,
            action: 'terminate',
            discardProfile: canDiscard,
            ...(wantsDiscard && !canDiscard
                ? {
                    note: "session 'discard' ignored for an 'existing'-profile launch — terminated the process but kept the user's profile dir.",
                }
                : {}),
        });
    }));
};

const BROWSERS = [
    'chrome',
    'chromium',
    'edge',
    'brave',
    'vivaldi',
    'opera',
];
const SESSIONS = ['persist', 'discard', 'detach'];
const inputSchema$3 = {
    browser: enumType(BROWSERS).optional(),
    port: numberType().int().min(1).max(65535).optional(),
    pid: numberType().int().positive().optional(),
    all: booleanType().optional(),
    session: enumType(SESSIONS).optional(),
};
/**
 * Close managed browser launch(es): resolve the plan (which encodes the safety
 * rules — never kill an attached/unmanaged browser, never delete a user
 * profile), then for each: detach drops the registry record; terminate stops
 * the process we spawned, optionally discards the sandbox profile, and drops
 * the record once the port is confirmed down. Effects arrive via deps.
 */
const closeBrowserCore = async (args, deps) => {
    const session = args.session ?? 'persist';
    const target = {
        ...(args.browser !== undefined ? { browser: args.browser } : {}),
        ...(args.port !== undefined ? { port: args.port } : {}),
        ...(args.pid !== undefined ? { pid: args.pid } : {}),
        ...(args.all !== undefined ? { all: args.all } : {}),
    };
    const plan = planClose(deps.listLaunches(), target, session);
    if (plan.length === 0) {
        return errorResponse('No managed launch matched. pdl_close_browser only acts on browsers pwa-debug launched (see pdl_browser_status) — it never touches your own browser. Pass browser, port, or pid to target one, or all:true to close every managed launch.', [
            'Call pdl_browser_status to see the managed launches and their ports.',
        ]);
    }
    const closed = [];
    for (const p of plan) {
        const base = {
            browser: p.record.browser,
            port: p.record.port,
            pid: p.record.pid,
            profileType: p.record.profileType,
        };
        if (p.action === 'detach') {
            deps.removeFromRegistry(p.record.port);
            closed.push(Object.freeze({
                ...base,
                action: 'detached',
                closed: false,
                ...(p.note !== undefined ? { note: p.note } : {}),
            }));
            continue;
        }
        const outcome = await deps.terminate(p.record);
        let profileDiscarded;
        if (outcome.closed && p.discardProfile && p.record.userDataDir) {
            profileDiscarded = await deps.discardProfile(p.record.userDataDir);
        }
        if (outcome.closed)
            deps.removeFromRegistry(p.record.port);
        closed.push(Object.freeze({
            ...base,
            action: 'terminated',
            closed: outcome.closed,
            method: outcome.method,
            ...(profileDiscarded !== undefined ? { profileDiscarded } : {}),
            ...(p.note !== undefined ? { note: p.note } : {}),
        }));
    }
    const next_steps = [];
    const failed = closed.filter((c) => c.action === 'terminated' && !c.closed);
    if (failed.length > 0) {
        next_steps.push(`Could not confirm shutdown for ${failed.map((f) => `${f.browser}:${f.port}`).join(', ')} (debug port still answering). The browser may be mid-shutdown — re-check with pdl_browser_status.`);
    }
    const notDiscarded = closed.filter((c) => c.profileDiscarded === false);
    if (notDiscarded.length > 0) {
        next_steps.push(`Profile dir could not be fully removed for ${notDiscarded.map((c) => `${c.browser}:${c.port}`).join(', ')} (browser may still be flushing it to disk). Re-check the dir; it can be deleted manually if it persists.`);
    }
    const detached = closed.filter((c) => c.action === 'detached');
    if (detached.length > 0) {
        next_steps.push(`Detached ${detached.length} launch(es) from the registry without terminating (attached/unmanaged or session:'detach'). The browser(s) keep running.`);
    }
    if (next_steps.length === 0) {
        next_steps.push('Managed launch(es) closed and removed from the registry. pdl_browser_status will no longer list them; pdl_launch_browser can start a fresh one.');
    }
    return okResponse({ closed }, next_steps);
};
const closeBrowserHandler = async (args, _ctx) => closeBrowserCore(args, {
    listLaunches: () => getLaunchRegistry().list(),
    terminate: terminateManagedBrowserImpl,
    discardProfile: discardProfileDirImpl,
    removeFromRegistry: (port) => getLaunchRegistry().remove(port),
});
const closeBrowserTool = Object.freeze({
    name: 'pdl_close_browser',
    description: "Cleanly close a browser that pdl_launch_browser started — the symmetric counterpart to launch. Operates STRICTLY off the managed-launch registry, so it can NEVER touch your own/normal browser: a launch we only ATTACHED to (didn't spawn) is detached from the registry, never killed. Shutdown prefers a clean CDP Browser.close (no 'restore tabs' crash prompt), falling back to SIGTERM then SIGKILL of the spawned process. Args: target by browser, port, or pid (or all:true for every managed launch); session? = 'persist' (default — keep the profile dir), 'discard' (also delete the sandbox profile dir; ignored for the user's 'existing' profile), or 'detach' (drop the registry record, leave the browser running). With no target it does nothing (returns an error) — closing requires intent. Follow next_steps[].",
    inputSchema: inputSchema$3,
    handler: closeBrowserHandler,
});

/**
 * Chrome derives an unpacked/keyed extension's ID from its public key: take the
 * SHA-256 of the DER-encoded SPKI public key, keep the first 16 bytes, and map
 * each hex nibble 0-f onto a-p ("mpdecimal"). When a manifest pins a `key`
 * (base64 SPKI), the ID is therefore deterministic across machines and load
 * paths — which is exactly why we pin one. This module owns that derivation so
 * the host can compute the bundled extension's expected ID and compare it to
 * what is actually registered/loaded.
 */
const HEX_TO_MPDECIMAL = 'abcdefghijklmnop';
/**
 * Pure: derive the Chrome extension ID from a manifest `key` (base64 SPKI DER).
 * Returns the 32-char a-p id. Does not validate that the input is a real key —
 * any base64 produces a deterministic id (Chrome behaves the same way).
 */
const deriveExtensionIdFromKey = (keyB64) => {
    const der = Buffer.from(keyB64, 'base64');
    const digest = createHash('sha256').update(der).digest();
    let id = '';
    for (let i = 0; i < 16; i += 1) {
        const byte = digest[i] ?? 0;
        id += HEX_TO_MPDECIMAL[(byte >> 4) & 0xf];
        id += HEX_TO_MPDECIMAL[byte & 0xf];
    }
    return id;
};
/**
 * Read a bundled extension's manifest.json and derive the ID its pinned `key`
 * resolves to. Returns null when the manifest is missing/unreadable, not valid
 * JSON, or carries no string `key` (an unkeyed manifest has a path-derived ID
 * the host cannot predict). readFile is injected so the derivation is testable
 * without touching the filesystem.
 */
const deriveBundledExtensionId = async (manifestPath, readFile) => {
    let raw;
    try {
        raw = await readFile(manifestPath);
    }
    catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    const key = typeof parsed === 'object' && parsed !== null && 'key' in parsed
        ? parsed.key
        : undefined;
    if (typeof key !== 'string' || key.length === 0)
        return null;
    return deriveExtensionIdFromKey(key);
};

/**
 * Pure helpers shared by the chrome-devtools-mcp coexistence tools
 * (pdl_check_setup + pdl_register_chrome_devtools): build the port-correct
 * `claude mcp add` snippet, parse a browserUrl's port, and decide which debug
 * port chrome-devtools should attach to. No effects.
 */
/** The `claude mcp add` line for chrome-devtools-mcp, pinned to a debug-port URL. */
const cdpAddSnippet = (browserUrl) => `claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest --browserUrl ${browserUrl}`;
/** Port component of a CDP browserUrl (null when absent or unparseable). */
const cdpPortOf = (url) => {
    if (!url)
        return null;
    try {
        const p = new URL(url).port;
        return p ? Number(p) : null;
    }
    catch {
        return null;
    }
};
/**
 * Where chrome-devtools-mcp should attach: the active managed launch port if a
 * managed browser is live, otherwise the configured launch.defaultPort.
 */
const expectedCdpPort = (managedPorts, defaultPort) => managedPorts[0]?.port ?? defaultPort;

const inputSchema$2 = {};
const HOST_NAME = 'com.pwa_debug.host';
const checkSetupCore = async (deps) => {
    // Where chrome-devtools-mcp should attach: the active managed launch port if
    // one is live, otherwise the configured launch.defaultPort.
    const managedPorts = deps.listManagedPorts();
    const expectedPort = expectedCdpPort(managedPorts, deps.defaultPort());
    const expectedBrowserUrl = browserUrlFor(expectedPort);
    const cdpSnippet = cdpAddSnippet(expectedBrowserUrl);
    const cdpReg = await deps.readCdpRegistration();
    const installs = await deps.detectInstalls();
    const verifiable = installs.filter((i) => i.kind !== 'registry');
    const manifestChecks = await Promise.all(verifiable.map(async (i) => ({
        browser: i.browser,
        ok: await deps.manifestExists(join(i.manifestDir, `${HOST_NAME}.json`)),
    })));
    const anyManifest = manifestChecks.some((c) => c.ok);
    const extensionDist = deps.resolveExtensionPath();
    const state = await deps.loadState();
    const connections = deps.listConnections();
    const gaps = [];
    const recommendations = [];
    // chrome-devtools-mcp is a SEPARATE, OPTIONAL MCP the user registers with
    // Claude Code. Three states: not registered, registered but pointed at the
    // wrong debug port, or registered correctly. A registration change only takes
    // effect after a full Claude Code restart (MCP servers load at startup).
    const cdpRegPort = cdpPortOf(cdpReg.browserUrl);
    if (!cdpReg.registered) {
        gaps.push('chrome-devtools-mcp is not registered with Claude Code.');
        recommendations.push(`Register chrome-devtools-mcp (separate, optional MCP — runs via npx, no global install): \`${cdpSnippet}\`. A full Claude Code restart is required afterward for its tools to load.`);
    }
    else if (cdpReg.browserUrl === null) {
        // Registered but UNPINNED (no --browserUrl): chrome-devtools-mcp spawns its
        // OWN isolated browser instead of attaching to pwa-debug's debug port, so
        // the two tools never share a browser (FINDING #4).
        gaps.push('chrome-devtools-mcp is registered WITHOUT a --browserUrl, so it launches its own isolated browser instead of attaching to the pwa-debug debug port; the two tools never share a browser.');
        recommendations.push(`Pin chrome-devtools-mcp to the active debug port: \`claude mcp remove chrome-devtools\` then \`${cdpSnippet}\`, and restart Claude Code (or reconnect it) so it attaches to the pwa-debug browser.`);
    }
    else if (cdpReg.browserUrl !== null && cdpRegPort !== expectedPort) {
        gaps.push(`chrome-devtools-mcp is registered but its --browserUrl (${cdpReg.browserUrl}) does not match the active debug port (${expectedBrowserUrl}); it will attach to the wrong browser or none.`);
        recommendations.push(`Re-point chrome-devtools-mcp at the active port: \`claude mcp remove chrome-devtools\` then \`${cdpSnippet}\`, and restart Claude Code.`);
    }
    if (installs.length === 0) {
        gaps.push('No Chromium-family browser install detected for the native messaging host.');
        recommendations.push('Install Chrome, Brave, Chromium, or Edge, then run the host install.');
    }
    else if (!anyManifest) {
        gaps.push('The native messaging host manifest is not installed for any detected browser.');
        recommendations.push('Run `pwa-debug install` (or call host_register_extension with your extension ID) to write the per-browser manifest, then reload the extension at chrome://extensions.');
    }
    // Per-active-sandbox-profile manifest (FINDING #3). A sandbox launch uses a
    // custom --user-data-dir, and Chromium searches <user-data-dir>/
    // NativeMessagingHosts/ there — NOT the install location — for the host
    // manifest. The launcher now auto-writes it, but verify each LIVE sandbox
    // profile so a pre-fix profile (or a manual custom-dir launch) that lacks it
    // is surfaced rather than silently failing connectNative.
    const sandboxProfiles = managedPorts.filter((m) => m.sandbox && typeof m.userDataDir === 'string' && m.userDataDir.length > 0);
    const sandboxManifestChecks = await Promise.all(sandboxProfiles.map(async (m) => ({
        userDataDir: m.userDataDir,
        port: m.port,
        ok: await deps.manifestExists(join(m.userDataDir, 'NativeMessagingHosts', `${HOST_NAME}.json`)),
    })));
    const missingProfileManifests = sandboxManifestChecks.filter((c) => !c.ok);
    if (missingProfileManifests.length > 0) {
        const where = missingProfileManifests
            .map((c) => `${c.userDataDir} (port ${c.port})`)
            .join(', ');
        gaps.push(`Active sandbox profile(s) lack the native messaging host manifest under <user-data-dir>/NativeMessagingHosts/: ${where}. Chrome cannot find the host there, so the extension loads but its connectNative is rejected.`);
        recommendations.push('Re-launch the sandbox with pdl_launch_browser (it now auto-writes the per-profile manifest before spawn); ensure an extension id is registered first (host_register_extension), since the writer no-ops with no registered id.');
    }
    if (!extensionDist) {
        gaps.push('The bundled pwa-debug extension dist was not found.');
        recommendations.push('Build it (`pnpm --filter @pwa-debug/extension build`) or set PWA_DEBUG_EXTENSION_PATH. Call pdl_install_extension to copy it for unpacked install — or use pdl_launch_browser sandbox-persistent, which preloads it.');
    }
    if (state.extensionIds.length === 0) {
        gaps.push('No extension ID is registered with the host.');
        recommendations.push('Read the pwa-debug service-worker console for `[pwa-debug/sw] id=<id>` and call host_register_extension with that ID.');
    }
    // Extension-id / allow-list consistency. A loaded extension whose id is not
    // in allowed_origins loads fine but Chrome rejects its connectNative — the
    // extension appears installed yet never connects. Catch it two ways.
    const registered = state.extensionIds;
    const bundledId = await deps.deriveBundledExtensionId();
    // Live: which ids are actually loaded in managed browsers, and where. In a
    // sandbox profile only our preloaded extension is present, so any unregistered
    // loaded id is a real problem; an existing profile also carries the user's own
    // extensions, so there we only flag the one matching our bundle.
    const probed = await Promise.all(managedPorts.map(async (m) => ({
        port: m.port,
        sandbox: m.sandbox,
        ids: await deps.fetchLoadedExtensionIds(m.port),
    })));
    const loadedExtensionIds = [...new Set(probed.flatMap((p) => p.ids))];
    const mismatches = probed.flatMap((p) => p.ids
        .filter((id) => !registered.includes(id))
        .filter((id) => p.sandbox || id === bundledId)
        .map((id) => ({ port: p.port, id })));
    const firstMismatch = mismatches[0];
    if (firstMismatch) {
        const where = mismatches.map((m) => `${m.id} (port ${m.port})`).join(', ');
        gaps.push(`Extension(s) loaded in a managed browser are not whitelisted in the host's allowed_origins: ${where}. Chrome rejects their native-messaging connection, so they load but never connect.`);
        const fixId = bundledId !== null && mismatches.some((m) => m.id === bundledId)
            ? bundledId
            : firstMismatch.id;
        recommendations.push(`Run host_register_extension ${fixId} (and host_unregister_extension on any stale id) so allowed_origins matches the loaded extension, then reload it at chrome://extensions.`);
    }
    else if (bundledId !== null &&
        registered.length > 0 &&
        !registered.includes(bundledId)) {
        // Static fallback: no managed browser was live to probe, but the bundled
        // extension's pinned id simply is not registered — it will fail to connect
        // the moment it loads.
        gaps.push(`The bundled extension's id (${bundledId}) is not registered with the host (registered: ${registered.join(', ')}). When it loads, Chrome will reject its native-messaging connection.`);
        recommendations.push(`Run host_register_extension ${bundledId} (and host_unregister_extension on the stale id) before launching.`);
    }
    const ok = gaps.length === 0;
    const data = {
        ok,
        gaps,
        recommendations,
        detail: {
            chromeDevtoolsMcp: {
                registered: cdpReg.registered,
                browserUrl: cdpReg.browserUrl,
                expectedBrowserUrl,
            },
            browserInstalls: installs.map((i) => i.browser),
            manifestInstalled: anyManifest,
            sandboxProfileManifests: sandboxManifestChecks,
            extensionDist,
            registeredExtensionIds: state.extensionIds.length,
            activeConnections: connections.length,
            bundledExtensionId: bundledId,
            loadedExtensionIds,
        },
    };
    const next_steps = ok
        ? [
            'Setup looks complete. Launch a browser with pdl_launch_browser, then call session_ping to confirm the page-world round-trip.',
        ]
        : recommendations;
    return okResponse(data, next_steps);
};
const fileExists = async (p) => {
    try {
        await stat(p);
        return true;
    }
    catch {
        return false;
    }
};
const checkSetupHandler = async (_args, ctx) => checkSetupCore({
    readCdpRegistration: readChromeDevtoolsRegistration,
    defaultPort: () => ctx.settingsStore.getSetting('launch.defaultPort'),
    detectInstalls: () => detectBrowserInstalls(process.env, process.platform, fileExists),
    manifestExists: fileExists,
    resolveExtensionPath: () => resolveExtensionPath(process.env),
    loadState: async () => {
        const state = await loadHostState(defaultStatePath());
        return { extensionIds: state.extensionIds };
    },
    listConnections: () => ctx.ipcServer.listConnections(),
    deriveBundledExtensionId: async () => {
        const dir = resolveExtensionPath(process.env);
        if (!dir)
            return null;
        return deriveBundledExtensionId(join(dir, 'manifest.json'), (p) => readFile(p, 'utf8'));
    },
    listManagedPorts: () => getLaunchRegistry()
        .list()
        .map((l) => ({
        port: l.port,
        sandbox: l.profileType === 'sandbox-persistent' ||
            l.profileType === 'sandbox-temp',
        ...(l.userDataDir ? { userDataDir: l.userDataDir } : {}),
    })),
    fetchLoadedExtensionIds,
});
const checkSetupTool = Object.freeze({
    name: 'pdl_check_setup',
    description: 'Diagnose pwa-debug + chrome-devtools-mcp setup and return { ok, gaps[], recommendations[], detail }. Checks: chrome-devtools-mcp registration (read from the `claude` CLI via `claude mcp get`) AND that its configured --browserUrl matches the active managed debug port (or launch.defaultPort) — flagging both not-registered and registered-at-the-wrong-port; native-messaging host manifest installed for a detected browser, the per-profile manifest present under each ACTIVE sandbox launch\'s <user-data-dir>/NativeMessagingHosts/ (a custom --user-data-dir searches there, not the install location), bundled extension dist present, an extension ID registered, live NMH connections, AND extension-id / allow-list consistency — it derives the bundled extension\'s id from its pinned manifest key and probes any managed browser\'s debug port for loaded extension ids, flagging the case where an extension is loaded but its id is not whitelisted in allowed_origins (so it loads yet never connects). ok=true means no gaps. When gaps exist, next_steps carries the exact remediation (the `claude mcp add chrome-devtools …` snippet, the host install/register command, the host_register_extension <id> fix for a mismatch, or a pdl_install_extension pointer). detail also reports bundledExtensionId + loadedExtensionIds. Cheap, no side effects. Run this first on a new machine, then chain pdl_install_extension → pdl_launch_browser.',
    inputSchema: inputSchema$2,
    handler: checkSetupHandler,
});

const inputSchema$1 = {
    target: stringType().min(1).optional(),
};
const installExtensionCore = async (args, deps) => {
    const source = deps.resolveSource();
    if (!source) {
        return errorResponse('The bundled pwa-debug extension was not found to install.', [
            'Build it first: `pnpm --filter @pwa-debug/extension build`, or set PWA_DEBUG_EXTENSION_PATH to an unpacked extension dir. (By design pwa-debug ships only with the MCP — there is no Chrome Web Store build; install is always a manual dev-mode "Load unpacked".)',
        ]);
    }
    const dest = args.target ?? deps.defaultTarget();
    try {
        await deps.copyDir(source, dest);
    }
    catch (err) {
        return errorResponse(`Failed to copy the extension to ${dest}: ${err.message}`, ['Check write permission for the target directory, or pass a different `target`.']);
    }
    return okResponse({ source, dest }, [
        `Copied the pwa-debug extension to ${dest}.`,
        `Install it unpacked: open chrome://extensions (or brave://extensions), enable "Developer mode", click "Load unpacked", and select ${dest}.`,
        'After loading, read the service-worker console for `[pwa-debug/sw] id=<id>`, call host_register_extension with that ID, then reload the extension.',
        'Prefer zero setup? pdl_launch_browser with mode=sandbox-persistent preloads this extension automatically — no manual unpacked install needed.',
    ]);
};
const installExtensionHandler = async (args, _ctx) => installExtensionCore(args, {
    resolveSource: () => resolveExtensionPath(process.env),
    defaultTarget: () => defaultExtensionTargetDir(process.env),
    copyDir,
});
const installExtensionTool = Object.freeze({
    name: 'pdl_install_extension',
    description: "Copy the bundled pwa-debug extension to a folder for manual unpacked install in a Chromium browser. Args: target? (destination dir; defaults to ~/Downloads/pwa-debug-extension). Returns { source, dest } and step-by-step chrome://extensions Developer-mode 'Load unpacked' instructions in next_steps, plus the host_register_extension follow-up. Errors with build guidance if the bundled extension isn't present. Note: pdl_launch_browser sandbox-persistent/sandbox-temp preload the extension automatically, so this tool is only needed for installing into the user's normal (existing-mode) profile.",
    inputSchema: inputSchema$1,
    handler: installExtensionHandler,
});

const inputSchema = {
    port: numberType().int().positive().optional(),
};
/**
 * Steps the user/agent follows AFTER the direct-MCP registration is written:
 * a full Claude Code restart is required (a mid-session add does not load, and
 * /mcp cannot load a newly-added server), then verify + rehydrate context, plus
 * the lower-friction plugin alternative that needs no restart.
 */
const postRegisterSteps = (browserUrl) => [
    `This is a DIRECT MCP registration, so a full Claude Code restart is required for chrome-devtools-mcp's tools to load — a mid-session add does not load, and /mcp cannot load a newly-added server.`,
    `BEFORE the user restarts: hand them a short context-handoff note (what we are working on + the next step) so they can paste it back after the restart and we continue seamlessly. Most users are not on a persistent-memory MCP, so the restart otherwise loses this conversation's context. See the chrome-devtools-coexistence skill.`,
    `After restarting, run /mcp to confirm chrome-devtools connected against ${browserUrl}, then call pdl_check_setup to re-verify.`,
    `Lower-friction alternative (NO restart): install chrome-devtools as a Claude Code PLUGIN instead of a direct MCP, then run /reload-plugins to hot-load it in this same session.`,
];
const registerChromeDevtoolsCore = async (args, deps) => {
    const expectedPort = args.port ?? expectedCdpPort(deps.listManagedPorts(), deps.defaultPort());
    const browserUrl = browserUrlFor(expectedPort);
    const snippet = cdpAddSnippet(browserUrl);
    const reg = await deps.readCdpRegistration();
    const regPort = cdpPortOf(reg.browserUrl);
    // Already registered at the right port — nothing to write.
    if (reg.registered && regPort === expectedPort) {
        return okResponse({ action: 'noop', browserUrl, registration: reg }, [
            `chrome-devtools-mcp is already registered against ${browserUrl}; no change needed.`,
            `If its tools are not visible, a restart (direct MCP) or /reload-plugins (plugin) is still pending — see the chrome-devtools-coexistence skill.`,
        ]);
    }
    // Registered but pointed at the wrong port — remove before re-adding.
    if (reg.registered) {
        const removed = await deps.runMcpRemove();
        if (!removed.ok) {
            return errorResponse(`chrome-devtools-mcp is registered at the wrong port (${reg.browserUrl}) but removing it failed: ${removed.error}`, [
                `Remove it manually: \`claude mcp remove chrome-devtools\`, then re-run this tool or run: \`${snippet}\`.`,
            ]);
        }
    }
    const added = await deps.runMcpAdd(browserUrl);
    if (!added.ok) {
        return errorResponse(`Failed to register chrome-devtools-mcp: ${added.error}`, [
            `Run it manually: \`${snippet}\`.`,
            'Ensure the `claude` CLI is installed and on PATH.',
        ]);
    }
    return okResponse({ action: reg.registered ? 're-registered' : 'registered', browserUrl, command: snippet }, [
        `Registered chrome-devtools-mcp against ${browserUrl} (\`${snippet}\`).`,
        ...postRegisterSteps(browserUrl),
    ]);
};
const registerChromeDevtoolsHandler = async (args, ctx) => registerChromeDevtoolsCore(args, {
    readCdpRegistration: readChromeDevtoolsRegistration,
    runMcpAdd: addChromeDevtoolsRegistration,
    runMcpRemove: removeChromeDevtoolsRegistration,
    defaultPort: () => ctx.settingsStore.getSetting('launch.defaultPort'),
    listManagedPorts: () => getLaunchRegistry()
        .list()
        .map((l) => ({ port: l.port })),
});
const registerChromeDevtoolsTool = Object.freeze({
    name: 'pdl_register_chrome_devtools',
    description: "Register the separate, optional chrome-devtools-mcp server with Claude Code on the user's behalf, pinned to the active debug port. Runs `claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:<port>` via the `claude` CLI. Port resolves to: the `port` arg if given, else the active managed launch port (from pdl_launch_browser), else the host launch.defaultPort. Idempotent: no-op when already registered at the correct port; removes + re-adds when registered at the wrong port. IMPORTANT: this MUTATES the user's global (user-scope) MCP config — ALWAYS ask the user for confirmation before calling it. Because it writes a DIRECT MCP registration, a full Claude Code restart is required afterward for the tools to load (next_steps explains the restart, the context-handoff to hand the user before restarting, and the lower-friction plugin alternative that needs only /reload-plugins). Args: port? (override the debug port).",
    inputSchema,
    handler: registerChromeDevtoolsHandler,
});

const ACTION_IPC_TIMEOUT_MS = 5000;
// Locator + routing fields shared by every action tool.
const locatorSchema = {
    extension_id: stringType().min(1).optional(),
    tab_id: numberType().int().optional(),
    framework: enumType(['react', 'vue', 'svelte', 'solid', 'dom']).optional(),
    selector: stringType().min(1).optional(),
    role: stringType().min(1).optional(),
    name: stringType().min(1).optional(),
    text: stringType().min(1).optional(),
    exact: booleanType().optional(),
    stable_id: stringType().min(1).optional(),
    nth: numberType().int().nonnegative().optional(),
    require_unique: booleanType().optional(),
};
// Locator + routing wire keys forwarded to the page-world; tab_id is forwarded
// so the SW can target a specific tab. Per-tool param keys are appended from the
// spec in makeActionHandler.
const LOCATOR_WIRE_KEYS = [
    'framework', 'selector', 'role', 'name', 'text', 'exact', 'stable_id',
    'nth', 'require_unique', 'tab_id',
];
/** Map a typed param def to its Zod schema (optional unless required). */
const zodForParam = (p) => {
    const base = p.type === 'number'
        ? numberType()
        : p.type === 'boolean'
            ? booleanType()
            : p.type === 'enum'
                ? enumType([...(p.enum ?? [])])
                : stringType();
    return p.required ? base : base.optional();
};
const LOCATOR_DOC = "Locator: pass ONE of { selector } | { role, name? } | { text, exact? } | { framework, stable_id }. " +
    "framework: react|vue|svelte|solid|dom (only meaningful for stable_id; svelte stable_id is a file, not an element — use role/text/selector). " +
    "Disambiguate multiple matches with nth (0-based) or require_unique. Also extension_id?/tab_id?. CALL host_status FIRST.";
/** Build the Zod inputSchema (ZodRawShape) for one action tool from its spec. */
const buildActionInputSchema = (spec) => {
    const shape = { ...locatorSchema };
    for (const p of spec.params)
        shape[p.key] = zodForParam(p);
    return shape;
};
const isToolErrorPayload = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    const e = v['error'];
    return e !== null && typeof e === 'object' && typeof e['message'] === 'string';
};
/** Build the generic MCP handler for one action tool. */
const makeActionHandler = (spec) => async (args, ctx) => {
    const target = resolveTarget$1(ctx, args['extension_id']);
    if (!target.ok) {
        return errorResponse(target.error, [
            'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the extension reloaded.',
        ]);
    }
    const payload = {};
    const wireKeys = [...LOCATOR_WIRE_KEYS, ...spec.params.map((p) => p.key)];
    for (const k of wireKeys)
        if (args[k] !== undefined)
            payload[k] = args[k];
    const env = Object.freeze({
        type: 'request',
        requestId: randomUUID(),
        tool: spec.tool,
        extensionId: target.extensionId,
        payload,
    });
    let response;
    try {
        response = await ctx.ipcServer.request(target.extensionId, env, {
            timeoutMs: ACTION_IPC_TIMEOUT_MS,
        });
    }
    catch (err) {
        return errorResponse(`${spec.tool} failed: ${err.message}`, [
            `IPC request did not complete. Confirm the SW is connected and the ${spec.tool} handler is wired in the SW.`,
        ]);
    }
    if (response.error) {
        return errorResponse(`${spec.tool} nmh error: ${response.error.message}`, [
            'NMH-mode rejected the request (no active tab, page-bridge timeout on a chrome:// page, or the page-world handler threw).',
        ]);
    }
    if (isToolErrorPayload(response.payload)) {
        return errorResponse(`${spec.tool}: ${response.payload.error.message}`, [
            'Locator did not resolve (not found / ambiguous) or a required param was missing. Refine the locator (add nth/require_unique) or check the value/label/key arg.',
        ]);
    }
    const data = { extensionId: target.extensionId, tabId: args['tab_id'] ?? null, ...response.payload };
    const nextSteps = [
        'located: { describedBy, matchCount } — the resolved target. action: an ActionResult { acted, defaultPrevented?, detail? }. If matchCount>1 the first match was used unless nth was given.',
    ];
    const acted = response.payload.action?.acted;
    if (acted === false) {
        nextSteps.push('action.acted=false — the element was found but the action could not be applied (wrong element type for this action). Check the target.');
    }
    return okResponse(data, nextSteps);
};
const interactionActionTools = Object.freeze(ACTION_TOOL_SPECS.map((spec) => {
    const inputSchema = buildActionInputSchema(spec);
    return Object.freeze({
        name: spec.tool,
        description: `${spec.summary} ${LOCATOR_DOC} Runs in page-world via the page-bridge — no CDP, coexists with the user's DevTools.`,
        inputSchema,
        handler: makeActionHandler(spec),
    });
}));

// Each per-tool ToolDef<X> is variant-incompatible with ToolDef<ZodRawShape>
// (handler arg is contravariant). The runtime contract is identical, so we
// cast at this boundary; registerTools only reads the description+inputSchema
// and forwards the parsed args back to the handler unchanged.
const TOOLS = Object.freeze([
    hostStatusTool,
    hostRegisterExtensionTool,
    hostUnregisterExtensionTool,
    hostListRegistrationsTool,
    hostResetTool,
    sessionPingTool,
    recentEventsTool,
    consoleTailTool,
    networkTailTool,
    popupTailTool,
    popupFailuresTool,
    errorTailTool,
    popupRecordTool,
    popupReplayTool,
    evaluateTool,
    settingsListSchemaTool,
    settingsGetTool,
    settingsSetTool,
    reactTreeTool,
    reactGetStateTool,
    reactFindByTextTool,
    reactFindByRoleTool,
    vueTreeTool,
    vueGetStateTool,
    vueFindByTextTool,
    vueFindByRoleTool,
    svelteComponentsTool,
    svelteFindByTextTool,
    svelteFindByRoleTool,
    solidDetectTool,
    solidFindByTextTool,
    solidFindByRoleTool,
    storeGetStateTool,
    storeSubscribeTool,
    storeTailTool,
    storeDispatchTool,
    reduxGetStateTool,
    reduxSubscribeTool,
    reduxTailTool,
    reduxDispatchTool,
    sourceMapResolveTool,
    sessionRecordTool,
    sessionReplayTool,
    swStatusTool,
    swLifecycleTailTool,
    cacheListTool,
    cacheInspectTool,
    cacheMatchTool,
    pwaStatusTool,
    pwaInstallabilityTool,
    pwaUpdateAnalyzeTool,
    pwaSnapshotTool,
    storageGetTool,
    idbListTool,
    idbQueryTool,
    launchBrowserTool,
    browserStatusTool,
    closeBrowserTool,
    checkSetupTool,
    installExtensionTool,
    registerChromeDevtoolsTool,
    ...interactionActionTools,
]);

const DEFAULT_TIMEOUT_MS = 5000;
const snapshotConn = (c) => Object.freeze({
    extensionId: c.extensionId,
    connectedAt: c.connectedAt,
    lastSeenAt: c.lastSeenAt,
});
// Probe whether a unix socket path has a live listener. Resolves 'live' if a
// connection is accepted, 'stale' if the path refuses connection (ECONNREFUSED)
// or is gone (ENOENT) — i.e. an orphaned socket file left behind by a host that
// was hard-killed (SIGKILL / terminal close / crash) before close() could
// unlink it. Used to decide whether an EADDRINUSE bind failure is a genuine
// conflict (another host is up) or a reclaimable stale file.
const probeSocketLiveness = (path) => new Promise((resolve) => {
    const probe = createConnection(path);
    const settle = (result) => {
        probe.destroy();
        resolve(result);
    };
    probe.once('connect', () => settle('live'));
    probe.once('error', () => settle('stale'));
});
const createIpcServer = async (opts) => {
    const connections = new Map();
    const pending = new Map();
    const defaultTimeout = opts.defaultRequestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const rejectPendingFor = (extensionId, reason) => {
        for (const [reqId, p] of pending) {
            if (p.extensionId === extensionId) {
                clearTimeout(p.timeoutHandle);
                pending.delete(reqId);
                p.reject(new Error(reason));
            }
        }
    };
    const handleSocket = (socket) => {
        let registeredId = null;
        const reader = createIpcFrameReader();
        const onData = (chunk) => {
            let envelopes;
            try {
                envelopes = reader.push(chunk);
            }
            catch (err) {
                socket.destroy(err);
                return;
            }
            for (const env of envelopes) {
                if (env.type === 'register') {
                    if (registeredId !== null)
                        continue;
                    const prior = connections.get(env.extensionId);
                    if (prior) {
                        connections.delete(env.extensionId);
                        rejectPendingFor(env.extensionId, `ipc server: connection replaced for ${env.extensionId}`);
                        prior.socket.destroy();
                    }
                    registeredId = env.extensionId;
                    const now = Date.now();
                    const conn = {
                        extensionId: env.extensionId,
                        socket,
                        connectedAt: now,
                        lastSeenAt: now,
                    };
                    connections.set(env.extensionId, conn);
                    opts.onRegister?.(snapshotConn(conn));
                    continue;
                }
                if (registeredId === null) {
                    socket.destroy(new Error('ipc server: client sent envelope before register'));
                    return;
                }
                const conn = connections.get(registeredId);
                if (!conn)
                    continue;
                conn.lastSeenAt = Date.now();
                if (env.type === 'response') {
                    const p = pending.get(env.requestId);
                    if (p && p.extensionId === registeredId) {
                        clearTimeout(p.timeoutHandle);
                        pending.delete(env.requestId);
                        p.resolve(env);
                    }
                }
                else if (env.type === 'request') {
                    opts.onRequest?.(registeredId, env);
                }
                else if (env.type === 'event') {
                    opts.onEvent?.(registeredId, env);
                }
            }
        };
        const onClose = () => {
            if (registeredId === null)
                return;
            const conn = connections.get(registeredId);
            if (conn && conn.socket === socket) {
                connections.delete(registeredId);
                rejectPendingFor(registeredId, `ipc server: connection closed for ${registeredId}`);
                opts.onDisconnect?.(registeredId);
            }
        };
        socket.on('data', onData);
        socket.on('close', onClose);
        socket.on('error', () => {
            // 'close' will follow; intentional no-op to avoid uncaught error events.
        });
    };
    const socketPaths = [opts.socketPath, ...(opts.extraSocketPaths ?? [])];
    const servers = socketPaths.map(() => createServer(handleSocket));
    const listenOne = (server, path) => new Promise((resolve, reject) => {
        const attempt = (recovered) => {
            const onError = (err) => {
                const recoverable = err.code === 'EADDRINUSE' &&
                    !recovered &&
                    process.platform !== 'win32';
                if (!recoverable) {
                    reject(err);
                    return;
                }
                // A prior host may have been hard-killed without unlinking its socket.
                // Probe before clobbering: only reclaim a path nothing is listening on
                // — never unlink out from under a host that is genuinely up.
                void probeSocketLiveness(path).then(async (liveness) => {
                    if (liveness === 'live') {
                        reject(new Error(`ipc server: another pwa-debug host is already listening on ${path}`));
                        return;
                    }
                    try {
                        await unlink(path);
                    }
                    catch {
                        // already gone — fine, just retry the bind
                    }
                    attempt(true);
                });
            };
            server.once('error', onError);
            server.listen(path, () => {
                server.off('error', onError);
                resolve();
            });
        };
        attempt(false);
    });
    await Promise.all(servers.map((s, i) => listenOne(s, socketPaths[i])));
    const sendTo = (extensionId, env) => {
        const conn = connections.get(extensionId);
        if (!conn) {
            return Object.freeze({
                ok: false,
                error: `no connected NMH for ${extensionId}`,
            });
        }
        try {
            conn.socket.write(encodeIpcEnvelope(env));
            return Object.freeze({ ok: true });
        }
        catch (err) {
            return Object.freeze({
                ok: false,
                error: err.message,
            });
        }
    };
    const request = (extensionId, env, o) => {
        const timeoutMs = o?.timeoutMs ?? defaultTimeout;
        return new Promise((resolve, reject) => {
            if (pending.has(env.requestId)) {
                reject(new Error(`ipc server: duplicate requestId ${env.requestId}`));
                return;
            }
            const sendResult = sendTo(extensionId, env);
            if (!sendResult.ok) {
                reject(new Error(sendResult.error));
                return;
            }
            const timeoutHandle = setTimeout(() => {
                pending.delete(env.requestId);
                reject(new Error(`ipc server: request ${env.requestId} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            pending.set(env.requestId, Object.freeze({ extensionId, resolve, reject, timeoutHandle }));
        });
    };
    const listConnections = () => Object.freeze(Array.from(connections.values(), snapshotConn));
    const close = async () => {
        for (const [, p] of pending) {
            clearTimeout(p.timeoutHandle);
            p.reject(new Error('ipc server: closed'));
        }
        pending.clear();
        for (const conn of connections.values()) {
            conn.socket.destroy();
        }
        connections.clear();
        await Promise.all(servers.map((s) => new Promise((resolve, reject) => {
            s.close((err) => (err ? reject(err) : resolve()));
        })));
        if (process.platform !== 'win32') {
            await Promise.all(socketPaths.map(async (p) => {
                try {
                    await unlink(p);
                }
                catch {
                    // socket file may already be gone
                }
            }));
        }
    };
    return Object.freeze({ close, sendTo, request, listConnections });
};

const createRingBuffer = (opts) => {
    if (!Number.isInteger(opts.capacity) || opts.capacity <= 0) {
        throw new Error(`createRingBuffer: capacity must be a positive integer, got ${String(opts.capacity)}`);
    }
    const capacity = opts.capacity;
    const onEvict = opts.onEvict;
    const slots = new Array(capacity);
    let writeIndex = 0;
    let count = 0;
    const push = (item) => {
        if (count < capacity) {
            slots[writeIndex] = item;
            writeIndex = (writeIndex + 1) % capacity;
            count++;
            return;
        }
        const evicted = slots[writeIndex];
        slots[writeIndex] = item;
        writeIndex = (writeIndex + 1) % capacity;
        if (onEvict !== undefined)
            onEvict(evicted);
    };
    const tail = (tailOpts) => {
        const since = tailOpts?.since;
        const limit = tailOpts?.limit;
        const filter = tailOpts?.filter;
        const startIndex = count < capacity ? 0 : writeIndex;
        const matched = [];
        for (let i = 0; i < count; i++) {
            const entry = slots[(startIndex + i) % capacity];
            if (since !== undefined && !(entry.ts > since))
                continue;
            if (filter !== undefined && !filter(entry))
                continue;
            matched.push(entry);
        }
        if (limit !== undefined && matched.length > limit) {
            return matched.slice(matched.length - limit);
        }
        return matched;
    };
    const size = () => count;
    const clear = () => {
        for (let i = 0; i < capacity; i++)
            slots[i] = undefined;
        writeIndex = 0;
        count = 0;
    };
    return Object.freeze({ push, tail, size, clear });
};

const DEFAULT_CAPACITY_PER_KIND = 5000;
const BUFFER_KINDS = [
    'console',
    'network',
    'dom_mutations',
    'lifecycle',
    'store_change',
    'replay',
    'library_popup',
    'page_error',
    'sw_state',
];
const kindToBucket = (kind) => {
    switch (kind) {
        case 'console':
            return 'console';
        case 'fetch':
        case 'xhr':
        case 'websocket':
            return 'network';
        case 'dom_mutation':
            return 'dom_mutations';
        case 'lifecycle':
            return 'lifecycle';
        case 'store_change':
            return 'store_change';
        case 'replay':
            return 'replay';
        case 'library_popup':
            return 'library_popup';
        case 'page_error':
            return 'page_error';
        case 'sw_state':
            return 'sw_state';
        default:
            return undefined;
    }
};
const createCapturesIn = (opts) => {
    const extensionId = opts.extensionId;
    const capacity = opts.capacityPerKind ?? DEFAULT_CAPACITY_PER_KIND;
    const getNow = opts.getNow ?? Date.now;
    const sessionId = opts.sessionId ?? randomUUID();
    const onEvict = opts.onEvict;
    const makeBuffer = (kind) => onEvict
        ? createRingBuffer({
            capacity,
            onEvict: (evicted) => onEvict(kind, evicted),
        })
        : createRingBuffer({ capacity });
    const buffers = {
        console: makeBuffer('console'),
        network: makeBuffer('network'),
        dom_mutations: makeBuffer('dom_mutations'),
        lifecycle: makeBuffer('lifecycle'),
        store_change: makeBuffer('store_change'),
        replay: makeBuffer('replay'),
        library_popup: makeBuffer('library_popup'),
        page_error: makeBuffer('page_error'),
        sw_state: makeBuffer('sw_state'),
    };
    const received = {
        console: 0,
        network: 0,
        dom_mutations: 0,
        lifecycle: 0,
        store_change: 0,
        replay: 0,
        library_popup: 0,
        page_error: 0,
        sw_state: 0,
    };
    const dropped = {
        console: 0,
        network: 0,
        dom_mutations: 0,
        lifecycle: 0,
        store_change: 0,
        replay: 0,
        library_popup: 0,
        page_error: 0,
        sw_state: 0,
    };
    const sequence = {
        console: 0,
        network: 0,
        dom_mutations: 0,
        lifecycle: 0,
        store_change: 0,
        replay: 0,
        library_popup: 0,
        page_error: 0,
        sw_state: 0,
    };
    let droppedUnknown = 0;
    const listeners = new Set();
    const subscribe = (listener) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    };
    const receive = (input) => {
        for (const event of input.events) {
            if (event === null || typeof event !== 'object') {
                droppedUnknown++;
                continue;
            }
            const e = event;
            if (typeof e.kind !== 'string') {
                droppedUnknown++;
                continue;
            }
            const bucket = kindToBucket(e.kind);
            if (bucket === undefined) {
                droppedUnknown++;
                continue;
            }
            if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) {
                dropped[bucket]++;
                continue;
            }
            sequence[bucket]++;
            const stored = {
                ...event,
                receivedAt: getNow(),
                sessionId,
                extensionId,
                sequenceNumber: sequence[bucket],
            };
            buffers[bucket].push(stored);
            received[bucket]++;
            for (const listener of listeners) {
                try {
                    listener(bucket, stored);
                }
                catch {
                    // A faulty subscriber must never break intake.
                }
            }
        }
    };
    const tail = (kind, tailOpts) => buffers[kind].tail(tailOpts);
    const buffer = (kind) => buffers[kind];
    const getStats = () => {
        const perKindEntries = BUFFER_KINDS.map((k) => [
            k,
            Object.freeze({
                received: received[k],
                dropped: dropped[k],
                size: buffers[k].size(),
            }),
        ]);
        const perKind = Object.freeze(Object.fromEntries(perKindEntries));
        let totalReceived = 0;
        let totalDropped = droppedUnknown;
        for (const k of BUFFER_KINDS) {
            totalReceived += received[k];
            totalDropped += dropped[k];
        }
        return Object.freeze({
            perKind,
            droppedUnknown,
            totals: Object.freeze({ received: totalReceived, dropped: totalDropped }),
            sessionId,
            extensionId,
        });
    };
    const clear = () => {
        for (const k of BUFFER_KINDS) {
            buffers[k].clear();
            received[k] = 0;
            dropped[k] = 0;
            sequence[k] = 0;
        }
        droppedUnknown = 0;
    };
    return Object.freeze({ receive, tail, buffer, getStats, clear, subscribe });
};
const CAPTURES_EVENT_TOOL = 'captures';
const createCapturesRegistry = (opts = {}) => {
    const map = new Map();
    const getOrCreate = (extensionId) => {
        const existing = map.get(extensionId);
        if (existing !== undefined)
            return existing;
        const created = createCapturesIn({
            extensionId,
            ...(opts.capacityPerKind !== undefined && { capacityPerKind: opts.capacityPerKind }),
            ...(opts.getNow !== undefined && { getNow: opts.getNow }),
            ...(opts.sessionId !== undefined && { sessionId: opts.sessionId }),
            ...(opts.onEvict !== undefined && { onEvict: opts.onEvict }),
        });
        map.set(extensionId, created);
        return created;
    };
    const get = (extensionId) => map.get(extensionId);
    const list = () => Object.freeze(Array.from(map.entries(), ([extensionId, captures]) => Object.freeze({ extensionId, captures })));
    const clear = () => {
        map.clear();
    };
    return Object.freeze({ getOrCreate, get, list, clear });
};
const isIntakePayload = (v) => {
    if (v === null || typeof v !== 'object')
        return false;
    return Array.isArray(v.events);
};
const dispatchCapturesEvent = (registry, extensionId, env, hooks) => {
    if (env.tool !== CAPTURES_EVENT_TOOL)
        return;
    if (env.extensionId !== undefined && env.extensionId !== extensionId) {
        hooks?.onMismatch?.(`dispatchCapturesEvent: envelope.extensionId=${env.extensionId} does not match connection.extensionId=${extensionId}; dropping`);
        return;
    }
    if (!isIntakePayload(env.payload)) {
        hooks?.onInvalid?.(`dispatchCapturesEvent: invalid intake payload from ${extensionId}; dropping`);
        return;
    }
    registry.getOrCreate(extensionId).receive({ events: env.payload.events });
};

/**
 * Host-side typed settings store.
 *
 * Owns the persisted ~/.config/pwa-debug/settings.json file. Drives every
 * user-tunable behavior via the shared SETTINGS_SCHEMA — no setting key is
 * hardcoded here, so adding a key is one schema entry, zero changes to this
 * file or any other consumer.
 *
 * Layering:
 *   • Pure transforms (parsePersistedSettings, mergeOverDefaults,
 *     diffChangedKeys) exported separately so the extension cache (T3) and
 *     tests can reuse them without instantiating a store.
 *   • createSettingsStore composes those transforms with fs side effects at
 *     the module's edges (host_io.readJsonOr / atomicWriteJson + fs.watch).
 *
 * Subscriber model:
 *   • setSetting → atomic persist → notify subscribers once (one SettingChange).
 *   • External edit → fs.watch fires → debounce → reload+merge → diff → notify
 *     once per changed key. Self-writes are guarded by mtime comparison so the
 *     host doesn't re-notify its own writes.
 */
const DEFAULT_WATCH_DEBOUNCE_MS = 50;
// --- internal equality (arrays compared element-wise; primitives by ===) ---
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const arraysEqual = (a, b) => a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
const objectsEqual = (a, b) => {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length)
        return false;
    for (const k of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, k))
            return false;
        if (!valuesEqual(a[k], b[k]))
            return false;
    }
    return true;
};
const valuesEqual = (a, b) => {
    if (a === b)
        return true;
    if (Array.isArray(a) && Array.isArray(b))
        return arraysEqual(a, b);
    if (isPlainObject(a) && isPlainObject(b))
        return objectsEqual(a, b);
    return false;
};
// --- pure transforms (exported, tracked) ---
const parsePersistedSettings = (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return {};
    const obj = raw;
    const partial = {};
    for (const k of settingKeys()) {
        if (!(k in obj))
            continue;
        const v = obj[k];
        if (validateSettingValue(k, v)) {
            // TS can't narrow a union-indexed assignment past validateSettingValue's
            // per-key guard; the runtime guard above is the actual proof.
            partial[k] = v;
        }
    }
    return partial;
};
const mergeOverDefaults = (persisted) => {
    const out = {
        ...defaultSettings(),
    };
    for (const k of settingKeys()) {
        const p = persisted[k];
        if (p !== undefined && validateSettingValue(k, p)) {
            out[k] = p;
        }
    }
    return out;
};
const diffChangedKeys = (prev, next) => settingKeys().filter((k) => !valuesEqual(prev[k], next[k]));
// --- closure factory (side effects at edges) ---
const makeChange = (key, value) => ({ key, value });
const createSettingsStore = (options = {}) => {
    const env = options.env ?? process.env;
    const path = options.path ?? xdgConfigPath('settings.json', env);
    const debounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    const watchEnabled = options.disableWatch !== true;
    let current = defaultSettings();
    const subscribers = new Set();
    let watcher = null;
    let debounceTimer = null;
    let lastSelfWriteMtimeMs = null;
    let disposed = false;
    const notify = (change) => {
        for (const listener of subscribers) {
            try {
                listener(change);
            }
            catch {
                // listeners must not break the dispatch loop
            }
        }
    };
    const loadFromDisk = async () => {
        const persisted = await readJsonOr(path, {}, parsePersistedSettings);
        return mergeOverDefaults(persisted);
    };
    const reloadAndNotify = async () => {
        if (disposed)
            return;
        // Self-write guard: if file mtime matches the last persist we did, skip.
        try {
            const s = await stat(path);
            if (lastSelfWriteMtimeMs !== null && s.mtimeMs === lastSelfWriteMtimeMs) {
                return;
            }
        }
        catch {
            // missing file -> proceed; loadFromDisk will fall back to defaults
        }
        const next = await loadFromDisk();
        const changedKeys = diffChangedKeys(current, next);
        current = next;
        for (const k of changedKeys) {
            notify(makeChange(k, current[k]));
        }
    };
    const onWatchEvent = () => {
        if (debounceTimer)
            clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void reloadAndNotify();
        }, debounceMs);
    };
    const startWatcher = () => {
        if (!watchEnabled || disposed)
            return;
        try {
            watcher = watch(path, { persistent: false }, onWatchEvent);
        }
        catch {
            // file may not exist yet; first setSetting creates it then re-attaches.
            watcher = null;
        }
    };
    const restartWatcher = () => {
        if (watcher) {
            watcher.close();
            watcher = null;
        }
        startWatcher();
    };
    const init = async () => {
        current = await loadFromDisk();
        startWatcher();
    };
    const getSetting = (key) => current[key];
    const getAll = () => current;
    const setSetting = async (key, value) => {
        if (!validateSettingValue(key, value)) {
            const entry = getSettingEntry(key);
            const enumSuffix = entry.enumValues
                ? ` of ${entry.enumValues.join('|')}`
                : '';
            return {
                ok: false,
                error: `host_settings: value rejected by validator for '${key}' (expected ${entry.type}${enumSuffix})`,
            };
        }
        if (valuesEqual(current[key], value)) {
            // idempotent no-op: no persist, no notify
            return { ok: true };
        }
        const next = { ...current, [key]: value };
        await atomicWriteJson(path, next);
        try {
            const s = await stat(path);
            lastSelfWriteMtimeMs = s.mtimeMs;
        }
        catch {
            lastSelfWriteMtimeMs = null;
        }
        // Atomic rename replaces the inode; re-attach the watcher so external
        // edits to the new file are observed.
        restartWatcher();
        current = next;
        notify(makeChange(key, value));
        return { ok: true };
    };
    const subscribe = (listener) => {
        subscribers.add(listener);
        return () => {
            subscribers.delete(listener);
        };
    };
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        if (watcher) {
            watcher.close();
            watcher = null;
        }
        subscribers.clear();
    };
    return { init, getSetting, getAll, setSetting, subscribe, dispose };
};

const snapshotEvent = (store) => ({
    type: 'event',
    tool: 'settings_snapshot',
    payload: { values: store.getAll() },
});
const changedEvent = (change) => ({
    type: 'event',
    tool: 'settings_changed',
    payload: change,
});
const broadcastChange = (ipcServer, store, change) => {
    const env = changedEvent(change);
    for (const conn of ipcServer.listConnections()) {
        ipcServer.sendTo(conn.extensionId, env);
    }
};
const FALLBACK_VERSION = '0.0.0';
const readHostVersion = async () => {
    const mainJsPath = process.argv[1];
    if (typeof mainJsPath !== 'string' || mainJsPath === '') {
        return FALLBACK_VERSION;
    }
    try {
        const pkgPath = join(dirname(mainJsPath), '..', 'package.json');
        const parsed = JSON.parse(await readFile(pkgPath, 'utf-8'));
        return typeof parsed.version === 'string' ? parsed.version : FALLBACK_VERSION;
    }
    catch {
        return FALLBACK_VERSION;
    }
};
const waitForShutdown = () => new Promise((resolve) => {
    const onceOnly = (reason) => resolve(reason);
    stdin.once('end', () => onceOnly('stdin EOF'));
    process.once('SIGINT', () => onceOnly('SIGINT'));
    process.once('SIGTERM', () => onceOnly('SIGTERM'));
});
const runMcpMode = async () => {
    const socketPath = defaultSocketPath();
    const parentDir = socketParentDir(socketPath);
    if (parentDir !== null) {
        await mkdir(parentDir, { recursive: true });
    }
    // Snap confinement: a snap-spawned relay can only connect() to a socket under
    // ~/snap/<pkg>/common/, so bind one extra socket per installed snap browser
    // (in addition to the canonical socket above). Their parent dirs must exist
    // before listen(). No-op when no snap browser is installed.
    const pathExists = async (p) => {
        try {
            await access(p);
            return true;
        }
        catch {
            return false;
        }
    };
    const snapTargets = await installedSnapSocketTargets(process.env, pathExists);
    const extraSocketPaths = snapTargets.map((t) => t.socketPath);
    for (const p of extraSocketPaths) {
        await mkdir(dirname(p), { recursive: true });
    }
    const hostVersion = await readHostVersion();
    const settingsStore = createSettingsStore();
    await settingsStore.init();
    // Warn about sandbox-temp profile dirs left by a previous crashed run.
    // Graceful shutdown cleans its own, so survivors mean a SIGKILL/crash.
    // Warn-only — mkdtemp names don't identify the owner, so we can't safely
    // auto-remove (a concurrent host may still be using one).
    const lingering = findLingeringTempProfiles();
    if (lingering.length > 0) {
        stderr.write(`[pwa-debug-host mcp] note: ${lingering.length} lingering sandbox-temp profile dir(s) under ${tmpdir()} (e.g. ${lingering[0]}) from a previous run. Cleaned automatically on graceful shutdown; if no other pwa-debug host is running, remove ${join(tmpdir(), 'pwa-debug-*')} to reclaim space.\n`);
    }
    // M8: one host-process session id scopes all archive output for this run.
    // Boot-time prune reaps anything from prior sessions before the writer
    // opens fresh files; the rotation hook fires a fire-and-forget prune so
    // both age + size caps are enforced as new files appear.
    const hostSessionId = randomUUID();
    await pruneArchives({ getSetting: settingsStore.getSetting }).catch((err) => {
        stderr.write(`[pwa-debug-host mcp] boot prune failed: ${String(err)}\n`);
    });
    const archiveWriter = createArchiveWriter({
        sessionId: hostSessionId,
        getSetting: settingsStore.getSetting,
        onRotate: () => {
            void pruneArchives({ getSetting: settingsStore.getSetting }).catch(() => undefined);
        },
    });
    // Share hostSessionId across the registry so cursors the tail tools
    // encode (via the CapturesIn-attached sessionId metadata) match the
    // archive subtree the writer spills into. Without this, console.tail /
    // network.tail cursors would point at a different sessionId than
    // host_archive uses on disk.
    const capturesRegistry = createCapturesRegistry({
        sessionId: hostSessionId,
        onEvict: bridgeWriterToOnEvict(archiveWriter),
    });
    // The ipcServer reference is needed inside its own onRegister callback for
    // the initial snapshot push; bind via a late-initialized holder.
    let ipcServerRef = null;
    const ipcServer = await createIpcServer({
        socketPath,
        extraSocketPaths,
        onRegister: (info) => {
            ipcServerRef?.sendTo(info.extensionId, snapshotEvent(settingsStore));
        },
        onEvent: (extensionId, env) => dispatchCapturesEvent(capturesRegistry, extensionId, env, {
            onMismatch: (msg) => stderr.write(`[pwa-debug-host mcp] ${msg}\n`),
            onInvalid: (msg) => stderr.write(`[pwa-debug-host mcp] ${msg}\n`),
        }),
    });
    ipcServerRef = ipcServer;
    const unsubscribeSettings = settingsStore.subscribe((change) => {
        broadcastChange(ipcServer, settingsStore, change);
    });
    try {
        const server = new McpServer({
            name: 'pwa-debug',
            version: '0.0.0-m4',
        });
        registerTools(server, TOOLS, {
            ipcServer,
            hostVersion,
            capturesRegistry,
            settingsStore,
        });
        const transport = new StdioServerTransport();
        await server.connect(transport);
        stderr.write(`[pwa-debug-host mcp] server up on stdio; ${TOOLS.length} tools registered; ipc socket=${socketPath}${extraSocketPaths.length > 0 ? ` (+${extraSocketPaths.length} snap socket(s): ${extraSocketPaths.join(', ')})` : ''}\n`);
        const reason = await waitForShutdown();
        stderr.write(`[pwa-debug-host mcp] ${reason}; shutting down\n`);
    }
    finally {
        unsubscribeSettings();
        await ipcServer.close();
        settingsStore.dispose();
        stderr.write('[pwa-debug-host mcp] ipc server closed\n');
    }
};

// userArgs are process.argv.slice(2) — i.e. everything after [nodePath, scriptPath].
// Chrome/Brave native-messaging passes the calling extension's origin as the first
// user arg on Linux/macOS; on Windows it appends a `--parent-window=<HWND>` arg.
const detectMode = (userArgs) => {
    const a0 = userArgs[0];
    return typeof a0 === 'string' && a0.startsWith('chrome-extension://') ? 'nmh' : 'mcp';
};
const main = async (userArgs = process.argv.slice(2)) => {
    if (detectMode(userArgs) === 'nmh') {
        await runNmhMode({ origin: userArgs[0] ?? '' });
        return;
    }
    await runMcpMode();
};
const isEntryPoint = () => {
    const entry = process.argv[1];
    if (typeof entry !== 'string' || entry === '')
        return false;
    try {
        return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
    }
    catch {
        return false;
    }
};
if (isEntryPoint()) {
    main().catch((err) => {
        process.stderr.write(`[pwa-debug-host] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        process.exit(1);
    });
}

export { detectMode, main };
//# sourceMappingURL=main.js.map
