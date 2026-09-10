import { get, set, del } from 'idb-keyval';

const KEY = 'autoclaw.dirHandle';
const KIND_KEY = 'autoclaw.storageKind';

export type StorageKind = 'fs-access' | 'opfs';

/** Remember which storage backend the user chose, so reloads skip the picker. */
export async function saveStorageKind(kind: StorageKind): Promise<void> {
  await set(KIND_KEY, kind);
}

export async function loadStorageKind(): Promise<StorageKind | undefined> {
  const kind = await get(KIND_KEY);
  return kind === 'fs-access' || kind === 'opfs' ? kind : undefined;
}

export async function saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await set(KEY, handle);
}

export async function loadHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  return get(KEY);
}

export async function clearHandle(): Promise<void> {
  return del(KEY);
}

/** Returns 'granted' | 'prompt' | 'denied'. Never throws. */
export async function queryPermission(handle: FileSystemDirectoryHandle): Promise<string> {
  try {
    return await (handle as any).queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

export async function requestPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    return (await (handle as any).requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}
