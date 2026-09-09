# Offline In-Browser AutoClaw PWA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully offline PWA that chats with AutoClaw-style agents powered by an in-browser SLM (`Qwen3.5-0.8B-Q5_K_M.gguf`) with dynamically swappable LoRA adapters, all data in a user-granted folder.

**Architecture:** AutoClaw's portable core (`agent.ts` loop, tool interface, skills, retry, truncate) is vendored into `src/agent-core/` and adapted: the OpenAI SDK is replaced by an injected `ChatModel` seam (backed by wllama v3's OpenAI-compatible, tool-calling API in a Web Worker), and all filesystem access goes through a `StorageProvider` (File System Access API primary, OPFS fallback). Browser-native tools implement AutoClaw's `ToolModule` contract.

**Tech Stack:** React 18+ / Vite / TypeScript, vitest, @wllama/wllama v3 (WebGPU + WASM), vite-plugin-pwa, Playwright (e2e). Upstream reference clone: `/tmp/autoclaw-upstream` (re-clone with `git clone --depth 1 https://github.com/tsingliuwin/autoclaw /tmp/autoclaw-upstream` if missing).

**Spec:** `docs/superpowers/specs/2026-09-09-offline-autoclaw-pwa-design.md`

---

## File Structure

```
index.html, package.json, tsconfig.json, vite.config.ts
public/                         # icons, manifest.webmanifest, builtin skills assets
src/
  agent-core/                   # vendored + adapted AutoClaw core (MIT, see NOTICE)
    NOTICE                      # provenance + LICENSE text
    events.ts                   # NEW: AgentEventSink — replaces console/ora/chalk output
    chat-model.ts               # NEW: ChatModel interface — replaces OpenAI SDK
    storage.ts                  # NEW: StorageProvider interface
    agent.ts                    # vendored from upstream src/agent.ts, adapted (Task 5)
    retry.ts                    # vendored verbatim
    truncate.ts                 # vendored, Buffer.byteLength → TextEncoder
    providers.ts                # vendored verbatim
    safety.ts                   # vendored DANGEROUS_PATTERNS + path guards, adapted
    skills.ts                   # vendored parser/manifest; discovery via StorageProvider
    tools/
      interface.ts              # vendored verbatim
      index.ts                  # NEW registry (browser tools only)
      fs-tools.ts               # NEW: read_file, write_file, list_dir, grep
      datetime.ts               # vendored get_current_datetime
      web-fetch.ts              # NEW: fetch-based, online-only registration
      render-html.ts            # NEW: canvas/SVG renderer
  storage/
    opfs.ts                     # OpfsStorage implements StorageProvider
    fs-access.ts                # FileSystemAccessStorage implements StorageProvider
    handle-store.ts             # IndexedDB persistence of the directory handle
    index.ts                    # pickStorage(): FS Access → OPFS fallback
  llm/
    protocol.ts                 # worker request/response message types
    wllama-worker.ts            # Web Worker hosting @wllama/wllama
    shim.ts                     # WllamaChatModel implements ChatModel over the worker
  adapters/
    manager.ts                  # adapter registry, load/switch via worker
  setup/
    download.ts                 # resumable download → StorageProvider
    SetupWizard.tsx             # pick folder → download model + adapters
  ui/
    App.tsx, ChatView.tsx, ToolTrace.tsx, ConfirmDialog.tsx, StatusBar.tsx
  main.tsx
tests/                          # vitest unit tests mirror src/ paths: tests/agent-core/... etc.
e2e/offline.spec.ts             # Playwright: offline round-trip
```

**Test conventions:** vitest, `npm test`. Tests never touch the network or real GPU; wllama is mocked, StorageProvider is an in-memory fake. E2e (Playwright) is the only place a real (tiny) GGUF is loaded.

**Key upstream facts this plan relies on** (verified against `/tmp/autoclaw-upstream`, v1.3.7):
- `agent.ts` uses exactly one LLM call: `client.chat.completions.create({model, messages, tools, tool_choice:"auto", stream:true}, {signal})` consumed as `AsyncIterable` of chunks with `choices[0].delta.{content,reasoning_content,tool_calls}` and optional `chunk.usage`.
- `ToolModule` = `{ name, configKeys?, definition: ToolDefinition, handler: (args, config?) => Promise<string>, isAvailable?: (config) => boolean }` (`src/tools/interface.ts`, portable verbatim).
- Registry functions: `getToolDefinitions(config)`, `listUnavailableTools(config)`, `executeToolHandler(name, args, config)` — static array registry, no dynamic requires.
- Portable verbatim: `retry.ts`, `providers.ts`, `tools/interface.ts`. `truncate.ts` needs only `Buffer.byteLength` → `TextEncoder`. `skills.ts` parser/manifest are pure; its discovery uses sync `fs` and must be re-driven over `StorageProvider`.
- wllama v3 `createChatCompletion({messages, tools, tool_choice, stream})` returns the same OpenAI shapes, so the shim is a pass-through over `postMessage`.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/ui/App.tsx`, `tests/smoke.test.ts`, `.gitignore`

- [ ] **Step 1: Scaffold the Vite app**

```bash
npm create vite@latest . -- --template react-ts
npm install
npm i @wllama/wllama idb-keyval
npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom vite-plugin-pwa playwright @playwright/test
```

- [ ] **Step 2: Configure vitest and path alias**

In `vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'AutoClaw Offline Agents',
        short_name: 'AutoClaw',
        display: 'standalone',
        start_url: '/',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  resolve: { alias: { '@core': path.resolve(__dirname, 'src/agent-core') } },
  // wllama multi-threading requires cross-origin isolation
  server: { headers: { 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Opener-Policy': 'same-origin' } },
  preview: { headers: { 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Opener-Policy': 'same-origin' } },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'] },
});
```

Add to `package.json` scripts: `"test": "vitest run"`, `"e2e": "playwright test"`.

In `tsconfig.json` `compilerOptions` add: `"paths": { "@core/*": ["./src/agent-core/*"] }`, `"types": ["vite/client", "vitest/globals"]`, and `"lib": ["ES2022", "DOM", "DOM.Iterable"]`.

- [ ] **Step 3: Write the smoke test**

`tests/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('vitest runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Verify**

Run: `npm test` — Expected: 1 passed.
Run: `npm run build` — Expected: builds without errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold Vite+React+TS PWA with vitest and wllama deps"
```

---

## Task 2: StorageProvider interface + in-memory fake + OPFS backend

The storage contract every other module depends on. Paths are POSIX-style relative strings (`"models/foo.gguf"`); backends resolve them against their root.

**Files:**
- Create: `src/agent-core/storage.ts`, `src/storage/opfs.ts`, `tests/helpers/fake-storage.ts`, `tests/storage/opfs.test.ts`

- [ ] **Step 1: Write the failing test for the interface contract (against the fake)**

`tests/helpers/fake-storage.ts`:

```ts
import type { StorageProvider, FileStat } from '@core/storage';

export class FakeStorage implements StorageProvider {
  readonly kind = 'fake' as const;
  private files = new Map<string, Uint8Array>();

  async readText(path: string): Promise<string> {
    const b = this.files.get(path);
    if (!b) throw new Error(`ENOENT: ${path}`);
    return new TextDecoder().decode(b);
  }
  async readBytes(path: string): Promise<Uint8Array> {
    const b = this.files.get(path);
    if (!b) throw new Error(`ENOENT: ${path}`);
    return b;
  }
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }
  async writeText(path: string, text: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(text));
  }
  async appendText(path: string, text: string): Promise<void> {
    const prev = this.files.has(path) ? await this.readText(path) : '';
    await this.writeText(path, prev + text);
  }
  async exists(path: string): Promise<boolean> {
    if (this.files.has(path)) return true;
    const prefix = path.endsWith('/') ? path : path + '/';
    return [...this.files.keys()].some((k) => k.startsWith(prefix));
  }
  async stat(path: string): Promise<FileStat> {
    const b = this.files.get(path);
    if (!b) throw new Error(`ENOENT: ${path}`);
    return { size: b.byteLength, mtimeMs: 0 };
  }
  async list(dir: string): Promise<string[]> {
    const prefix = dir === '' ? '' : dir.endsWith('/') ? dir : dir + '/';
    const out = new Set<string>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      out.add(rest.split('/')[0]);
    }
    return [...out].sort();
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}
```

`tests/storage/opfs.test.ts` (contract suite reused by all backends):

```ts
import { describe, it, expect } from 'vitest';
import type { StorageProvider } from '@core/storage';
import { FakeStorage } from '../helpers/fake-storage';

