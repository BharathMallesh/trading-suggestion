import type { StorageProvider } from '../storage';
import type { ToolModule } from './interface';
import { isWorkspacePath } from '../safety';

export const WORKSPACE_ROOT = 'workspace';
const READ_FILE_MAX_BYTES = 1024 * 1024; // same cap as upstream core.ts:14

function resolve(path: string): string {
  if (!isWorkspacePath(path)) throw new Error(`Path "${path}" is outside the workspace.`);
  return path === '' || path === '.' ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${path}`;
}

export function makeFsTools(storage: StorageProvider): ToolModule[] {
  return [
    {
      name: 'Read File',
      definition: {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read the content of a file in the workspace.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Workspace-relative path of the file to read.' } },
            required: ['path'],
          },
        },
      },
      handler: async (args) => {
        const p = resolve(String(args.path));
        const bytes = await storage.readBytes(p);
        const view = bytes.byteLength > READ_FILE_MAX_BYTES ? bytes.slice(0, READ_FILE_MAX_BYTES) : bytes;
        if (view.includes(0)) throw new Error(`"${args.path}" appears to be a binary file.`);
        const text = new TextDecoder().decode(view);
        return bytes.byteLength > READ_FILE_MAX_BYTES
          ? text + `\n... (truncated, file is ${bytes.byteLength} bytes)`
          : text;
      },
    },
    {
      name: 'Write File',
      definition: {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write content to a file in the workspace. Overwrites existing files.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Workspace-relative path of the file to write.' },
              content: { type: 'string', description: 'The content to write.' },
            },
            required: ['path', 'content'],
          },
        },
      },
      handler: async (args) => {
        const p = resolve(String(args.path));
        await storage.writeText(p, String(args.content));
        return `File written: ${args.path}`;
      },
    },
    {
      name: 'List Directory',
      definition: {
        type: 'function',
        function: {
          name: 'list_dir',
          description: 'List immediate children of a workspace directory. Directories end with "/".',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Workspace-relative directory path ("" for root).' } },
            required: ['path'],
          },
        },
      },
      handler: async (args) => {
        const p = resolve(String(args.path ?? ''));
        const entries = await storage.list(p);
        // mark directories with trailing slash (stat succeeds only for files)
        const marked = await Promise.all(entries.map(async (e) => {
          try { await storage.stat(`${p}/${e}`); return e; } catch { return e + '/'; }
        }));
        return JSON.stringify(marked);
      },
    },
    {
      name: 'Grep',
      definition: {
        type: 'function',
        function: {
          name: 'grep',
          description: 'Search workspace text files for a regex pattern. Returns path:line:content matches (max 50).',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Regular expression to search for.' },
              path: { type: 'string', description: 'Workspace-relative dir to search ("" or "." for whole workspace).' },
            },
            required: ['pattern'],
          },
        },
      },
      handler: async (args) => {
        const base = resolve(String(args.path ?? '.'));
        let re: RegExp;
        try {
          re = new RegExp(String(args.pattern));
        } catch (e) {
          return `Error: invalid pattern: ${(e as Error).message}`;
        }
        const matches: string[] = [];
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await storage.list(dir)) {
            if (matches.length >= 50) return;
            const child = `${dir}/${entry}`;
            try {
              await storage.stat(child); // file
              const text = await storage.readText(child).catch(() => null);
              if (text === null) continue;
              text.split('\n').forEach((line, i) => {
                if (matches.length < 50 && re.test(line)) {
                  matches.push(`${child.slice(WORKSPACE_ROOT.length + 1)}:${i + 1}:${line}`);
                }
              });
            } catch {
              await walk(child); // directory
            }
          }
        };
        await walk(base);
        return matches.length ? matches.join('\n') : 'No matches.';
      },
    },
  ];
}
