import type { ToolModule } from './interface';

const MAX_CHARS = 20_000;

export function makeWebFetchTool(): ToolModule {
  return {
    name: 'Web Fetch',
    configKeys: [],
    isAvailable: (config: any) => !!(config?.online),
    definition: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Fetch a web page and return its text content (HTML tags stripped). Only available when online.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'The URL to fetch (http/https).' } },
          required: ['url'],
        },
      },
    },
    handler: async (args) => {
      try {
        const url = new URL(String(args.url));
        if (!/^https?:$/.test(url.protocol)) return `Error: only http/https URLs are allowed.`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return `Error: HTTP ${res.status} for ${url}`;
        const html = await res.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
          .trim();
        return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n... (truncated)' : text;
      } catch (err: any) {
        return `Error: ${err?.message ?? String(err)}`;
      }
    },
  };
}
