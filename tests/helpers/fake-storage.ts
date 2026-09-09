import { normalizePath } from '@core/storage';
import type { StorageProvider, FileStat } from '@core/storage';

export class FakeStorage implements StorageProvider {
  readonly kind = 'fake' as const;
  private files = new Map<string, Uint8Array>();

  private get(path: string): Uint8Array {
    const b = this.files.get(path);
    if (!b) throw new Error(`ENOENT: ${path}`);
    return b;
  }

  async readText(path: string): Promise<string> {
    path = normalizePath(path);
    return new TextDecoder().decode(this.get(path));
  }
  async readBytes(path: string): Promise<Uint8Array> {
    path = normalizePath(path);
    return this.get(path).slice();
  }
  async readFile(path: string): Promise<Blob> {
    path = normalizePath(path);
    return new Blob([this.get(path).slice()]);
  }
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    path = normalizePath(path);
    // copy: real backends copy on write, the fake must not store by reference
    this.files.set(path, data.slice());
  }
  async writeText(path: string, text: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(text));
  }
  async appendText(path: string, text: string): Promise<void> {
    path = normalizePath(path);
    const prev = this.files.has(path) ? await this.readText(path) : '';
    await this.writeText(path, prev + text);
  }
  async exists(path: string): Promise<boolean> {
    path = normalizePath(path);
    if (this.files.has(path)) return true;
    if (path === '') return this.files.size > 0;
    const prefix = path + '/';
    return [...this.files.keys()].some((k) => k.startsWith(prefix));
  }
  async stat(path: string): Promise<FileStat> {
    path = normalizePath(path);
    return { size: this.get(path).byteLength, mtimeMs: 0 };
  }
  async list(dir: string): Promise<string[]> {
    dir = normalizePath(dir);
    const prefix = dir === '' ? '' : dir + '/';
    const out = new Set<string>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      out.add(rest.split('/')[0]);
    }
    return [...out].sort();
  }
  async remove(path: string): Promise<void> {
    path = normalizePath(path);
    if (this.files.delete(path)) return;
    const prefix = path + '/';
    if (path !== '' && [...this.files.keys()].some((k) => k.startsWith(prefix))) {
      throw new Error(`ENOTEMPTY: ${path}`);
    }
    // missing path: silently succeed (idempotent)
  }
}
