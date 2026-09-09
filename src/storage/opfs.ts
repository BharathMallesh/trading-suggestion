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
    const fh = await this.fileHandle(path);
    const f = await fh.getFile();
    return new Uint8Array(await f.arrayBuffer());
  }
  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
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
    try {
      const { dir, name } = this.split(path);
      const d = await this.dirHandle(dir);
      try { await d.getFileHandle(name); return true; } catch { /* not a file */ }
      try { await d.getDirectoryHandle(name); return true; } catch { return false; }
    } catch { return false; }
  }
  async stat(path: string): Promise<FileStat> {
    const f = await (await this.fileHandle(path)).getFile();
    return { size: f.size, mtimeMs: f.lastModified };
  }
  async list(dir: string): Promise<string[]> {
    const d = await this.dirHandle(dir);
    const out: string[] = [];
    for await (const key of (d as any).keys()) out.push(key);
    return out.sort();
  }
  async remove(path: string): Promise<void> {
    const { dir, name } = this.split(path);
    const d = await this.dirHandle(dir);
    await d.removeEntry(name);
  }
}