export function storageContract(name: string, make: () => Promise<StorageProvider>) {
  describe(`StorageProvider contract: ${name}`, () => {
    it('writes and reads text', async () => {
      const s = await make();
      await s.writeText('a/b.txt', 'hello');
      expect(await s.readText('a/b.txt')).toBe('hello');
    });
    it('exists() is true for files and ancestor dirs, false otherwise', async () => {
      const s = await make();
      await s.writeText('a/b/c.txt', 'x');
      expect(await s.exists('a/b/c.txt')).toBe(true);
      expect(await s.exists('a/b')).toBe(true);
      expect(await s.exists('a/nope')).toBe(false);
    });
    it('list() returns immediate children only, sorted', async () => {
      const s = await make();
      await s.writeText('w/f1.txt', '1');
      await s.writeText('w/sub/f2.txt', '2');
      expect(await s.list('w')).toEqual(['f1.txt', 'sub']);
    });
    it('appendText appends', async () => {
      const s = await make();
      await s.writeText('l.jsonl', '{"a":1}\n');
      await s.appendText('l.jsonl', '{"b":2}\n');
      expect(await s.readText('l.jsonl')).toBe('{"a":1}\n{"b":2}\n');
    });
    it('stat reports byte size; remove deletes', async () => {
      const s = await make();
      await s.writeText('f.bin', 'abcd');
      expect((await s.stat('f.bin')).size).toBe(4);
      await s.remove('f.bin');
      expect(await s.exists('f.bin')).toBe(false);
    });
  });
}

storageContract('FakeStorage', async () => new FakeStorage());
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` — Expected: FAIL (`Cannot find module '@core/storage'`).

- [ ] **Step 3: Write the interface**

`src/agent-core/storage.ts`:

```ts
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
```

- [ ] **Step 4: Run the contract against FakeStorage**

Run: `npm test tests/storage/opfs.test.ts` — Expected: PASS (fake satisfies contract).

- [ ] **Step 5: Add the OPFS backend and register it with the same contract**

Append to `tests/storage/opfs.test.ts`:

```ts
import 'fake-indexeddb/auto'; // not needed for OPFS; placeholder if jsdom lacks OPFS
import { OpfsStorage } from '../../src/storage/opfs';

// jsdom has no OPFS; this suite runs in Playwright (Task 16) or a browser-capable runner.
// Locally it is skipped.
const hasOpfs = typeof navigator !== 'undefined' && !!(navigator as any).storage?.getDirectory;
(hasOpfs ? describe : describe.skip)('OpfsStorage', () => {
  storageContract('OPFS', () => OpfsStorage.create());
});
```

`src/storage/opfs.ts`:

```ts
import type { StorageProvider, FileStat } from '@core/storage';

export class OpfsStorage implements StorageProvider {
  readonly kind = 'opfs' as const;
  private constructor(private root: FileSystemDirectoryHandle) {}

  static async create(): Promise<OpfsStorage> {
    const root = await (navigator as any).storage.getDirectory();
    return new OpfsStorage(root);
  }

  private async dirHandle(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    let dir = this.root;
    for (const seg of path.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(seg, { create });
    }
    return dir;
  }

  private split(path: string): { dir: string; name: string } {
    const i = path.lastIndexOf('/');
    return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
  }

