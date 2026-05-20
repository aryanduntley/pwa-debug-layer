import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLine, readLines } from '../../src/host_io/host_io.js';

const collect = async (it: AsyncIterable<string>): Promise<string[]> => {
  const out: string[] = [];
  for await (const line of it) out.push(line);
  return out;
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwa-debug-host-io-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('appendLine', () => {
  it('writes one record with a trailing newline on first call', async () => {
    const path = join(dir, 'log.jsonl');
    await appendLine(path, '{"a":1}');
    const body = await readFile(path, 'utf-8');
    expect(body).toBe('{"a":1}\n');
  });

  it('appends additional records in order without rewriting existing bytes', async () => {
    const path = join(dir, 'log.jsonl');
    await appendLine(path, '{"a":1}');
    await appendLine(path, '{"a":2}');
    await appendLine(path, '{"a":3}');
    const body = await readFile(path, 'utf-8');
    expect(body).toBe('{"a":1}\n{"a":2}\n{"a":3}\n');
  });

  it('creates missing parent directories recursively', async () => {
    const path = join(dir, 'deep', 'sub', 'tree', 'log.jsonl');
    await appendLine(path, 'hello');
    const body = await readFile(path, 'utf-8');
    expect(body).toBe('hello\n');
  });

  it('creates the file with 0600 permissions on first write', async () => {
    const path = join(dir, 'perms.jsonl');
    await appendLine(path, 'x');
    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('preserves an empty-string line (just the terminator)', async () => {
    const path = join(dir, 'empty.jsonl');
    await appendLine(path, '');
    const body = await readFile(path, 'utf-8');
    expect(body).toBe('\n');
  });
});

describe('readLines', () => {
  it('round-trips lines written via appendLine in order', async () => {
    const path = join(dir, 'log.jsonl');
    await appendLine(path, '{"a":1}');
    await appendLine(path, '{"a":2}');
    await appendLine(path, '{"a":3}');
    expect(await collect(readLines(path))).toEqual([
      '{"a":1}',
      '{"a":2}',
      '{"a":3}',
    ]);
  });

  it('yields nothing (and does not throw) on a missing path', async () => {
    const path = join(dir, 'never.jsonl');
    expect(await collect(readLines(path))).toEqual([]);
  });

  it('yields nothing on an empty file', async () => {
    const path = join(dir, 'empty.jsonl');
    await writeFile(path, '', 'utf-8');
    expect(await collect(readLines(path))).toEqual([]);
  });

  it('emits a final line that lacks a trailing newline', async () => {
    const path = join(dir, 'no-trailing.jsonl');
    await writeFile(path, 'a\nb', 'utf-8');
    expect(await collect(readLines(path))).toEqual(['a', 'b']);
  });
});
