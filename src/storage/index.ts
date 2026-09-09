import type { StorageProvider } from '@core/storage';
import { FileSystemAccessStorage } from './fs-access';
import { OpfsStorage } from './opfs';
import { loadHandle, queryPermission } from './handle-store';

export function fsAccessSupported(): boolean {
  return typeof (window as any).showDirectoryPicker === 'function';
}

/** Restore storage from a previously picked folder, or null if user action is needed. */
export async function restoreStorage(): Promise<StorageProvider | null> {
  if (fsAccessSupported()) {
    const handle = await loadHandle();
    if (handle && (await queryPermission(handle)) === 'granted') {
      return FileSystemAccessStorage.fromHandle(handle);
    }
    return null; // UI must show the re-grant / pick-folder flow
  }
  return OpfsStorage.create(); // fallback: no user action needed
}
