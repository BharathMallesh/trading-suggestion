import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystemAccessStorage } from '../../src/storage/fs-access';
import { storageContract } from '../helpers/storage-contract';

// Minimal in-memory FileSystemDirectoryHandle mock
class MockFileHandle {
  private store: Map<string, Uint8Array>;
  private key: string;

  constructor(store: Map<string, Uint8Array>, key: string) {
    this.store = store;
    this.key = key;
  }

  async getFile() {
    const b = this.store.get(this.key);
    if (!b) throw new DOMException('not found', 'NotFoundError');
    return Object.assign(new Blob([b.slice()]), { lastModified: 0 });
  }
  async createWritable() {
    const store = this.store,
      key = this.key;
    const chunks: Uint8Array[] = [];
    return {
      async write(d: Uint8Array) {
        chunks.push(d);
      },
      async close() {
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.byteLength;
        }
        store.set(key, out);
      },
    };
  }
}
class MockDirHandle {
  kind = 'directory' as const;
  private prefix: string;
  private store: Map<string, Uint8Array>;

  constructor(prefix: string, store: Map<string, Uint8Array>) {
    this.prefix = prefix;
    this.store = store;
  }
  private childKey(name: string) {
    return this.prefix ? `${this.prefix}/${name}` : name;
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    const key = this.childKey(name) + '/';
    const exists = [...this.store.keys()].some((k) => k.startsWith(key));
    if (!exists && !opts?.create) throw new DOMException('not found', 'NotFoundError');
    return new MockDirHandle(this.childKey(name), this.store);
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    const key = this.childKey(name);
    if (!this.store.has(key) && !opts?.create) throw new DOMException('not found', 'NotFoundError');
    return new MockFileHandle(this.store, key);
  }
  async removeEntry(name: string) {
    const key = this.childKey(name);
    if ([...this.store.keys()].some((k) => k.startsWith(key + '/'))) {
      throw new DOMException('directory not empty', 'InvalidModificationError');
    }
    this.store.delete(key);
  }
  async *keys(): AsyncIterable<string> {
    const out = new Set<string>();
    const prefix = this.prefix ? this.prefix + '/' : '';
    for (const k of this.store.keys()) {
      if (!k.startsWith(prefix)) continue;
      out.add(k.slice(prefix.length).split('/')[0]);
    }
    yield* [...out].sort();
  }
}

const store = new Map<string, Uint8Array>();

// The contract suite and the specifics below share the same backing store,
// so clear it between tests to keep exists('') assertions deterministic.
beforeEach(() => store.clear());

storageContract('FileSystemAccessStorage', async () =>
  FileSystemAccessStorage.fromHandle(new MockDirHandle('', store) as unknown as FileSystemDirectoryHandle),
);

describe('FileSystemAccessStorage specifics', () => {
  it('exposes kind fs-access', async () => {
    const s = FileSystemAccessStorage.fromHandle(new MockDirHandle('', store) as any);
    expect(s.kind).toBe('fs-access');
  });
});