  private async fileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
    const { dir, name } = this.split(path);
    const d = await this.dirHandle(dir, create);
    return d.getFileHandle(name, { create });
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const fh = await this.fileHandle(path);
    const f = await fh.getFile();
    return new Uint8Array(await f.arrayBuffer());
  }
  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    const fh = await this.fileHandle(path, true);
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }
  async writeText(path: string, text: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(text));
  }
  async appendText(path: string, text: string): Promise<void> {
    const prev = (await this.exists(path)) ? await this.readText(path) : '';
    await this.writeText(path, prev + text);
  }
  async exists(path: string): Promise<boolean> {
    try {
      const { dir, name } = this.split(path);
      const d = await this.dirHandle(dir);
      try { await d.getFileHandle(name); return true; } catch { /* not a file */ }
      try { await d.getDirectoryHandle(name); return true; } catch { return false; }
    } catch { return false; }
  }
  async stat(path: string): Promise<FileStat> {
    const f = await (await this.fileHandle(path)).getFile();
    return { size: f.size, mtimeMs: f.lastModified };
  }
  async list(dir: string): Promise<string[]> {
    const d = await this.dirHandle(dir);
    const out: string[] = [];
    for await (const key of (d as any).keys()) out.push(key);
    return out.sort();
  }
  async remove(path: string): Promise<void> {
    const { dir, name } = this.split(path);
    const d = await this.dirHandle(dir);
    await d.removeEntry(name);
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npm test` — Expected: PASS (OPFS suite skipped under jsdom).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: StorageProvider interface, in-memory fake, OPFS backend"
```

---

## Task 3: File System Access backend + handle persistence

**Files:**
- Create: `src/storage/fs-access.ts`, `src/storage/handle-store.ts`, `src/storage/index.ts`, `tests/storage/fs-access.test.ts`

- [ ] **Step 1: Write the failing test (mocked FS Access API)**

`tests/storage/fs-access.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystemAccessStorage } from '../../src/storage/fs-access';
import { storageContract } from './opfs.test'; // re-export the contract suite
import { FakeStorage } from '../helpers/fake-storage';

// Minimal in-memory FileSystemDirectoryHandle mock
class MockFileHandle {
  constructor(private store: Map<string, Uint8Array>, private key: string) {}
  async getFile() {
    const b = this.store.get(this.key);
    if (!b) throw new DOMException('not found', 'NotFoundError');
    return { size: b.byteLength, lastModified: 0, arrayBuffer: async () => b.buffer.slice(0) };
  }
  async createWritable() {
    const store = this.store, key = this.key;
    const chunks: Uint8Array[] = [];
    return {
      async write(d: Uint8Array) { chunks.push(d); },
      async close() {
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.byteLength; }
        store.set(key, out);
      },
    };
  }
}
class MockDirHandle {
  kind = 'directory' as const;
  constructor(private prefix: string, private store: Map<string, Uint8Array>) {}
  private childKey(name: string) { return this.prefix ? `${this.prefix}/${name}` : name; }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    const key = this.childKey(name) + '/';
    const exists = [...this.store.keys()].some((k) => k.startsWith(key));
    if (!exists && !opts?.create) throw new DOMException('not found', 'NotFoundError');
    return new MockDirHandle(this.childKey(name), this.store);
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    const key = this.childKey(name);
    if (!this.store.has(key) && !opts?.create) throw new DOMException('not found', 'NotFoundError');
    return new MockFileHandle(this.store, key);
  }
  async removeEntry(name: string) { this.store.delete(this.childKey(name)); }
  async *keys(): AsyncIterable<string> {
    const out = new Set<string>();
    const prefix = this.prefix ? this.prefix + '/' : '';
    for (const k of this.store.keys()) {
      if (!k.startsWith(prefix)) continue;
      out.add(k.slice(prefix.length).split('/')[0]);
    }
    yield* [...out].sort();
  }
}

const store = new Map<string, Uint8Array>();
storageContract('FileSystemAccessStorage', async () =>
  FileSystemAccessStorage.fromHandle(new MockDirHandle('', store) as unknown as FileSystemDirectoryHandle),
);

describe('FileSystemAccessStorage specifics', () => {
  beforeEach(() => store.clear());
  it('exposes kind fs-access', async () => {
    const s = FileSystemAccessStorage.fromHandle(new MockDirHandle('', store) as any);
    expect(s.kind).toBe('fs-access');
  });
});
```

Note: `storageContract` must be exported from `tests/storage/opfs.test.ts` (add `export` — it already is in Task 2). Vitest will run contract tests twice via import; acceptable.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/storage/fs-access.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement the backend**

`src/storage/fs-access.ts` — same method bodies as `OpfsStorage` in Task 2 Step 5, with two changes: constructor takes an externally supplied root handle, and `kind` is `'fs-access'`:

```ts
import type { StorageProvider, FileStat } from '@core/storage';

export class FileSystemAccessStorage implements StorageProvider {
  readonly kind = 'fs-access' as const;
  private constructor(private root: FileSystemDirectoryHandle) {}

  static fromHandle(root: FileSystemDirectoryHandle): FileSystemAccessStorage {
    return new FileSystemAccessStorage(root);
  }

  static async pickAndCreate(): Promise<FileSystemAccessStorage> {
    const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
    return new FileSystemAccessStorage(handle);
  }

  // dirHandle/split/fileHandle/readBytes/readText/writeBytes/writeText/appendText/
  // exists/stat/list/remove: identical to OpfsStorage (Task 2 Step 5) — factor both
  // classes over a shared `HandleStorage` base class taking the root handle.
}
```

Refactor note for the implementer: make `OpfsStorage` and `FileSystemAccessStorage` thin wrappers over one `HandleStorage implements StorageProvider` base that holds a `FileSystemDirectoryHandle`; the only differences are `kind` and how the root is obtained. `tests/storage/opfs.test.ts` keeps passing unchanged.

- [ ] **Step 4: Handle persistence + backend selection**

`src/storage/handle-store.ts`:

```ts
import { get, set, del } from 'idb-keyval';

const KEY = 'autoclaw.dirHandle';

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
```

`src/storage/index.ts`:

```ts
import type { StorageProvider } from '@core/storage';
import { FileSystemAccessStorage } from './fs-access';
import { OpfsStorage } from './opfs';
import { loadHandle, queryPermission } from './handle-store';

export function fsAccessSupported(): boolean {
  return typeof (window as any).showDirectoryPicker === 'function';
}

/** Restore storage from a previously picked folder, or null if user action is needed. */
export async function restoreStorage(): Promise<StorageProvider | null> {
  if (fsAccessSupported()) {
    const handle = await loadHandle();
    if (handle && (await queryPermission(handle)) === 'granted') {
      return FileSystemAccessStorage.fromHandle(handle);
    }
    return null; // UI must show the re-grant / pick-folder flow
  }
  return OpfsStorage.create(); // fallback: no user action needed
}
```

- [ ] **Step 5: Run tests**

Run: `npm test` — Expected: all PASS, including the FileSystemAccessStorage contract via mock.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: File System Access storage backend with persisted folder handle"
```

---

## Task 4: Vendor the pure portable modules

Copy verbatim from `/tmp/autoclaw-upstream`, with the one documented fix. These files carry upstream's vitest tests — port them too, unchanged except import paths.

**Files:**
- Create: `src/agent-core/NOTICE`, `src/agent-core/retry.ts`, `src/agent-core/providers.ts`, `src/agent-core/truncate.ts`, `src/agent-core/tools/interface.ts`
- Create: `tests/agent-core/retry.test.ts`, `tests/agent-core/providers.test.ts`, `tests/agent-core/truncate.test.ts`

- [ ] **Step 1: Copy files and port tests**

```bash
mkdir -p src/agent-core/tools tests/agent-core
cp /tmp/autoclaw-upstream/LICENSE src/agent-core/NOTICE
printf '\nFiles in this directory are vendored from https://github.com/tsingliuwin/autoclaw (MIT).\nAdaptations are marked with "// BROWSER-ADAPTED:" comments.\n' >> src/agent-core/NOTICE
cp /tmp/autoclaw-upstream/src/retry.ts src/agent-core/retry.ts
cp /tmp/autoclaw-upstream/src/providers.ts src/agent-core/providers.ts
cp /tmp/autoclaw-upstream/src/truncate.ts src/agent-core/truncate.ts
cp /tmp/autoclaw-upstream/src/tools/interface.ts src/agent-core/tools/interface.ts
cp /tmp/autoclaw-upstream/src/retry.test.ts tests/agent-core/retry.test.ts
cp /tmp/autoclaw-upstream/src/providers.test.ts tests/agent-core/providers.test.ts
cp /tmp/autoclaw-upstream/src/truncate.test.ts tests/agent-core/truncate.test.ts
```

Fix import paths in the copied tests (`./retry.js` → `../../src/agent-core/retry`, etc.). In `src/agent-core/retry.ts` and `truncate.ts`, remove nothing else; `.js`-suffixed imports are fine for Vite.

- [ ] **Step 2: Run tests to verify the Buffer failure**

Run: `npm test tests/agent-core` — Expected: `truncate.test.ts` FAILS with `Buffer is not defined`; retry and providers PASS.

- [ ] **Step 3: Apply the browser fix to truncate.ts**

In `src/agent-core/truncate.ts`, add at top:

```ts
// BROWSER-ADAPTED: Buffer.byteLength replacement
const byteLength = (s: string): number => new TextEncoder().encode(s).length;
```

Replace both `Buffer.byteLength(content, 'utf8')` occurrences (upstream truncate.ts:25,38) with `byteLength(content)`.

- [ ] **Step 4: Run tests**

Run: `npm test tests/agent-core` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: vendored autoclaw retry/providers/truncate/tool-interface (MIT)"
```

---

## Task 5: ChatModel + AgentEventSink seams, vendored agent loop

The core adaptation: `agent.ts` is rebuilt around two injected seams so it never touches the OpenAI SDK, console, or Node.

**Files:**
- Create: `src/agent-core/chat-model.ts`, `src/agent-core/events.ts`, `src/agent-core/agent.ts`
- Test: `tests/agent-core/agent.test.ts` (ported from upstream, running against a `FakeChatModel`)

- [ ] **Step 1: Define the seams**

`src/agent-core/chat-model.ts`:

```ts
// The LLM seam. WllamaChatModel (src/llm/shim.ts) implements this over the
// wllama worker; tests use FakeChatModel. Shapes mirror OpenAI chat completions.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatChunkDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export interface ChatChunk {
  choices: Array<{ delta: ChatChunkDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: 'auto';
  stream: true;
}

export interface ChatModel {
  createChatCompletionStream(
    params: ChatCompletionParams,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<ChatChunk>>;
}
```

`src/agent-core/events.ts`:

```ts
// Replaces console/ora/chalk output in upstream agent.ts.
// Event shapes match upstream's --json NDJSON events exactly.

import type { AgentRunResult, AgentUsage } from './agent';

export type AgentEvent =
  | { event: 'run_start'; model: string; task: string }
  | { event: 'token'; text: string }                       // streaming assistant text
  | { event: 'tool_call'; step: number; tool: string; args: unknown }
  | { event: 'tool_result'; step: number; tool: string; truncated: boolean; bytes: number; output_file?: string }
  | { event: 'usage'; step: number } & AgentUsage
  | { event: 'confirm_request'; id: string; tool: string; args: unknown; reason: string }
  | { event: 'run_end' } & AgentRunResult;

export type AgentEventSink = (e: AgentEvent) => void;
```

- [ ] **Step 2: Port the upstream agent tests against FakeChatModel**

`tests/helpers/fake-chat-model.ts`:

```ts
import type { ChatModel, ChatCompletionParams, ChatChunk, ChatMessage } from '@core/chat-model';

/** Scriptable model: each call pops one scripted turn. */
export class FakeChatModel implements ChatModel {
  turns: Array<{ content?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }> = [];
  received: ChatCompletionParams[] = [];

  async createChatCompletionStream(params: ChatCompletionParams): Promise<AsyncIterable<ChatChunk>> {
    this.received.push(structuredClone(params));
    const turn = this.turns.shift() ?? { content: '(no scripted turn)' };
    async function* gen(): AsyncIterable<ChatChunk> {
      if (turn.content) {
        for (const ch of turn.content.match(/.{1,8}/gs) ?? []) {
          yield { choices: [{ delta: { content: ch } }] };
        }
      }
      if (turn.toolCalls) {
        yield {
          choices: [{
            delta: {
              tool_calls: turn.toolCalls.map((tc, i) => ({
                index: i, id: tc.id,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            },
            finish_reason: 'tool_calls',
          }],
        };
      } else {
        yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      }
    }
    return gen();
  }
}
```

Port upstream `agent.test.ts` (20 KB, at `/tmp/autoclaw-upstream/src/agent.test.ts`) into `tests/agent-core/agent.test.ts`, replacing its OpenAI-mock with `FakeChatModel` and its console assertions with collected `AgentEvent`s. Key cases to keep (names from upstream): streams assistant text, executes a tool call and feeds the result back, stops at max steps with status `max_steps`, returns `timeout` when the abort signal fires, truncates large tool output, retries retryable errors, repeat-loop guard escalates after 3 identical calls, malformed tool arguments are fed back as a tool error message.

- [ ] **Step 3: Run to verify failure**

Run: `npm test tests/agent-core/agent.test.ts` — Expected: FAIL (no `src/agent-core/agent.ts`).

- [ ] **Step 4: Vendor and adapt agent.ts**

Copy `/tmp/autoclaw-upstream/src/agent.ts` → `src/agent-core/agent.ts` and apply these adaptations (each marked `// BROWSER-ADAPTED`):

1. **Imports** — delete `openai`, `chalk`, `ora`, `fs`, `os`, `path`, `util`, `./shell.js`. Import `ChatModel`, `ChatMessage` from `./chat-model`, `AgentEventSink` from `./events`, storage type from `./storage`.
2. **Constructor** becomes:
   ```ts
   constructor(
     private llm: ChatModel,
     model: string,
     config: any,
     private storage: StorageProvider,
     private emit: AgentEventSink = () => {},
   )
   ```
   (No `apiKey`/`baseURL` — the shim owns the model.)
3. **System prompt info block** (upstream lines 63–73) — replace OS/shell/home/user lines with:
   ```ts
   const sysInfo = [
     `Platform: browser (PWA, offline-capable)`,
     `User-Agent: ${navigator.userAgent}`,
     `Workspace root: the app's virtual filesystem (paths are relative)`,
     `Current date/time: ${new Date().toString()}`,
   ].join('\n');
   ```
4. **LLM call** (upstream 207–223) — replace `this.client.chat.completions.create(...)` with `this.llm.createChatCompletionStream({ model: this.model, messages: this.messages, tools: getToolDefinitions(this.config), tool_choice: 'auto', stream: true }, { signal })`, still wrapped in `withRetry`.
5. **All console/ora/chalk output** — delete; instead call `this.emit({...})` with the matching `AgentEvent`. Streaming assistant text emits `{ event: 'token', text }` per delta. The `emitEvent` NDJSON path and `runToolQuietly` monkey-patch are deleted (events replace both).
6. **`process.env.AUTOCLOW_MAX_STEPS` / `AUTOCLOW_TASK_TIMEOUT_MS`** (upstream 158–159) — read from `config.maxSteps` / `config.taskTimeoutMs` only.
7. **Run log** (upstream 465–483) — replace `fs.appendFileSync(~/.autoclaw/logs/runs.jsonl)` with `await this.storage.appendText('cache/runs.jsonl', line)`.
8. **Large-output spill** (upstream 504–513) — replace with `await this.storage.writeText('cache/outputs/' + filename, full)`, `output_file` in the `tool_result` event becomes that relative path.
9. Keep: the tool loop, `withRetry`, `truncateOutput`, `trimOldToolResults`, repeat-loop guard, step cap, deadline + AbortController timeout, `AgentUsage`/`AgentRunResult` exports.

- [ ] **Step 5: Run tests**

Run: `npm test tests/agent-core/agent.test.ts` — Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: vendored agent loop adapted to ChatModel/EventSink/StorageProvider seams"
```

