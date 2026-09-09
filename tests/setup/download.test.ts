import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeStorage } from '../helpers/fake-storage';
import { downloadAsset } from '../../src/setup/download';

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
    await downloadAsset({ url: 'https://x/m.gguf', path: 'models/m.gguf' }, storage, (p) =>
      seen.push(p.loaded),
    );
    expect(await storage.readText('models/m.gguf')).toBe('abcd');
    expect(seen.at(-1)).toBe(4);
  });

  it('skips when the file already exists with the right size', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const storage = new FakeStorage();
    await storage.writeText('models/m.gguf', 'abcd');
    await downloadAsset(
      { url: 'https://x/m.gguf', path: 'models/m.gguf', size: 4 } as any,
      storage,
      () => {},
    );
    expect(f).not.toHaveBeenCalled();
  });

  it('resumes a partial download in cache/ with a Range header', async () => {
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as any)?.Range).toBe('bytes=2-');
      return new Response(bodyOf(['cd']), { status: 206, headers: { 'content-length': '2' } });
    });
    vi.stubGlobal('fetch', f);
    const storage = new FakeStorage();
    await storage.writeText('cache/m.gguf.part', 'ab');
    await downloadAsset(
      { url: 'https://x/m.gguf', path: 'models/m.gguf', size: 4 } as any,
      storage,
      () => {},
    );
    expect(await storage.readText('models/m.gguf')).toBe('abcd');
    expect(await storage.exists('cache/m.gguf.part')).toBe(false);
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
      downloadAsset({ url: 'https://x/m.gguf', path: 'models/m.gguf', size: 4 } as any, storage, () => {}),
    ).rejects.toThrow('boom');
    expect(await storage.readText('cache/m.gguf.part')).toBe('ab');
    await downloadAsset(
      { url: 'https://x/m.gguf', path: 'models/m.gguf', size: 4 } as any,
      storage,
      () => {},
    );
    expect(await storage.readText('models/m.gguf')).toBe('abcd');
  });

  it('restarts from scratch when the server ignores the Range request (200, not 206)', async () => {
    const f = vi.fn(
      async () =>
        new Response(bodyOf(['ab', 'cd']), { status: 200, headers: { 'content-length': '4' } }),
    );
    vi.stubGlobal('fetch', f);
    const storage = new FakeStorage();
    await storage.writeText('cache/m.gguf.part', 'ab');
    await downloadAsset(
      { url: 'https://x/m.gguf', path: 'models/m.gguf', size: 4 } as any,
      storage,
      () => {},
    );
    expect(await storage.readText('models/m.gguf')).toBe('abcd');
    expect(await storage.exists('cache/m.gguf.part')).toBe(false);
  });
});
