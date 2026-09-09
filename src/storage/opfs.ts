import { normalizePath } from '@core/storage';
import type { StorageProvider, FileStat } from '@core/storage';

export class OpfsStorage implements StorageProvider {
  readonly kind = 'opfs' as const;
  private root: FileSystemDirectoryHandle;

  private constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
  }

  static async create(): Promise<OpfsStorage> {
    const root = await (navigator as any).storage.getDirectory();
    return new OpfsStorage(root);
  }

  /** Rethrow OPFS NotFoundError DOMExceptions as plain Errors that include the path. */
  private rethrow(path: string, err: unknown): never {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      throw new Error(`ENOENT: ${path}`);
    }
    throw err;
  }

  private async dirHandle(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    let dir = this.root;
    for (const seg of path.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(seg, { create });
    }
    return dir;
  }

  private split(path: string): { dir: string; name: string } {
    const i = path.lastIndexOf('/');
    return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
  }

  private async fileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
    const { dir, name } = this.split(path);
    const d = await this.dirHandle(dir, create);
    return d.getFileHandle(name, { create });
  }

  async readBytes(path: string): Promise<Uint8Array> {
    path = normalizePath(path);
    try {
      const f = await (await this.fileHandle(path)).getFile();
      return new Uint8Array(await f.arrayBuffer());
    } catch (err) {
      this.rethrow(path, err);
    }
  }
  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }
  async readFile(path: string): Promise<Blob> {
    path = normalizePath(path);
    try {
      return await (await this.fileHandle(path)).getFile(); // a File IS a Blob
    } catch (err) {
      this.rethrow(path, err);
    }
  }
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    path = normalizePath(path);
    const fh = await this.fileHandle(path, true);
    const w = await fh.createWritable();
    await w.write(data as Uint8Array<ArrayBuffer>);
    await w.close();
  }
  async writeText(path: string, text: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(text));
  }
  async appendText(path: string, text: string): Promise<void> {
    const prev = (await this.exists(path)) ? await this.readText(path) : '';
    await this.writeText(path, prev + text);
  }
  async exists(path: string): Promise<boolean> {
    path = normalizePath(path);
    try {
      const { dir, name } = this.split(path);
      const d = await this.dirHandle(dir);
      try { await d.getFileHandle(name); return true; } catch { /* not a file */ }
      try {
        const sub = await d.getDirectoryHandle(name);
        // true only for non-empty dirs: empty dirs are not representable
        for await (const _key of (sub as any).keys()) return true;
        return false;
      } catch { return false; }
    } catch { return false; }
  }
  async stat(path: string): Promise<FileStat> {
    path = normalizePath(path);
    try {
      const f = await (await this.fileHandle(path)).getFile();
      return { size: f.size, mtimeMs: f.lastModified };
    } catch (err) {
      this.rethrow(path, err);
    }
  }
  async list(dir: string): Promise<string[]> {
    dir = normalizePath(dir);
    try {
      const d = await this.dirHandle(dir);
      const out: string[] = [];
      for await (const key of (d as any).keys()) out.push(key);
      return out.sort();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return [];
      throw err;
    }
  }
  async remove(path: string): Promise<void> {
    path = normalizePath(path);
    const { dir, name } = this.split(path);
    const d = await this.dirHandle(dir);
    try {
      await d.removeEntry(name);
    } catch (err) {
      // idempotent: removing a missing path silently succeeds.
      // non-empty dirs still throw (InvalidModificationError), as documented.
      if (err instanceof DOMException && err.name === 'NotFoundError') return;
      throw err;
    }
  }
}
