import { HandleStorage } from './handle-storage';

export class FileSystemAccessStorage extends HandleStorage {
  readonly kind = 'fs-access' as const;

  private constructor(root: FileSystemDirectoryHandle) {
    super(root);
  }

  static fromHandle(root: FileSystemDirectoryHandle): FileSystemAccessStorage {
    return new FileSystemAccessStorage(root);
  }

  static async pickAndCreate(): Promise<FileSystemAccessStorage> {
    const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
    return new FileSystemAccessStorage(handle);
  }
}
