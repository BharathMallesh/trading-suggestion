import { describe, it, expect, beforeEach } from 'vitest';
import { FakeStorage } from '../../helpers/fake-storage';
import { makeFsTools, WORKSPACE_ROOT } from '../../../src/agent-core/tools/fs-tools';

let storage: FakeStorage;
let tools: ReturnType<typeof makeFsTools>;
const config: any = {};

beforeEach(async () => {
  storage = new FakeStorage();
  tools = makeFsTools(storage);
});

function handler(name: string) {
  const t = tools.find((t) => t.definition.function.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t.handler;
}

describe('read_file / write_file', () => {
  it('round-trips utf-8 content under the workspace root', async () => {
    expect(await handler('write_file')({ path: 'notes/a.md', content: 'hi' }, config)).toContain('notes/a.md');
    expect(await storage.readText(`${WORKSPACE_ROOT}/notes/a.md`)).toBe('hi');
    expect(await handler('read_file')({ path: 'notes/a.md' }, config)).toBe('hi');
  });
  it('rejects paths escaping the workspace', async () => {
    await expect(handler('write_file')({ path: '../evil', content: 'x' }, config)).rejects.toThrow(/outside/i);
  });
  it('read_file caps at 1 MiB like upstream', async () => {
    await storage.writeText(`${WORKSPACE_ROOT}/big.txt`, 'x'.repeat(1024 * 1024 + 10));
    const out = await handler('read_file')({ path: 'big.txt' }, config);
    expect(out).toContain('truncated');
  });
  it('rejects a >1 MiB file with a NUL byte in the first MiB as binary', async () => {
    const bytes = new Uint8Array(1024 * 1024 + 10).fill(0x61);
    bytes[100] = 0;
    await storage.writeBytes(`${WORKSPACE_ROOT}/big.bin`, bytes);
    await expect(handler('read_file')({ path: 'big.bin' }, config)).rejects.toThrow(/binary/);
  });
});

describe('list_dir', () => {
  it('lists immediate children of a workspace dir', async () => {
    await storage.writeText(`${WORKSPACE_ROOT}/d/f1.txt`, '1');
    await storage.writeText(`${WORKSPACE_ROOT}/d/sub/f2.txt`, '2');
    const out = JSON.parse(await handler('list_dir')({ path: 'd' }, config));
    expect(out).toEqual(['f1.txt', 'sub/']);
  });
});

describe('grep', () => {
  it('returns path:line matches', async () => {
    await storage.writeText(`${WORKSPACE_ROOT}/a.txt`, 'foo\nbar\n');
    await storage.writeText(`${WORKSPACE_ROOT}/b/c.txt`, 'bar baz\n');
    const out = await handler('grep')({ pattern: 'bar', path: '.' }, config);
    expect(out).toContain('a.txt:2:bar');
    expect(out).toContain('b/c.txt:1:bar baz');
  });
});
