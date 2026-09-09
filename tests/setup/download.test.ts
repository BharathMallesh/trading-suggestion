import { describe, it, expect, vi, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { FakeStorage } from '../helpers/fake-storage';
import { downloadAsset } from '../../src/setup/download';

const SPEC = { url: 'https://x/m.gguf', path: 'models/m.gguf' };
const SHA256_ABCD = '88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589';

function bodyOf(chunks: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((s) => c.enqueue(enc.encode(s)));
      c.close();
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('downloadAsset', () => {
  it('writes the file and reports progress', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bodyOf(['ab', 'cd']), { headers: { 'content-length': '4' } })),
    );
    const storage = new FakeStorage();
    const seen: number[] = [];
    await downloadAsset({ ...SPEC }, storage, (p) => seen.push(p.loaded));
    expect(await storage.readText('models/m.gguf')).toBe('abcd');
    expect(seen.at(-1)).toBe(4);
  });

  it('skips when the file already exists with the right size', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const storage = new FakeStorage();
    await storage.writeText('models/m.gguf', 'abcd');
    await downloadAsset({ ...SPEC, size: 4 }, storage, () => {});
    expect(f).not.toHaveBeenCalled();
  });

  it('redownloads with a fresh fetch (no Range) when the target has the wrong size', async () => {
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as any)?.Range).toBeUndefined();
      return new Response(bodyOf(['ab', 'cd']), { headers: { 'content-length': '4' } });
    });
    vi.stubGlobal('fetch', f);
    const storage = new FakeStorage();
    await storage.writeText('models/m.gguf', 'ab'); // 2 bytes, spec says 4
    await downloadAsset({ ...SPEC, size: 4 }, storage, () => {});
    expect(f).toHaveBeenCalledTimes(1);
    expect(await storage.readText('models/m.gguf')).toBe('abcd');
  });

  it('resumes a partial download in cache/ with a Range header', async () => {
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as any)?.Range).toBe('bytes=2-');
      return new Response(bodyOf(['cd']), { status: 206, headers: { 'content-length': '2' } });
    });
    vi.stubGlobal('fetch', f);
    const storage = new FakeStorage();
    await storage.writeText('cache/models/m.gguf.part', 'ab');
    await downloadAsset({ ...SPEC, size: 4 }, storage, () => {});
    expect(await storage.readText('models/m.gguf')).toBe('abcd');
    expect(await storage.exists('cache/models/m.gguf.part')).toBe(false);
  });

  it('persists a partial .part on stream error so the next call resumes', async () => {
    const enc = new TextEncoder();
    let attempt = 0;
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      attempt += 1;
      if (attempt === 1) {
        let sent = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (sent) c.error(new Error('boom'));
              else {
                sent = true;
                c.enqueue(enc.encode('ab'));
              }
            },
          }),
          { headers: { 'content-length': '4' } },
        );
      }
      expect((init?.headers as any)?.Range).toBe('bytes=2-');
      return new Response(bodyOf(['cd']), { status: 206, headers: { 'content-length': '2' } });
    });
    vi.stubGlobal('fetch', f);
    const storage = new FakeStorage();
    await expect(
      downloadAsset({ ...SPEC, size: 4 }, storage, () => {}),
    ).rejects.toThrow('boom');
    expect(await storage.readText('cache/models/m.gguf.part')).toBe('ab');
    await downloadAsset({ ...SPEC, size: 4 }, storage, () => {});
    expect(await storage.readText('models/m.gguf')).toBe('abcd');
  });

  it('restarts from scratch when the server ignores the Range request (200, not 206)', async () => {
    const f = vi.fn(
      async () =>
        new Response(bodyOf(['ab', 'cd']), { status: 200, headers: { 'content-length': '4' } }),
    );
    vi.stubGlobal('fetch', f);
    const storage = new FakeStorage();
    await storage.writeText('cache/models/m.gguf.part', 'ab');
    await downloadAsset({ ...SPEC, size: 4 }, storage, () => {});
    expect(await storage.readText('models/m.gguf')).toBe('abcd');
    expect(await storage.exists('cache/models/m.gguf.part')).toBe(false);
  });

  it('restarts without Range when the server rejects the resume range (416)', async () => {
    let attempt = 0;
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      attempt += 1;
      if (attempt === 1) {
        expect((init?.headers as any)?.Range).toBe('bytes=2-');
        return new Response('range not satisfiable', { status: 416 });
      }
      expect((init?.headers as any)?.Range).toBeUndefined();
      return new Response(bodyOf(['ab', 'cd']), { status: 200, headers: { 'content-length': '4' } });
    });
    vi.stubGlobal('fetch', f);
    const storage = new FakeStorage();
    // stale .part as long as (or longer than) the real file: crash happened
    // between finishing the stream and the final write
    await storage.writeText('cache/models/m.gguf.part', 'ab');
    await downloadAsset({ ...SPEC, size: 4 }, storage, () => {});
    expect(f).toHaveBeenCalledTimes(2);
    expect(await storage.readText('models/m.gguf')).toBe('abcd');
    expect(await storage.exists('cache/models/m.gguf.part')).toBe(false);
  });

  it('rejects a truncated body and keeps the partial in cache/ for resume', async () => {
    const f = vi.fn(
      async () => new Response(bodyOf(['ab']), { headers: { 'content-length': '2' } }),
    );
    vi.stubGlobal('fetch', f);
    const storage = new FakeStorage();
    await expect(downloadAsset({ ...SPEC, size: 4 }, storage, () => {})).rejects.toThrow(
      /truncated/i,
    );
    expect(await storage.exists('models/m.gguf')).toBe(false);
    expect(await storage.readText('cache/models/m.gguf.part')).toBe('ab');
  });

  it('verifies sha256 when provided; mismatch goes to cache/ and throws', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const f = vi.fn(
      async () => new Response(bodyOf(['ab', 'cd']), { headers: { 'content-length': '4' } }),
    );
    vi.stubGlobal('fetch', f);
    const good = new FakeStorage();
    await downloadAsset({ ...SPEC, size: 4, sha256: SHA256_ABCD }, good, () => {});
    expect(await good.readText('models/m.gguf')).toBe('abcd');

    const bad = new FakeStorage();
    await expect(
      downloadAsset({ ...SPEC, size: 4, sha256: '0'.repeat(64) }, bad, () => {}),
    ).rejects.toThrow(/sha256/i);
    expect(await bad.exists('models/m.gguf')).toBe(false);
    expect(await bad.readText('cache/models/m.gguf.part')).toBe('abcd');
  });
});