---

## Task 6: Safety module (destructive-action gate for the virtual workspace)

**Files:**
- Create: `src/agent-core/safety.ts`
- Test: `tests/agent-core/safety.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/agent-core/safety.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { matchDangerousPattern, isWorkspacePath, needsConfirmation } from '../../src/agent-core/safety';

describe('matchDangerousPattern (vendored)', () => {
  it('flags rm -rf', () => expect(matchDangerousPattern('rm -rf /')).toBeTruthy());
  it('passes ls', () => expect(matchDangerousPattern('ls -la')).toBeNull());
});

describe('isWorkspacePath', () => {
  it('accepts relative in-workspace paths', () => {
    expect(isWorkspacePath('notes/a.md')).toBe(true);
  });
  it('rejects traversal and absolute paths', () => {
    expect(isWorkspacePath('../secrets')).toBe(false);
    expect(isWorkspacePath('/etc/passwd')).toBe(false);
    expect(isWorkspacePath('a/../../b')).toBe(false);
  });
});

describe('needsConfirmation', () => {
  it('write/delete tools need confirmation unless autoConfirm', () => {
    expect(needsConfirmation('write_file', {}, { autoConfirm: false })).toBe(true);
    expect(needsConfirmation('write_file', {}, { autoConfirm: true })).toBe(false);
    expect(needsConfirmation('read_file', {}, { autoConfirm: false })).toBe(false);
  });
  it('dangerous args always need confirmation even with autoConfirm', () => {
    expect(needsConfirmation('write_file', { path: '../x' }, { autoConfirm: true })).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/agent-core/safety.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/agent-core/safety.ts`:

```ts
// DANGEROUS_PATTERNS vendored from upstream src/tools/core.ts:20-35 (copy the
// array verbatim). Shell commands don't exist in the browser build, but the
// matcher is reused to flag dangerous *arguments* (paths, code strings).

export const DANGEROUS_PATTERNS: RegExp[] = [
  // VENDOR: paste the exact array from /tmp/autoclaw-upstream/src/tools/core.ts lines 20-35
];

export function matchDangerousPattern(input: string): RegExp | null {
  for (const re of DANGEROUS_PATTERNS) if (re.test(input)) return re;
  return null;
}

/** POSIX-normalize and confine to the virtual workspace. */
export function isWorkspacePath(p: string): boolean {
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return false;
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  let depth = 0;
  for (const part of parts) {
    if (part === '..') { if (--depth < 0) return false; } else depth++;
  }
  return true;
}

const WRITE_TOOLS = new Set(['write_file', 'delete_file', 'render_html']);

export function needsConfirmation(tool: string, args: any, config: any): boolean {
  const argsStr = JSON.stringify(args ?? {});
  if (matchDangerousPattern(argsStr) || (args?.path && !isWorkspacePath(args.path))) return true;
  if (WRITE_TOOLS.has(tool)) return !config?.autoConfirm;
  return false;
}
```

Wire-in (in `src/agent-core/tools/index.ts`, Task 7): before executing a handler, if `needsConfirmation(name, args, config)`, emit `confirm_request` via the sink stored in `config._emit` and await `config._confirm(id)`; a rejection returns `Error: action denied by user` as the tool result.

- [ ] **Step 4: Run tests** — `npm test tests/agent-core/safety.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: safety gates for virtual workspace (dangerous patterns, path confinement, confirmations)"
```

---

## Task 7: Browser tool pack — filesystem tools + registry

**Files:**
- Create: `src/agent-core/tools/fs-tools.ts`, `src/agent-core/tools/index.ts`
- Test: `tests/agent-core/tools/fs-tools.test.ts`, `tests/agent-core/tools/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/agent-core/tools/fs-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeStorage } from '../../helpers/fake-storage';
import { makeFsTools, WORKSPACE_ROOT } from '../../../src/agent-core/tools/fs-tools';

let storage: FakeStorage;
let tools: ReturnType<typeof makeFsTools>;
const config: any = {};

beforeEach(async () => {
  storage = new FakeStorage();
  tools = makeFsTools(storage);
});

function handler(name: string) {
  const t = tools.find((t) => t.definition.function.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t.handler;
}

describe('read_file / write_file', () => {
  it('round-trips utf-8 content under the workspace root', async () => {
    expect(await handler('write_file')({ path: 'notes/a.md', content: 'hi' }, config)).toContain('notes/a.md');
    expect(await storage.readText(`${WORKSPACE_ROOT}/notes/a.md`)).toBe('hi');
    expect(await handler('read_file')({ path: 'notes/a.md' }, config)).toBe('hi');
  });
  it('rejects paths escaping the workspace', async () => {
    await expect(handler('write_file')({ path: '../evil', content: 'x' }, config)).rejects.toThrow(/outside/i);
  });
  it('read_file caps at 1 MiB like upstream', async () => {
    await storage.writeText(`${WORKSPACE_ROOT}/big.txt`, 'x'.repeat(1024 * 1024 + 10));
    const out = await handler('read_file')({ path: 'big.txt' }, config);
    expect(out).toContain('truncated');
  });
});

describe('list_dir', () => {
  it('lists immediate children of a workspace dir', async () => {
    await storage.writeText(`${WORKSPACE_ROOT}/d/f1.txt`, '1');
    await storage.writeText(`${WORKSPACE_ROOT}/d/sub/f2.txt`, '2');
    const out = JSON.parse(await handler('list_dir')({ path: 'd' }, config));
    expect(out).toEqual(['f1.txt', 'sub/']);
  });
});

describe('grep', () => {
  it('returns path:line matches', async () => {
    await storage.writeText(`${WORKSPACE_ROOT}/a.txt`, 'foo\nbar\n');
    await storage.writeText(`${WORKSPACE_ROOT}/b/c.txt`, 'bar baz\n');
    const out = await handler('grep')({ pattern: 'bar', path: '.' }, config);
    expect(out).toContain('a.txt:2:bar');
    expect(out).toContain('b/c.txt:1:bar baz');
  });
});
```

`tests/agent-core/tools/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FakeStorage } from '../../helpers/fake-storage';
import { buildToolRegistry, getToolDefinitions, executeToolHandler, listUnavailableTools } from '../../../src/agent-core/tools';

describe('registry', () => {
  it('lists browser tools and gates web_fetch offline', () => {
    buildToolRegistry(new FakeStorage(), { online: false });
    const names = getToolDefinitions({}).map((d) => d.function.name);
    expect(names).toContain('read_file');
    expect(names).toContain('grep');
    expect(names).toContain('get_current_datetime');
    expect(names).not.toContain('web_fetch');
    expect(listUnavailableTools({})).toContain('web_fetch');
  });
  it('executeToolHandler dispatches and reports unknown tools', async () => {
    buildToolRegistry(new FakeStorage(), {});
    const out = await executeToolHandler('nope_tool', {}, {});
    expect(out).toMatch(/Error: Tool nope_tool not found/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/agent-core/tools` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement fs-tools.ts**

`src/agent-core/tools/fs-tools.ts`:

```ts
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
        if (bytes.byteLength > READ_FILE_MAX_BYTES) {
          return new TextDecoder().decode(bytes.slice(0, READ_FILE_MAX_BYTES)) +
            `\n... (truncated, file is ${bytes.byteLength} bytes)`;
        }
        if (bytes.includes(0)) throw new Error(`"${args.path}" appears to be a binary file.`);
        return new TextDecoder().decode(bytes);
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
        const re = new RegExp(String(args.pattern));
        const matches: string[] = [];
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await storage.list(dir)) {
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
```

(Implementer note: `list_dir` distinguishes files from directories by attempting `stat` — stat succeeds only for files.)

- [ ] **Step 4: Implement the registry**

`src/agent-core/tools/index.ts`:

