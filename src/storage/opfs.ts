import { HandleStorage } from './handle-storage';
import { saveStorageKind } from './handle-store';

export class OpfsStorage extends HandleStorage {
  readonly kind = 'opfs' as const;

  private constructor(root: FileSystemDirectoryHandle) {
    super(root);
  }

  static async create(): Promise<OpfsStorage> {
    const root = await (navigator as any).storage.getDirectory();
    await saveStorageKind('opfs'); // persist the choice so reloads restore OPFS directly
    return new OpfsStorage(root);
  }
}
