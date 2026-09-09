import { HandleStorage } from './handle-storage';

export class OpfsStorage extends HandleStorage {
  readonly kind = 'opfs' as const;

  private constructor(root: FileSystemDirectoryHandle) {
    super(root);
  }

  static async create(): Promise<OpfsStorage> {
    const root = await (navigator as any).storage.getDirectory();
    return new OpfsStorage(root);
  }
}
