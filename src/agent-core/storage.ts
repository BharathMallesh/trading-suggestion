export interface FileStat {
  size: number;       // bytes
  mtimeMs: number;    // last-modified, ms epoch
}

/**
 * All filesystem access in the app goes through this interface.
 * Paths are POSIX-style, relative to the storage root
 * (the user-picked folder, or the OPFS root).
 */
export interface StorageProvider {
  readonly kind: 'fs-access' | 'opfs' | 'fake';
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  appendText(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;   // true for files AND non-empty dirs
  stat(path: string): Promise<FileStat>;
  list(dir: string): Promise<string[]>;     // immediate children, sorted
  remove(path: string): Promise<void>;
}
