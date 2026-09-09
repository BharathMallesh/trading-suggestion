import { describe, it, expect } from 'vitest';
import type { StorageProvider } from '@core/storage';

export function storageContract(name: string, make: () => Promise<StorageProvider>) {
  describe(`StorageProvider contract: ${name}`, () => {
    it('writes and reads text', async () => {
      const s = await make();
      await s.writeText('a/b.txt', 'hello');
      expect(await s.readText('a/b.txt')).toBe('hello');
    });
    it('exists() is true for files and non-empty dirs, false otherwise', async () => {
      const s = await make();
      await s.writeText('a/b/c.txt', 'x');
      expect(await s.exists('a/b/c.txt')).toBe(true);
      expect(await s.exists('a/b')).toBe(true);
      expect(await s.exists('a/nope')).toBe(false);
    });
    it('exists() is false once a directory no longer contains entries', async () => {
      const s = await make();
      await s.writeText('a/x.txt', 'x');
      expect(await s.exists('a')).toBe(true);
      await s.remove('a/x.txt');
      expect(await s.exists('a')).toBe(false);
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
    it('readText/readBytes/stat on a missing path throw with the path in the message', async () => {
      const s = await make();
      await expect(s.readText('nope.txt')).rejects.toThrow(/nope\.txt/);
      await expect(s.readBytes('nope.txt')).rejects.toThrow(/nope\.txt/);
      await expect(s.stat('nope.txt')).rejects.toThrow(/nope\.txt/);
    });
    it('readFile on a missing path throws with the path in the message', async () => {
      const s = await make();
      await expect(s.readFile('nope.bin')).rejects.toThrow(/nope\.bin/);
    });
    it('list on a nonexistent directory returns []', async () => {
      const s = await make();
      expect(await s.list('missing')).toEqual([]);
    });
    it('remove on a missing path silently succeeds', async () => {
      const s = await make();
      await expect(s.remove('never-existed.txt')).resolves.toBeUndefined();
    });
    it('remove with a missing parent dir silently succeeds', async () => {
      const s = await make();
      await expect(s.remove('missingdir/f.txt')).resolves.toBeUndefined();
    });
    it('exists("") is true iff the storage root contains anything', async () => {
      const s = await make();
      // Shared-root backends (OPFS) may retain earlier tests' files; only
      // assert the empty case when the root really is empty.
      if ((await s.list('')).length === 0) {
        expect(await s.exists('')).toBe(false);
      }
      await s.writeText('root-probe.tmp', 'x');
      expect(await s.exists('')).toBe(true);
      await s.remove('root-probe.tmp');
    });
    it('remove on a non-empty directory throws', async () => {
      const s = await make();
      await s.writeText('d/f.txt', 'x');
      await expect(s.remove('d')).rejects.toThrow();
    });
    it('readFile round-trips bytes written with writeBytes', async () => {
      const s = await make();
      const data = new Uint8Array([0, 1, 2, 255, 254]);
      await s.writeBytes('m.bin', data);
      const buf = new Uint8Array(await (await s.readFile('m.bin')).arrayBuffer());
      expect(buf).toEqual(data);
    });
    it('normalizes redundant separators and trailing slashes', async () => {
      const s = await make();
      await s.writeText('//a//b//c.txt', 'x');
      expect(await s.readText('a/b/c.txt')).toBe('x');
      expect(await s.readText('a/b/c.txt/')).toBe('x');
      await s.writeText('w/f.txt', '1');
      expect(await s.list('w/')).toEqual(['f.txt']);
    });
  });
}
