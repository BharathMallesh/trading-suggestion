import type { StorageProvider, FileStat } from '@core/storage';

export class FakeStorage implements StorageProvider {
  readonly kind = 'fake' as const;
  private files = new Map<string, Uint8Array>();

  async readText(path: string): Promise<string> {
    const b = this.files.get(path);
    if (!b) throw new Error(`ENOENT: ${path}`);
    return new TextDecoder().decode(b);
  }
  async readBytes(path: string): Promise<Uint8Array> {
    const b = this.files.get(path);
    if (!b) throw new Error(`ENOENT: ${path}`);
    return b;
  }
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }
  async writeText(path: string, text: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(text));
  }
  async appendText(path: string, text: string): Promise<void> {
    const prev = this.files.has(path) ? await this.readText(path) : '';
    await this.writeText(path, prev + text);
  }
  async exists(path: string): Promise<boolean> {
    if (this.files.has(path)) return true;
    const prefix = path.endsWith('/') ? path : path + '/';
    return [...this.files.keys()].some((k) => k.startsWith(prefix));
  }
  async stat(path: string): Promise<FileStat> {
    const b = this.files.get(path);
    if (!b) throw new Error(`ENOENT: ${path}`);
    return { size: b.byteLength, mtimeMs: 0 };
  }
  async list(dir: string): Promise<string[]> {
    const prefix = dir === '' ? '' : dir.endsWith('/') ? dir : dir + '/';
    const out = new Set<string>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      out.add(rest.split('/')[0]);
    }
    return [...out].sort();
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}
