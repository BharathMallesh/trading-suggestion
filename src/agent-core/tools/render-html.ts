import type { StorageProvider } from '../storage';
import type { ToolModule } from './interface';
import { isWorkspacePath } from '../safety';
import { WORKSPACE_ROOT } from './fs-tools';

function toSvg(html: string, width: number, height: number): string {
  const escaped = html.replace(/&(?!amp;|lt;|gt;)/g, '&amp;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;overflow:hidden">${escaped}</div>` +
    `</foreignObject></svg>`;
}

export function makeRenderHtmlTool(storage: StorageProvider): ToolModule {
  return {
    name: 'Render HTML',
    definition: {
      type: 'function',
      function: {
        name: 'render_html',
        description: 'Render an HTML snippet into an SVG (or PNG in-browser) file in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            html: { type: 'string', description: 'HTML snippet with inline styles.' },
            path: { type: 'string', description: 'Workspace-relative output path (.svg or .png).' },
            format: { type: 'string', description: '"svg" or "png". Default: svg.' },
            width: { type: 'number', description: 'Canvas width px (default 800).' },
            height: { type: 'number', description: 'Canvas height px (default 600).' },
          },
          required: ['html', 'path'],
        },
      },
    },
    handler: async (args) => {
      const rel = String(args.path);
      if (!isWorkspacePath(rel)) throw new Error(`Path "${rel}" is outside the workspace.`);
      const width = Number(args.width) || 800;
      const height = Number(args.height) || 600;
      const format = String(args.format ?? 'svg');
      const svg = toSvg(String(args.html), width, height);
      if (format === 'png' && typeof document !== 'undefined' && typeof Image !== 'undefined') {
        // Probe raster support first (jsdom has document/Image but returns null
        // from getContext('2d') without the canvas package).
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return writeSvg();
        try {
          const img = new Image();
          const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
          try {
            await new Promise((ok, err) => { img.onload = ok; img.onerror = err; img.src = url; });
            ctx.drawImage(img, 0, 0);
            const blob: Blob = await new Promise((ok) => canvas.toBlob((b) => ok(b!), 'image/png'));
            await storage.writeBytes(`${WORKSPACE_ROOT}/${rel}`, new Uint8Array(await blob.arrayBuffer()));
            return `Rendered PNG: ${rel}`;
          } finally {
            URL.revokeObjectURL(url);
          }
        } catch {
          // PNG rasterization unavailable — degrade to SVG below.
        }
      }
      return writeSvg();

      async function writeSvg(): Promise<string> {
        await storage.writeText(`${WORKSPACE_ROOT}/${rel}`, svg);
        return `Rendered SVG: ${rel}`;
      }
    },
  };
}