```ts
import type { StorageProvider } from '../storage';
import type { ToolModule, ToolDefinition } from './interface';
import { makeFsTools } from './fs-tools';
import { makeDateTimeTool } from './datetime';
import { makeWebFetchTool } from './web-fetch';
import { makeRenderHtmlTool } from './render-html';

let toolRegistry: ToolModule[] = [];

export interface ToolBuildOptions { online?: boolean; }

export function buildToolRegistry(storage: StorageProvider, opts: ToolBuildOptions = {}): ToolModule[] {
  toolRegistry = [
    ...makeFsTools(storage),
    makeDateTimeTool(),
    makeWebFetchTool(),
    makeRenderHtmlTool(storage),
  ];
  (toolRegistry as any)._online = opts.online ?? (typeof navigator !== 'undefined' ? navigator.onLine : false);
  return toolRegistry;
}

// Same contract as upstream tools/index.ts:34-52
export function getToolDefinitions(config?: any): ToolDefinition[] {
  return toolRegistry.filter((t) => !t.isAvailable || t.isAvailable(config)).map((t) => t.definition);
}
export function listUnavailableTools(config?: any): string[] {
  return toolRegistry.filter((t) => t.isAvailable && !t.isAvailable(config)).map((t) => t.definition.function.name);
}
export async function executeToolHandler(name: string, args: any, fullConfig: any): Promise<string> {
  const tool = toolRegistry.find((t) => t.definition.function.name === name);
  if (!tool) return `Error: Tool ${name} not found.`;
  if (tool.isAvailable && !tool.isAvailable(fullConfig)) return `Error: Tool ${name} is not configured.`;
  return tool.handler(args, fullConfig);
}
```

- [ ] **Step 5: Stub the remaining tool factories** so this task compiles — real bodies land in Tasks 8–9:

`src/agent-core/tools/datetime.ts`: vendor `DateTimeTool` from `/tmp/autoclaw-upstream/src/tools/core.ts:219-229` as `export function makeDateTimeTool(): ToolModule` (browser-safe as-is, uses only `Intl`/`Date`).

`src/agent-core/tools/web-fetch.ts` and `src/agent-core/tools/render-html.ts`: temporary

```ts
import type { ToolModule } from './interface';
export function makeWebFetchTool(): ToolModule {
  return { name: 'Web Fetch', isAvailable: () => false, definition: { type: 'function', function: { name: 'web_fetch', description: 'stub', parameters: { type: 'object', properties: {}, required: [] } } }, handler: async () => 'stub' };
}
```

(equivalent stub for `makeRenderHtmlTool`, name `render_html`).

- [ ] **Step 6: Run tests**

Run: `npm test tests/agent-core/tools` — Expected: PASS (registry test sees `web_fetch` unavailable via its `isAvailable`).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: browser fs tools (read/write/list/grep) and tool registry"
```

---

## Task 8: web_fetch tool (online-only)

**Files:**
- Modify: `src/agent-core/tools/web-fetch.ts`
- Test: `tests/agent-core/tools/web-fetch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
});
```

- [ ] **Step 2: Run to verify failure** — `npm test tests/agent-core/tools/web-fetch.test.ts` — FAIL (stub returns `'stub'`).

- [ ] **Step 3: Implement**

```ts
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
```

Also update `buildToolRegistry` in `src/agent-core/tools/index.ts` so `web_fetch`'s availability gets the online flag: pass `{ ...config, online: (toolRegistry as any)._online && config?.online !== false }` — simplest correct wiring: in `getToolDefinitions`/`executeToolHandler`/`listUnavailableTools`, call `t.isAvailable({ ...config, online: (toolRegistry as any)._online })`.

- [ ] **Step 4: Run tests** — `npm test tests/agent-core/tools` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: web_fetch tool with online-only registration"
```

---

## Task 9: render_html tool (canvas/SVG, replaces takumi render_image)

**Files:**
- Modify: `src/agent-core/tools/render-html.ts`
- Test: `tests/agent-core/tools/render-html.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { FakeStorage } from '../../helpers/fake-storage';
import { makeRenderHtmlTool } from '../../../src/agent-core/tools/render-html';

describe('render_html', () => {
  it('writes an SVG file to the workspace and returns its path', async () => {
    const storage = new FakeStorage();
    const t = makeRenderHtmlTool(storage);
    const out = await t.handler({ html: '<div style="width:100px;height:50px">Hi</div>', path: 'cards/x.svg', format: 'svg' }, {});
    expect(out).toContain('cards/x.svg');
    const svg = await storage.readText('workspace/cards/x.svg');
    expect(svg).toContain('<svg');
    expect(svg).toContain('Hi');
  });
  it('rejects output paths outside the workspace', async () => {
    const t = makeRenderHtmlTool(new FakeStorage());
    await expect(t.handler({ html: '<b/>', path: '../x.svg', format: 'svg' }, {})).rejects.toThrow(/outside/i);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test tests/agent-core/tools/render-html.test.ts` — FAIL (stub).

- [ ] **Step 3: Implement (SVG via foreignObject; PNG via canvas in browser)**

```ts
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
        const img = new Image();
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        try {
          await new Promise((ok, err) => { img.onload = ok; img.onerror = err; img.src = url; });
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d')!.drawImage(img, 0, 0);
          const blob: Blob = await new Promise((ok) => canvas.toBlob((b) => ok(b!), 'image/png'));
          await storage.writeBytes(`${WORKSPACE_ROOT}/${rel}`, new Uint8Array(await blob.arrayBuffer()));
          return `Rendered PNG: ${rel}`;
        } finally { URL.revokeObjectURL(url); }
      }
      await storage.writeText(`${WORKSPACE_ROOT}/${rel}`, svg);
      return `Rendered SVG: ${rel}`;
    },
  };
}
```

- [ ] **Step 4: Run tests** — `npm test tests/agent-core/tools/render-html.test.ts` — Expected: PASS (PNG path not exercised under jsdom).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: render_html tool (SVG foreignObject, PNG via canvas)"
```

---

## Task 10: Skills system over StorageProvider

**Files:**
- Create: `src/agent-core/skills.ts`, `public/skills-builtin/` (bundled built-in skill packages)
- Test: `tests/agent-core/skills.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { FakeStorage } from '../../helpers/fake-storage';
import { parseSkillMd, discoverSkills, buildSkillsManifest } from '../../../src/agent-core/skills';

const SKILL = `---
name: greeter
description: Greets the user politely.
version: 1.0.0
---

# Greeter skill
Say hello warmly.
`;

describe('parseSkillMd (vendored)', () => {
  it('parses flat frontmatter and body', () => {
    const p = parseSkillMd(SKILL);
    expect(p?.frontmatter.name).toBe('greeter');
    expect(p?.body).toContain('Say hello warmly');
  });
  it('returns null without frontmatter', () => {
    expect(parseSkillMd('# no frontmatter')).toBeNull();
  });
});

describe('discoverSkills over StorageProvider', () => {
  it('finds skills in a scope dir; later scopes shadow earlier', async () => {
    const s = new FakeStorage();
    await s.writeText('skills-builtin/greeter/SKILL.md', SKILL);
    await s.writeText('skills/greeter/SKILL.md', SKILL.replace('1.0.0', '2.0.0'));
    await s.writeText('skills/other/SKILL.md', SKILL.replace('name: greeter', 'name: other'));
    const { skills, warnings } = await discoverSkills(s, [
      { dir: 'skills-builtin', source: 'builtin' },
      { dir: 'skills', source: 'user' },
    ]);
    expect(warnings).toEqual([]);
    expect(skills.find((k) => k.name === 'greeter')?.version).toBe('2.0.0'); // user shadows builtin
    expect(skills.map((k) => k.name).sort()).toEqual(['greeter', 'other']);
  });
  it('skips skill dirs with invalid SKILL.md and warns', async () => {
    const s = new FakeStorage();
    await s.writeText('skills/broken/SKILL.md', '# nope');
    const { skills, warnings } = await discoverSkills(s, [{ dir: 'skills', source: 'user' }]);
    expect(skills).toEqual([]);
    expect(warnings.length).toBe(1);
  });
});

