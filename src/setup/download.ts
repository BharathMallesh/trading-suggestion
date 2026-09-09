import type { StorageProvider } from '@core/storage';

export interface DownloadSpec {
  url: string;
  path: string;
  size?: number;
  sha256?: string;
}

export interface Progress {
  loaded: number;
  total: number;
}

function partPathFor(path: string): string {
  return `cache/${path.split('/').pop()}.part`;
}

/**
 * Download `spec.url` into `spec.path` (folder-relative), resumable via a
 * `cache/<name>.part` file: on failure the received bytes are kept there and
 * the next call resumes with a `Range: bytes=<n>-` request.
 *
 * Limitation: received chunks are buffered fully in memory before the final
 * write (~2x the asset size at peak). Fine for the ~500MB base model on
 * desktop; revisit with streamed writes if memory becomes an issue.
 *
 * @param onProgress reports {loaded, total}; total may be 0 if the server
 *   sends no content-length.
 */
export async function downloadAsset(
  spec: DownloadSpec,
  storage: StorageProvider,
  onProgress: (p: Progress) => void,
): Promise<void> {
  if (spec.size != null && (await storage.exists(spec.path))) {
    try {
      if ((await storage.stat(spec.path)).size === spec.size) return; // already done
    } catch {
      /* fall through and re-download */
    }
  }

  const partPath = partPathFor(spec.path);
  let resumeFrom = 0;
  let prior: Uint8Array = new Uint8Array(0);
  if (await storage.exists(partPath)) {
    try {
      prior = await storage.readBytes(partPath);
      resumeFrom = prior.byteLength;
    } catch {
      resumeFrom = 0;
      prior = new Uint8Array(0);
    }
  }

  const headers: Record<string, string> = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};
  const res = await fetch(spec.url, { headers });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} downloading ${spec.url}`);
  if (resumeFrom > 0 && res.status !== 206) {
    // server ignored the Range request: the body is the FULL file, so the
    // stale .part must be discarded rather than prepended (corruption)
    resumeFrom = 0;
    prior = new Uint8Array(0);
    if (await storage.exists(partPath)) await storage.remove(partPath);
  }

  const reader = res.body!.getReader();
  // LIMITATION: whole download buffered in memory before writing (see doc comment)
  const chunks: Uint8Array[] = [];
  let loaded = resumeFrom;
  const total = Number(res.headers.get('content-length') ?? 0) + resumeFrom;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress({ loaded, total });
    }
  } catch (err) {
    // keep received bytes in cache/ so a later call resumes where we stopped
    const partial = concat(prior, chunks);
    if (partial.byteLength > 0) await storage.writeBytes(partPath, partial);
    throw err;
  }

  const out = concat(prior, chunks);
  await storage.writeBytes(spec.path, out);
  if (await storage.exists(partPath)) await storage.remove(partPath);
}

function concat(prior: Uint8Array, chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(prior.byteLength + chunks.reduce((n, c) => n + c.byteLength, 0));
  out.set(prior, 0);
  let off = prior.byteLength;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
