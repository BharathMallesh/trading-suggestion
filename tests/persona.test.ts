import { describe, it, expect } from 'vitest';
import { loadPersonaBlock } from '../src/agent-core/persona';
import type { StorageProvider } from '../src/agent-core/storage';

function fakeStorage(files: Record<string, string>): StorageProvider {
  const clean = (p: string) => p.replace(/^\/+|\/+$/g, '');
  return {
    kind: 'fake',
    async exists(p) {
      return clean(p) in files;
    },
    async readText(p) {
      const t = files[clean(p)];
      if (t == null) throw new Error(`missing ${p}`);
      return t;
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
    async writeText() {},
    async appendText() {},
    async list() {
      return [];
    },
    async remove() {},
  };
}

describe('loadPersonaBlock', () => {
  it('returns empty string when nothing is configured', async () => {
    expect(await loadPersonaBlock(fakeStorage({}))).toBe('');
  });

  it('maps dials to low/mid/high style lines and uses the name', async () => {
    // Playful(0) fully playful, Polite(1) fully unfiltered, rest balanced.
    const dials = [0.5, 0.5, 0.5, 0, 1];
    const block = await loadPersonaBlock(fakeStorage({ 'luna/personality.json': JSON.stringify(dials) }), 'Luna');
    expect(block).toContain('you are Luna');
    expect(block).toContain('playful, witty, and light'); // dial 3 low
    expect(block).toContain('blunt, direct, and unfiltered'); // dial 4 high
    expect(block).toContain('friendly but professional'); // dial 0 mid (0.5)
  });

  it('includes the user name and notes from the "you" contact', async () => {
    const contacts = [{ id: 'you', name: 'Bharath', notes: 'Prefers short answers.' }];
    const block = await loadPersonaBlock(fakeStorage({ 'luna/contacts.json': JSON.stringify(contacts) }));
    expect(block).toContain("The user's name is Bharath.");
    expect(block).toContain('Prefers short answers.');
  });

  it('ignores a malformed personality file without throwing', async () => {
    const block = await loadPersonaBlock(fakeStorage({ 'luna/personality.json': 'not json' }));
    expect(block).toBe('');
  });
});
