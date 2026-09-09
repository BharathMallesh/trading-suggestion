import { describe, it, expect } from 'vitest';
import type { StorageProvider } from '@core/storage';
import { FakeStorage } from '../helpers/fake-storage';
import { OpfsStorage } from '../../src/storage/opfs';

export function storageContract(name: string, make: () => Promise<StorageProvider>) {
  describe(`StorageProvider contract: ${name}`, () => {
    it('writes and reads text', async () => {
      const s = await make();
      await s.writeText('a/b.txt', 'hello');
      expect(await s.readText('a/b.txt')).toBe('hello');
    });
    it('exists() is true for files and ancestor dirs, false otherwise', async () => {
      const s = await make();
      await s.writeText('a/b/c.txt', 'x');
      expect(await s.exists('a/b/c.txt')).toBe(true);
      expect(await s.exists('a/b')).toBe(true);
      expect(await s.exists('a/nope')).toBe(false);
    });
    it('list() returns immediate children only, sorted', async () => {
      const s = await make();
      await s.writeText('w/f1.txt', '1');
      await s.writeText('w/sub/f2.txt', '2');
      expect(await s.list('w')).toEqual(['f1.txt', 'sub']);
    });
    it('appendText appends', async () => {
      const s = await make();
      await s.writeText('l.jsonl', '{"a":1}\n');
      await s.appendText('l.jsonl', '{"b":2}\n');
      expect(await s.readText('l.jsonl')).toBe('{"a":1}\n{"b":2}\n');
    });
    it('stat reports byte size; remove deletes', async () => {
      const s = await make();
      await s.writeText('f.bin', 'abcd');
      expect((await s.stat('f.bin')).size).toBe(4);
      await s.remove('f.bin');
      expect(await s.exists('f.bin')).toBe(false);
    });
  });
}

storageContract('FakeStorage', async () => new FakeStorage());

// jsdom has no OPFS; this suite runs in a browser-capable runner.
// Locally it is skipped.
const hasOpfs = typeof navigator !== 'undefined' && !!(navigator as any).storage?.getDirectory;
(hasOpfs ? describe : describe.skip)('OpfsStorage', () => {
  storageContract('OPFS', () => OpfsStorage.create());
});