describe('buildSkillsManifest', () => {
  it('emits one manifest line per skill with its read path', async () => {
    const s = new FakeStorage();
    await s.writeText('skills/greeter/SKILL.md', SKILL);
    const m = await buildSkillsManifest(s, {});
    expect(m).toContain('- greeter (v1.0.0): Greets the user politely.');
    expect(m).toContain('skills/greeter/SKILL.md');
  });
  it('returns null when skillsEnabled is false', async () => {
    expect(await buildSkillsManifest(new FakeStorage(), { skillsEnabled: false })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test tests/agent-core/skills.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

`src/agent-core/skills.ts`: vendor from `/tmp/autoclaw-upstream/src/skills.ts` the following **verbatim**: `SkillSource`, `SkillMeta`, `SkillScope`, `ParsedSkillMd`, `parseSkillMd` (lines 53–93), `toMeta` (75–92), and the manifest-line formatting inside `buildSkillsManifest` (154–161). Delete `builtinSkillsDir`, `defaultSkillScopes`, `installSkill*`, `removeSkill`, `packSkill` and all `fs/os/path/url/zip` imports. Re-implement discovery and manifest async over `StorageProvider`:

```ts
import type { StorageProvider } from './storage';

// ... vendored types + parseSkillMd + toMeta here ...

export interface DiscoveryResult { skills: SkillMeta[]; warnings: string[]; }

export async function discoverSkills(storage: StorageProvider, scopes: SkillScope[]): Promise<DiscoveryResult> {
  const byName = new Map<string, SkillMeta>();
  const warnings: string[] = [];
  for (const scope of scopes) {           // later scopes shadow earlier on name
    if (!(await storage.exists(scope.dir))) continue;
    for (const entry of await storage.list(scope.dir)) {
      if (entry.startsWith('.')) continue;
      const skillMdPath = `${scope.dir}/${entry}/SKILL.md`;
      if (!(await storage.exists(skillMdPath))) continue;
      const parsed = parseSkillMd(await storage.readText(skillMdPath));
      const meta = parsed && toMeta(parsed.frontmatter);
      if (!meta) { warnings.push(`Skipped invalid SKILL.md at ${skillMdPath}`); continue; }
      byName.set(meta.name, { ...meta, source: scope.source, dir: `${scope.dir}/${entry}`, skillMdPath });
    }
  }
  return { skills: [...byName.values()], warnings };
}

export async function buildSkillsManifest(storage: StorageProvider, config?: any, scopes?: SkillScope[]): Promise<string | null> {
  if (config?.skillsEnabled === false) return null;
  const { skills } = await discoverSkills(storage, scopes ?? [
    { dir: 'skills-builtin', source: 'builtin' },
    { dir: 'skills', source: 'user' },
  ]);
  const active = skills.filter((s) => !s.disableModelInvocation);
  if (!active.length) return null;
  // vendored line format from upstream buildSkillsManifest (skills.ts:154-161):
  return active.map((s) =>
    `- ${s.name} (v${s.version ?? '0.0.0'}): ${s.description.replace(/\s+/g, ' ').slice(0, 400)} [read ${s.skillMdPath}]`,
  ).join('\n');
}
```

Copy upstream built-in skills as bundled assets (they're pure SKILL.md + templates; the `render.mjs` Node scripts are dropped — the browser `render_html` tool covers them):

```bash
mkdir -p public/skills-builtin
for s in code2media poster-maker invoice-maker; do
  mkdir -p "public/skills-builtin/$s"
  cp "/tmp/autoclaw-upstream/skills/$s/SKILL.md" "public/skills-builtin/$s/SKILL.md"
  cp -r "/tmp/autoclaw-upstream/skills/$s/references" "public/skills-builtin/$s/" 2>/dev/null || true
  cp -r "/tmp/autoclaw-upstream/skills/$s/templates" "public/skills-builtin/$s/" 2>/dev/null || true
done
```

App boot (Task 13) seeds `skills-builtin/` into storage from `public/skills-builtin/` if absent.

- [ ] **Step 4: Run tests** — `npm test tests/agent-core/skills.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: skills system over StorageProvider + bundled builtin skills"
```

---

## Task 11: wllama worker + LoRA feasibility spike

**Files:**
- Create: `src/llm/protocol.ts`, `src/llm/wllama-worker.ts`
- Test: `tests/llm/protocol.test.ts`; manual spike in the dev server

- [ ] **Step 1: Define the worker protocol**

`src/llm/protocol.ts`:

```ts
export interface LoadModelRequest {
  type: 'load';
  modelUrl: string;            // served URL or blob URL for the base GGUF
  adapterUrl?: string;         // LoRA adapter GGUF, if supported
  nCtx?: number;
}
export interface CompletionRequest {
  type: 'completion';
  id: number;
  params: {
    messages: unknown[];
    tools?: unknown[];
    tool_choice?: 'auto';
    max_tokens?: number;
    temperature?: number;
    stream: true;
  };
}
export interface SwitchAdapterRequest { type: 'set_adapter'; adapterUrl: string | null; }
export type WorkerRequest =
  | LoadModelRequest
  | CompletionRequest
  | SwitchAdapterRequest
  | { type: 'abort'; id: number };

export type WorkerResponse =
  | { type: 'load_progress'; loaded: number; total: number }
  | { type: 'loaded'; loraSupported: boolean }
  | { type: 'chunk'; id: number; chunk: unknown }   // ChatChunk (agent-core/chat-model.ts)
  | { type: 'done'; id: number }
  | { type: 'error'; id?: number; message: string }
  | { type: 'adapter_set'; ok: boolean; error?: string };
```

`tests/llm/protocol.test.ts`: type-level smoke — construct one of each message and assert `type` discriminants round-trip through `structuredClone`.

- [ ] **Step 2: Implement the worker**

`src/llm/wllama-worker.ts`:

```ts
/// <reference lib="webworker" />
import { Wllama, LoggerWithoutDebug } from '@wllama/wllama';
import WasmFromCDN from '@wllama/wllama/esm/wasm-from-cdn.js'; // replace with local paths for offline build, see Step 4
import type { WorkerRequest, WorkerResponse } from './protocol';

const post = (m: WorkerResponse) => (self as any).postMessage(m);

const wllama = new Wllama(WasmFromCDN, { logger: LoggerWithoutDebug });
let loaded = false;

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await wllama.loadModelFromUrl(msg.modelUrl, {
        n_ctx: msg.nCtx ?? 4096,
        // SPIKE: check whether the installed @wllama/wllama LoadModelParams
        // accepts a LoRA adapter (e.g. `lora` / `loraUrl`). If yes, pass
        // msg.adapterUrl here and report loraSupported: true.
        progressCallback: ({ loaded, total }) => post({ type: 'load_progress', loaded, total }),
      } as any);
      loaded = true;
      post({ type: 'loaded', loraSupported: false }); // set true only if the spike passes
    } else if (msg.type === 'completion') {
      if (!loaded) throw new Error('model not loaded');
      const stream: any = await wllama.createChatCompletion(msg.params as any);
      for await (const chunk of stream) post({ type: 'chunk', id: msg.id, chunk });
      post({ type: 'done', id: msg.id });
    } else if (msg.type === 'abort') {
      // wllama v3: abort via AbortSignal per request — track controllers by id
    } else if (msg.type === 'set_adapter') {
      // SPIKE outcome: if runtime LoRA unsupported, respond { ok: false, error: '...' }
      post({ type: 'adapter_set', ok: false, error: 'runtime LoRA not supported by wllama build' });
    }
  } catch (err: any) {
    post({ type: 'error', id: (msg as any).id, message: err?.message ?? String(err) });
  }
};
```

- [ ] **Step 3: Run the LoRA spike (manual, dev server)**

1. `grep -ri lora node_modules/@wllama/wllama/esm/ | head -20` and check `LoadModelParams` in the package's `.d.ts`.
2. `npm run dev`, open the app, run a minimal page that loads `Qwen3.5-0.8B-Q5_K_M.gguf` from a local URL, then attempt adapter load.
3. Record the verdict in `docs/lora-spike.md`: supported → wire `adapterUrl` through; **not supported** (expected, per upstream README TODO) → use the documented fallback: a `scripts/merge-lora.mjs` build-time script that runs `llama.cpp`'s `export-lora`/merge to produce per-webapp merged GGUFs, and the adapter manager (Task 14) hot-swaps **merged models** instead of adapters. The rest of the plan is unchanged — only the artifact swapped differs.

- [ ] **Step 4: Make wasm assets local** (offline requirement)

Copy `node_modules/@wllama/wllama/esm/wasm/*` into `public/wllama-wasm/` and replace `WasmFromCDN` with explicit local paths:

```ts
const WLLAMA_CONFIG_PATHS = {
  'single-thread/wllama.wasm': '/wllama-wasm/single-thread/wllama.wasm',
  'multi-thread/wllama.wasm': '/wllama-wasm/multi-thread/wllama.wasm',
};
```

(Exact map keys: copy from `node_modules/@wllama/wllama/esm/wasm-from-cdn.js`, replacing the CDN base URL with `/wllama-wasm/`.) Ensure `vite-plugin-pwa` `workbox.maximumFileSizeToCacheInBytes` is raised (e.g. `20 * 1024 * 1024`) so the wasm precaches.

- [ ] **Step 5: Run tests + build**

Run: `npm test` — Expected: PASS. Run: `npm run build` — Expected: wasm files under `dist/wllama-wasm/`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: wllama worker with local wasm assets; LoRA spike verdict documented"
```

---

## Task 12: LLM shim — WllamaChatModel

**Files:**
- Create: `src/llm/shim.ts`
- Test: `tests/llm/shim.test.ts` (mock worker)

- [ ] **Step 1: Write the failing test**

`tests/llm/shim.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WllamaChatModel } from '../../src/llm/shim';
import type { WorkerResponse } from '../../src/llm/protocol';

class MockWorker {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  posted: unknown[] = [];
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() {}
  emit(m: WorkerResponse) { this.onmessage?.({ data: m } as MessageEvent<WorkerResponse>); }
}

describe('WllamaChatModel', () => {
  it('yields chunks until done, then completes', async () => {
    const w = new MockWorker();
    const model = new WllamaChatModel(w as any, 'test-model');
    const p = model.createChatCompletionStream({ model: 'm', messages: [], stream: true });
    const it = (await p)[Symbol.asyncIterator]();
    w.emit({ type: 'chunk', id: 0, chunk: { choices: [{ delta: { content: 'he' } }] } });
    w.emit({ type: 'chunk', id: 0, chunk: { choices: [{ delta: { content: 'y' } }] } });
    w.emit({ type: 'done', id: 0 });
    const parts: string[] = [];
    let r = await it.next();
    while (!r.done) { parts.push((r.value as any).choices[0].delta.content); r = await it.next(); }
    expect(parts).toEqual(['he', 'y']);
  });
  it('rejects the stream on worker error', async () => {
    const w = new MockWorker();
    const model = new WllamaChatModel(w as any, 'm');
    const it = (await model.createChatCompletionStream({ model: 'm', messages: [], stream: true }))[Symbol.asyncIterator]();
    w.emit({ type: 'error', id: 0, message: 'boom' });
    await expect(it.next()).rejects.toThrow('boom');
  });
  it('abort() aborts in-flight requests', async () => {
    const w = new MockWorker();
    const model = new WllamaChatModel(w as any, 'm');
    const ac = new AbortController();
    const it = (await model.createChatCompletionStream({ model: 'm', messages: [], stream: true }, { signal: ac.signal }))[Symbol.asyncIterator]();
    ac.abort();
    await expect(it.next()).rejects.toThrow(/abort/i);
    expect(w.posted).toContainEqual({ type: 'abort', id: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test tests/llm/shim.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

`src/llm/shim.ts`:

```ts
import type { ChatModel, ChatCompletionParams, ChatChunk } from '@core/chat-model';
import type { WorkerRequest, WorkerResponse } from './protocol';

interface Pending {
  queue: ChatChunk[];
  resolve: (() => void) | null;
  error: Error | null;
  done: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class WllamaChatModel implements ChatModel {
  private nextId = 0;
  private pending = new Map<number, Pending>();

  constructor(private worker: Worker, private model: string) {
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (m.type === 'chunk' || m.type === 'done' || (m.type === 'error' && m.id != null)) {
        const id = 'id' in m ? (m.id as number) : -1;
        const p = this.pending.get(id);
        if (!p) return;
        if (m.type === 'chunk') p.queue.push(m.chunk as ChatChunk);
        else if (m.type === 'done') p.done = true;
        else p.error = new Error((m as any).message);
        p.resolve?.();
      }
    };
  }

  async createChatCompletionStream(
    params: ChatCompletionParams,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<ChatChunk>> {
    const id = this.nextId++;
    const p: Pending = { queue: [], resolve: null, error: null, done: false, signal: options?.signal };
    this.pending.set(id, p);
    const req: WorkerRequest = { type: 'completion', id, params: { ...params, model: this.model } as any };
    this.worker.postMessage(req);
    if (p.signal) {
      p.onAbort = () => { p.error = new Error('aborted'); this.worker.postMessage({ type: 'abort', id }); p.resolve?.(); };
      p.signal.addEventListener('abort', p.onAbort, { once: true });
    }
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<ChatChunk>> {
            for (;;) {
              if (p.error) { self.pending.delete(id); p.signal?.removeEventListener('abort', p.onAbort!); throw p.error; }
              if (p.queue.length) return { value: p.queue.shift()!, done: false };
              if (p.done) { self.pending.delete(id); p.signal?.removeEventListener('abort', p.onAbort!); return { value: undefined, done: true }; }
              await new Promise<void>((r) => { p.resolve = r; });
              p.resolve = null;
            }
          },
        };
      },
    };
  }
}
```

- [ ] **Step 4: Run tests** — `npm test tests/llm` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: WllamaChatModel shim (ChatModel over worker protocol)"
```

---

## Task 13: Download manager + first-run setup wizard

**Files:**
- Create: `src/setup/download.ts`, `src/setup/SetupWizard.tsx`, `src/setup/manifest.ts`
- Test: `tests/setup/download.test.ts`

- [ ] **Step 1: Asset manifest**

`src/setup/manifest.ts` — bundled, editable list of everything the folder needs:

```ts
export interface AssetSpec {
  url: string;          // https URL (first download only; app is offline afterwards)
  path: string;         // folder-relative destination
  sha256?: string;      // optional integrity check
}

export const BASE_MODEL: AssetSpec = {
  url: 'https://huggingface.co/<USER>/Qwen3.5-0.8B-Q5_K_M/resolve/main/Qwen3.5-0.8B-Q5_K_M.gguf',
  path: 'models/Qwen3.5-0.8B-Q5_K_M.gguf',
};

export const ADAPTERS: AssetSpec[] = [
  // { url: '.../adapter-support.gguf', path: 'adapters/support/adapter.gguf' },
];
```

- [ ] **Step 2: Write the failing test (resumable download)**

`tests/setup/download.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeStorage } from '../helpers/fake-storage';
import { downloadAsset } from '../../src/setup/download';

function bodyOf(chunks: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) { chunks.forEach((s) => c.enqueue(enc.encode(s))); c.close(); },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('downloadAsset', () => {
  it('writes the file and reports progress', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bodyOf(['ab', 'cd']), { headers: { 'content-length': '4' } })));
    const storage = new FakeStorage();
    const seen: number[] = [];
    await downloadAsset({ url: 'https://x/m.gguf', path: 'models/m.gguf' }, storage, (p) => seen.push(p.loaded));
    expect(await storage.readText('models/m.gguf')).toBe('abcd');
    expect(seen.at(-1)).toBe(4);
  });
  it('skips when the file already exists with the right size', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const storage = new FakeStorage();
    await storage.writeText('models/m.gguf', 'abcd');
    await downloadAsset({ url: 'https://x/m.gguf', path: 'models/m.gguf', size: 4 } as any, storage, () => {});
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
    await downloadAsset({ url: 'https://x/m.gguf', path: 'models/m.gguf', size: 4 } as any, storage, () => {});
    expect(await storage.readText('models/m.gguf')).toBe('abcd');
    expect(await storage.exists('cache/m.gguf.part')).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npm test tests/setup/download.test.ts` — FAIL (module missing).

- [ ] **Step 4: Implement download.ts**

```ts
import type { StorageProvider } from '@core/storage';

export interface DownloadSpec { url: string; path: string; size?: number; sha256?: string; }
export interface Progress { loaded: number; total: number; }

export async function downloadAsset(
  spec: DownloadSpec,
  storage: StorageProvider,
  onProgress: (p: Progress) => void,
): Promise<void> {
  if (spec.size != null && (await storage.exists(spec.path))) {
    try {
      if ((await storage.stat(spec.path)).size === spec.size) return; // already done
    } catch { /* fall through */ }
  }
  const partPath = `cache/${spec.path.split('/').pop()}.part`;
  let resumeFrom = 0;
  if (await storage.exists(partPath)) {
    try { resumeFrom = (await storage.stat(partPath)).size; } catch { resumeFrom = 0; }
  }
  const headers: Record<string, string> = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};
  const res = await fetch(spec.url, { headers });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} downloading ${spec.url}`);
  const total = Number(res.headers.get('content-length') ?? 0) + resumeFrom;
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = resumeFrom;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ loaded, total });
  }
  const prior = resumeFrom > 0 ? await storage.readBytes(partPath) : new Uint8Array(0);
  const out = new Uint8Array(loaded);
  out.set(prior, 0);
  let off = prior.byteLength;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  await storage.writeBytes(spec.path, out);
  if (await storage.exists(partPath)) await storage.remove(partPath);
}
```

- [ ] **Step 5: Implement SetupWizard.tsx**

A two-screen React flow (full code in the component; behavior is what matters):
1. **Pick folder** — button calls `FileSystemAccessStorage.pickAndCreate()`, `saveHandle()`, then creates the standard subdirs (`models/`, `adapters/`, `skills/`, `workspace/`, `cache/`) and seeds `skills-builtin/` from `public/skills-builtin/` via `fetch('/skills-builtin/...')` + `storage.writeText` (skipped when offline — the service worker serves them from precache).
2. **Download assets** — iterates `[BASE_MODEL, ...ADAPTERS]`, calls `downloadAsset` per asset with a progress bar (`loaded/total`). On completion writes `cache/setup-done.json` and calls `onDone(storage)`.
No storage access → OPFS fallback via `restoreStorage()`; the wizard shows "browser doesn't support folder access, using built-in storage" in that case.

- [ ] **Step 6: Run tests** — `npm test tests/setup` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: resumable download manager + first-run setup wizard"
```

---

## Task 14: Adapter manager

**Files:**
- Create: `src/adapters/manager.ts`
- Test: `tests/adapters/manager.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { FakeStorage } from '../helpers/fake-storage';
import { AdapterManager } from '../../src/adapters/manager';

describe('AdapterManager', () => {
  it('lists adapters from registry.json and marks the active one', async () => {
    const s = new FakeStorage();
    await s.writeText('adapters/registry.json', JSON.stringify({
      contexts: { support: 'adapters/support/adapter.gguf', legal: 'adapters/legal/adapter.gguf' },
    }));
    const m = new AdapterManager(s);
    expect(await m.listContexts()).toEqual(['legal', 'support']);
    await m.activate('support');
    expect(await m.activeContext()).toBe('support');
  });
  it('returns null active context on fresh storage', async () => {
    expect(await new AdapterManager(new FakeStorage()).activeContext()).toBeNull();
  });
  it('rejects activating an unknown context', async () => {
    const s = new FakeStorage();
    await s.writeText('adapters/registry.json', JSON.stringify({ contexts: {} }));
    await expect(new AdapterManager(s).activate('nope')).rejects.toThrow(/unknown/i);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test tests/adapters/manager.test.ts` — FAIL.

- [ ] **Step 3: Implement**

```ts
import type { StorageProvider } from '@core/storage';

interface Registry { contexts: Record<string, string>; }

export class AdapterManager {
  constructor(private storage: StorageProvider) {}

  private async readRegistry(): Promise<Registry> {
    if (!(await this.storage.exists('adapters/registry.json'))) return { contexts: {} };
    return JSON.parse(await this.storage.readText('adapters/registry.json'));
  }

  async listContexts(): Promise<string[]> {
    return Object.keys((await this.readRegistry()).contexts).sort();
  }

  async adapterPath(context: string): Promise<string | null> {
    return (await this.readRegistry()).contexts[context] ?? null;
  }

  async activeContext(): Promise<string | null> {
    if (!(await this.storage.exists('adapters/active.json'))) return null;
    return JSON.parse(await this.storage.readText('adapters/active.json')).context ?? null;
  }

  /** Persist selection; the caller then tells the wllama worker to swap (set_adapter
      or reload merged model, per the Task 11 spike verdict). */
  async activate(context: string): Promise<void> {
    const path = await this.adapterPath(context);
    if (!path) throw new Error(`Unknown adapter context: ${context}`);
    if (!(await this.storage.exists(path))) throw new Error(`Adapter file missing: ${path}`);
    await this.storage.writeText('adapters/active.json', JSON.stringify({ context, path }));
  }
}
```

- [ ] **Step 4: Run tests** — `npm test tests/adapters` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: adapter manager (registry, per-context activation)"
```

---

## Task 15: Chat UI

**Files:**
- Create: `src/ui/App.tsx`, `src/ui/ChatView.tsx`, `src/ui/ToolTrace.tsx`, `src/ui/ConfirmDialog.tsx`, `src/ui/StatusBar.tsx`, `src/ui/agent-host.ts`
- Test: `tests/ui/chat-view.test.tsx`

- [ ] **Step 1: agent-host.ts — glue**

`src/ui/agent-host.ts` creates and owns the runtime graph, one per app session:

```ts
import { Agent } from '@core/agent';
import { buildToolRegistry } from '@core/tools';
import { WllamaChatModel } from '../llm/shim';
import type { StorageProvider } from '@core/storage';
import type { AgentEvent } from '@core/events';

export function createAgentHost(storage: StorageProvider, worker: Worker, model: string, onEvent: (e: AgentEvent) => void) {
  buildToolRegistry(storage, { online: navigator.onLine });
  const confirmResolvers = new Map<string, (ok: boolean) => void>();
  const config: any = {
    maxSteps: 25,
    autoConfirm: false,
    _emit: onEvent,
    _confirm: (id: string) => new Promise<boolean>((ok) => confirmResolvers.set(id, ok)),
  };
  const agent = new Agent(new WllamaChatModel(worker, model), model, config, storage, onEvent);
  return {
    agent,
    resolveConfirm: (id: string, ok: boolean) => { confirmResolvers.get(id)?.(ok); confirmResolvers.delete(id); },
  };
}
```

- [ ] **Step 2: Write the failing UI test**

`tests/ui/chat-view.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ChatView } from '../../src/ui/ChatView';
import type { AgentEvent } from '@core/events';

describe('ChatView', () => {
  it('renders streamed tokens into the assistant message', async () => {
    const sent: string[] = [];
    const emitters: Array<(e: AgentEvent) => void> = [];
    render(<ChatView send={async (t) => { sent.push(t); }} registerEmitter={(e) => emitters.push(e)} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    emitters[0]({ event: 'token', text: 'Hi ' });
    emitters[0]({ event: 'token', text: 'there' });
    expect(await screen.findByText('Hi there')).toBeTruthy();
    expect(sent).toEqual(['hello']);
  });
  it('shows tool calls in the trace panel', async () => {
    const emitters: Array<(e: AgentEvent) => void> = [];
    render(<ChatView send={async () => {}} registerEmitter={(e) => emitters.push(e)} />);
    emitters[0]({ event: 'tool_call', step: 1, tool: 'read_file', args: { path: 'a.txt' } });
    emitters[0]({ event: 'tool_result', step: 1, tool: 'read_file', truncated: false, bytes: 12 });
    expect(await screen.findByText(/read_file/)).toBeTruthy();
  });
});
```

`ChatView` props contract: `{ send: (text: string) => Promise<void>; registerEmitter: (fn: (e: AgentEvent) => void) => void; }`.

- [ ] **Step 3: Run to verify failure** — `npm test tests/ui` — FAIL.

- [ ] **Step 4: Implement the components**

- `ChatView.tsx`: message list (user/assistant), textarea + send button, subscribes via `registerEmitter`; `token` events append to the in-flight assistant message; `tool_call`/`tool_result` append entries to a `<ToolTrace>` list rendered collapsed (AutoClaw-style fold); `confirm_request` opens `<ConfirmDialog>` whose buttons call `resolveConfirm(id, true|false)`; `run_end` finalizes the message and shows `status`.
- `ConfirmDialog.tsx`: shows tool name + JSON args + reason; Approve/Deny buttons.
- `StatusBar.tsx`: offline/online (`navigator.onLine` + `online`/`offline` events), storage kind (`fs-access`/`opfs`), active adapter context, "re-grant folder access" button when `restoreStorage()` returned null but a saved handle exists.
- `App.tsx`: boot sequence — `restoreStorage()` → if null render `<SetupWizard>` → else ensure model loaded (spawn `new Worker(new URL('../llm/wllama-worker.ts', import.meta.url), { type: 'module' })`, send `load` with the model blob URL read via `storage.readBytes('models/...gguf')` → `URL.createObjectURL`) → render `ChatView` wired through `createAgentHost`.

- [ ] **Step 5: Run tests** — `npm test tests/ui` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: chat UI with streaming, tool trace, confirmations, status bar"
```

---

## Task 16: PWA offline hardening + e2e

**Files:**
- Modify: `vite.config.ts`
- Create: `e2e/offline.spec.ts`, `playwright.config.ts`, `e2e/fixtures/` (tiny test GGUF)

- [ ] **Step 1: Harden the service worker**

In `vite.config.ts` `VitePWA({...})` add:

```ts
workbox: {
  maximumFileSizeToCacheInBytes: 20 * 1024 * 1024, // wasm files
  globPatterns: ['**/*.{js,css,html,wasm,png,svg,md}'],
  navigateFallback: 'index.html',
},
```

Model/adapters are **not** precached — they live in the user folder (Task 13).

- [ ] **Step 2: Write the offline e2e**

`playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  webServer: { command: 'npm run preview', port: 4173, reuseExistingServer: true },
  use: { baseURL: 'http://localhost:4173' },
});
```

`e2e/offline.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('app loads and chats fully offline', async ({ page, context }) => {
  // First pass ONLINE: install SW + run setup with a tiny test model
  // (e2e fixture serves a ~2MB stories260K-style GGUF from /fixtures).
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker?.ready);
  // seed OPFS with the fixture model instead of folder picker (headless Chromium
  // supports showDirectoryPicker via --enable-features, but OPFS keeps CI simple:
  // the app falls back to OPFS when no handle is chosen)
  await page.getByRole('button', { name: /use built-in storage/i }).click();
  await expect(page.getByText(/setup complete/i)).toBeVisible({ timeout: 120_000 });

  // Second pass OFFLINE
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('textbox')).toBeVisible();
  await page.getByRole('textbox').fill('Say hi');
  await page.getByRole('button', { name: /send/i }).click();
  await expect(page.locator('.assistant-message').last()).not.toBeEmpty({ timeout: 120_000 });
});
```

The setup wizard needs a visible "Use built-in storage" button (OPFS path) — add it in Task 13 Step 5 if not already present. The fixture model URL is overridden in e2e via `?modelUrl=/fixtures/tiny.gguf` query param honored by `SetupWizard`.

- [ ] **Step 3: Run e2e**

```bash
npx playwright install chromium
npm run build
npm run e2e
```
Expected: 1 passed. If the tiny model is too slow in CI WASM single-thread, mark the test `test.slow()` and keep the 120 s timeouts.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: PWA offline hardening + offline e2e test"
```

---

## Verification checklist (run after Task 16)

1. `npm test` — all unit tests green.
2. `npm run build` — production build succeeds.
3. `npm run e2e` — offline round-trip green.
4. Manual: `npm run preview`, pick a folder, download model, chat; disable network in devtools, reload, chat again; switch adapter context and confirm the model/adapter reloads.
