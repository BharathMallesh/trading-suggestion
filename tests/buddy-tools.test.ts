import { describe, it, expect } from 'vitest';
import { makeRememberTool, makeRecallTool, makeCreateScheduleTool } from '../src/agent-core/tools/buddy-tools';
import type { StorageProvider } from '../src/agent-core/storage';

// Minimal mutable in-memory storage for the tools' read-modify-write.
function memStorage(seed: Record<string, string> = {}): StorageProvider {
  const files = new Map<string, string>(Object.entries(seed));
  const clean = (p: string) => p.replace(/^\/+|\/+$/g, '');
  return {
    kind: 'fake',
    async exists(p) {
      return files.has(clean(p));
    },
    async readText(p) {
      const t = files.get(clean(p));
      if (t == null) throw new Error(`missing ${p}`);
      return t;
    },
    async writeText(p, text) {
      files.set(clean(p), text);
    },
    async readBytes() {
      throw new Error('n/a');
    },
    async readFile() {
      throw new Error('n/a');
    },
    async stat() {
      throw new Error('n/a');
    },
    async writeBytes() {},
    async appendText() {},
    async list() {
      return [];
    },
    async remove() {},
  };
}

describe('buddy tools', () => {
  it('remember saves a memory and recall lists it', async () => {
    const storage = memStorage();
    const remember = makeRememberTool(storage);
    const recall = makeRecallTool(storage);

    const r = await remember.handler({ text: 'I take my coffee black' });
    expect(r).toContain('Saved to memory');

    const saved = JSON.parse(await storage.readText('luna/memory.json'));
    expect(saved).toHaveLength(1);
    expect(saved[0].text).toBe('I take my coffee black');
    expect(saved[0].status).toBe('settled');

    const list = await recall.handler({});
    expect(list).toContain('I take my coffee black');
  });

  it('remember dedupes case-insensitively', async () => {
    const storage = memStorage();
    const remember = makeRememberTool(storage);
    await remember.handler({ text: 'My dog is Pixel' });
    const again = await remember.handler({ text: 'my dog is pixel' });
    expect(again).toContain('Already remembered');
    expect(JSON.parse(await storage.readText('luna/memory.json'))).toHaveLength(1);
  });

  it('remember rejects empty text', async () => {
    const storage = memStorage();
    expect(await makeRememberTool(storage).handler({ text: '  ' })).toContain('Error');
  });

  it('create_schedule appends a well-formed schedule', async () => {
    const storage = memStorage();
    const tool = makeCreateScheduleTool(storage);
    const r = await tool.handler({ name: 'Morning brief', message: 'summarize my day', repeat: 'Daily', hour: 8, minute: 30, ampm: 'AM' });
    expect(r).toContain('Created schedule');
    const saved = JSON.parse(await storage.readText('luna/schedules.json'));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Morning brief', repeat: 'Daily', hour: 8, minute: 30, ampm: 'AM', message: 'summarize my day' });
  });

  it('create_schedule needs a name and message', async () => {
    const storage = memStorage();
    expect(await makeCreateScheduleTool(storage).handler({ name: '', message: '', repeat: 'Daily' })).toContain('Error');
  });
});
