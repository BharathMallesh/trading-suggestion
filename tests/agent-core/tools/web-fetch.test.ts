import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeWebFetchTool } from '../../../src/agent-core/tools/web-fetch';

afterEach(() => vi.unstubAllGlobals());

describe('web_fetch', () => {
  it('is unavailable when offline, available when online', () => {
    const t = makeWebFetchTool();
    expect(t.isAvailable!({ online: false })).toBe(false);
    expect(t.isAvailable!({ online: true })).toBe(true);
  });
  it('fetches a URL and strips tags to text, capped at 20k chars', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body><h1>Hi</h1><script>x()</script></body></html>')));
    const t = makeWebFetchTool();
    const out = await t.handler({ url: 'https://example.com' }, { online: true });
    expect(out).toContain('Hi');
    expect(out).not.toContain('script');
  });
  it('returns an error string on network failure, does not throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const t = makeWebFetchTool();
    expect(await t.handler({ url: 'https://x' }, { online: true })).toMatch(/Error/);
  });
  it('rejects non-http(s) URLs', async () => {
    const t = makeWebFetchTool();
    expect(await t.handler({ url: 'file:///etc/passwd' }, { online: true })).toMatch(/Error: only http\/https URLs are allowed\./);
  });
  it('truncates text longer than 20k chars with a suffix', async () => {
    const long = 'a'.repeat(25_000);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`<p>${long}</p>`)));
    const t = makeWebFetchTool();
    const out = await t.handler({ url: 'https://example.com' }, { online: true });
    expect(out.length).toBeLessThan(25_000);
    expect(out.endsWith('... (truncated)')).toBe(true);
  });
  it('returns Error: HTTP <status> on non-OK responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const t = makeWebFetchTool();
    expect(await t.handler({ url: 'https://example.com/missing' }, { online: true })).toMatch(/Error: HTTP 404/);
  });
});
