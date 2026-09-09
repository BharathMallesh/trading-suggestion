export interface FileStat {
  size: number;       // bytes
  mtimeMs: number;    // last-modified, ms epoch
}

/**
 * Normalize a POSIX-style relative path: collapse redundant separators,
 * strip leading/trailing slashes, drop "." segments. ".." segments are
 * rejected (paths must stay within the storage root).
 */
export function normalizePath(path: string): string {
  const segs = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) throw new Error(`Invalid path: ${path}`);
  return segs.join('/');
}

/**
 * All filesystem access in the app goes through this interface.
 *
 * Paths must be POSIX-style relative paths (e.g. "models/foo.gguf"),
 * relative to the storage root (the user-picked folder, or the OPFS root).
 * Backends normalize redundant separators and trailing slashes.
 *
 * Error semantics:
 *  - readText/readBytes/readFile/stat on a missing path THROW an Error
 *    whose message includes the path.
 *  - list on a nonexistent directory returns [].
 *  - remove on a missing path silently succeeds (idempotent).
 *  - remove on a non-empty directory THROWS (not supported).
 *  - exists is true for files AND for directories containing at least one
 *    entry; empty directories are not representable (there is no mkdir —
 *    directories materialize lazily via writes).
 */
export interface StorageProvider {
  readonly kind: 'fs-access' | 'opfs' | 'fake';
  /** Throws if the path does not exist; error message includes the path. */
  readText(path: string): Promise<string>;
  /** Throws if the path does not exist; error message includes the path. */
  readBytes(path: string): Promise<Uint8Array>;
  /** Returns the file as a Blob without an extra in-memory copy where the backend allows. */
  readFile(path: string): Promise<Blob>;
  /** Throws if the path does not exist; error message includes the path. */
  stat(path: string): Promise<FileStat>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  appendText(path: string, text: string): Promise<void>;
  /** True for files and non-empty directories; false otherwise. */
  exists(path: string): Promise<boolean>;
  /** Immediate children, sorted. Returns [] for a nonexistent directory. */
  list(dir: string): Promise<string[]>;
  /** Idempotent (silently succeeds on missing paths); throws on non-empty directories. */
  remove(path: string): Promise<void>;
}
