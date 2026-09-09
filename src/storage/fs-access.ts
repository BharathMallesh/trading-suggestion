import { HandleStorage } from './handle-storage';
import { saveHandle } from './handle-store';

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
    await saveHandle(handle); // pick + persist atomically so callers can't forget
    return new FileSystemAccessStorage(handle);
  }
}
