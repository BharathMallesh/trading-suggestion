import type { StorageProvider } from '@core/storage';
import { FileSystemAccessStorage } from './fs-access';
import { OpfsStorage } from './opfs';
import { loadHandle, loadStorageKind, queryPermission } from './handle-store';

export type RestoreResult =
  | { status: 'ready'; storage: StorageProvider }
  | { status: 'needs-permission'; handle: FileSystemDirectoryHandle }
  | { status: 'no-handle' };

export function fsAccessSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).showDirectoryPicker === 'function';
}

/** Restore storage from a previously picked folder, or report what the UI must do next. */
export async function restoreStorage(): Promise<RestoreResult> {
  // A previous session chose OPFS: restore it directly, even in browsers that
  // also support the folder picker (otherwise an OPFS user reloads into the
  // setup screen and, offline, could never re-download).
  if ((await loadStorageKind()) === 'opfs') {
    return { status: 'ready', storage: await OpfsStorage.create() };
  }
  if (fsAccessSupported()) {
    const handle = await loadHandle();
    if (handle) {
      const perm = await queryPermission(handle);
      if (perm === 'granted') {
        return { status: 'ready', storage: FileSystemAccessStorage.fromHandle(handle) };
      }
      if (perm === 'prompt') {
        return { status: 'needs-permission', handle };
      }
    }
    return { status: 'no-handle' }; // UI must show the pick-folder flow
  }
  return { status: 'ready', storage: await OpfsStorage.create() }; // fallback: no user action needed
}
