# Offline In-Browser AutoClaw Chatbot — Design & Implementation Plan

## Goal

A Progressive Web App that runs **fully offline in the browser** and lets the user chat with
AutoClaw-style agents powered by a small language model (`Qwen3.5-0.8B-Q5_K_M.gguf`) with
**dynamically swappable LoRA/QLoRA adapters** (adapter selected by the webapp context built
on top of the platform).

## Confirmed decisions (from brainstorming)

- **AutoClaw** = `tsingliuwin/autoclaw` — headless Node.js/TypeScript agent framework,
  OpenAI-compatible chat loop + tool-call dispatch + SKILL.md skill packages + safety gates.
- **Inference** = in-browser via **wllama** (WebAssembly binding of llama.cpp; upstream
  supports LoRA adapters). No server, no internet after first load.
- **Agent runtime** = extract/reuse AutoClaw's code, bundled into the browser build.
- **Scope** = full tool suite (browser-feasible equivalents; inherently-networked tools
  register only when credentials/connectivity exist — same conditional-registration pattern
  AutoClaw itself uses).
- **Stack** = React + Vite + TypeScript.
- **Storage** = user-granted folder via the **File System Access API**
  (`showDirectoryPicker`). On first run the app asks the user to pick a folder; everything
  lives there: base GGUF, LoRA adapters, skill packages, agent workspace files, cache.
  The folder handle is persisted in IndexedDB so subsequent visits re-use it (browser may
  re-prompt for permission — handled gracefully with a "re-grant access" button).
  OPFS is used only as a transparent fallback when the File System Access API is
  unavailable (e.g. Firefox/Safari).

## Key finding from codebase recon

AutoClaw's `src/` is already well modularized:

| Module | Browser portability |
|---|---|
| `agent.ts` (agent loop), `tools/interface.ts` (tool contract), `retry.ts`, `truncate.ts`, `providers.ts` | Portable TS — depends mainly on the OpenAI SDK client |
| `skills.ts` (SKILL.md discovery/loading) | Portable once `fs` is swapped for the storage layer |
| `tools/core.ts` (file I/O + shell) | File I/O → storage layer; `execute_shell_command` has **no browser equivalent** |
| `tools/browser.ts`, `screenshot.ts` (Playwright) | Not portable — replaced by in-page DOM/fetch equivalents |
| `tools/email.ts` (SMTP) | Not possible from a browser — dropped or proxied (out of scope offline) |
| `tools/render-image.ts`, `render-pdf.ts` (Takumi native Rust binding) | Native Node binding — replaced by DOM→canvas/SVG rendering |
| `index.ts`, `batch.ts`, `setup.ts`, `doctor.ts` (CLI, commander/inquirer) | Not needed in browser |

## Selected approach — Vendor AutoClaw's portable core, browser tools against its tool interface

(Chosen by the user. Alternatives considered and rejected: bundling the `autoclaw` npm
package with Node polyfills — fragile, native `.node` bindings and `child_process` can't
be polyfilled; and a clean-room rewrite — abandons code reuse.)

The realistic form of "extract/reuse via bundling": vendor `agent.ts`, `tools/interface.ts`,
`retry.ts`, `truncate.ts`, `skills.ts` into `packages/agent-core/` of the PWA repo, keeping
AutoClaw's tool-call loop, safety gates (step cap, timeouts, destructive-command gate) and
skill system intact, and swap the I/O layer:

- **LLM backend shim**: an adapter implementing the chat-completions surface AutoClaw's
  agent loop expects, backed by wllama running in a **Web Worker** (streaming tokens to UI).
- **Storage layer**: a `StorageProvider` abstraction with two backends —
  `FileSystemAccessStorage` (primary; user-picked folder, handle persisted in IndexedDB)
  and `OpfsStorage` (fallback). All model files, adapters, skills and workspace I/O go
  through it. First-run wizard: pick folder → download base model + default adapter(s)
  with resumable downloads and progress UI.
- **Browser tool pack** implementing `tools/interface.ts`: virtual filesystem tools backed
  by the storage layer (read/write/list/grep inside the user folder's `workspace/`),
  `web_fetch` (when online), datetime, in-browser HTML→image/PDF rendering
  (canvas/SVG/print), skill loader reading SKILL.md packages from the folder.
- **Dynamic LoRA**: wllama `loadModel` with adapter list; adapter chosen per webapp context,
  hot-swappable without reloading the base model. Adapters stored in the user folder
  (`adapters/`).
- **PWA shell**: React + Vite + `vite-plugin-pwa`; service worker precaches the app code;
  large assets (GGUF, adapters) live in the user folder, not the SW cache; after first
  setup the app works 100 % offline.

**Pros:** true reuse of AutoClaw's tested agent loop and safety design; single offline
deployment; smallest long-term maintenance surface of the realistic options.
**Cons:** vendored code must be re-synced with upstream manually; shell/SMTP/Playwright
tools can't be carried over 1:1.

## Architecture

```
┌────────────────────────────── Browser (PWA, offline) ──────────────────────────────┐
│ React UI (chat, agent picker, adapter manager, folder setup wizard, file viewer)   │
│        │ messages / streaming tokens (postMessage)                                 │
│ Agent Core (vendored from AutoClaw: agent loop, tool dispatch, skills, gates)      │
│        │ chat.completions.create(...)            │ tool calls                      │
│ LLM Shim ──► wllama Web Worker ──► WASM llama.cpp                                  │
│                 base: Qwen3.5-0.8B-Q5_K_M.gguf  +  active LoRA adapter (swappable) │
│ Browser Tool Pack: fs tools · web_fetch · datetime · render · skill loader         │
│        │ all file I/O via StorageProvider                                        │
│ StorageProvider ──► File System Access API (user-picked folder, handle in IDB)     │
│                   └─► OPFS fallback (browsers without FS Access API)               │
└────────────────────────────────────────────────────────────────────────────────────┘

User folder layout:
  <picked-folder>/
    models/Qwen3.5-0.8B-Q5_K_M.gguf
    adapters/<webapp-context>/*.gguf        # LoRA/QLoRA adapters, one set per webapp
    skills/<skill-name>/SKILL.md ...        # AutoClaw-format skill packages
    workspace/                              # agent virtual filesystem root
    cache/                                  # resumable download partials, misc
```

## Implementation steps

1. **Scaffold** — Vite + React + TS PWA (`vite-plugin-pwa`), repo layout:
   `packages/agent-core/` (vendored AutoClaw), `src/` (UI), `public/`, `tests/`.
2. **Vendor agent core** — copy `agent.ts`, `tools/interface.ts`, `retry.ts`,
   `truncate.ts`, `skills.ts` from `tsingliuwin/autoclaw` (MIT license, include LICENSE
   + provenance note); strip Node-only imports; make the LLM client and filesystem
   injectable.
3. **Storage layer** — `StorageProvider` interface (read/write/list/delete/stat +
   streaming reads for large files); `FileSystemAccessStorage` (showDirectoryPicker,
   handle persisted in IndexedDB, permission re-grant flow) and `OpfsStorage` fallback;
   first-run wizard that asks for the folder and downloads model + adapters into it
   (resumable, progress UI).
4. **wllama worker** — Web Worker wrapping `@wllama/wllama`: model load from the
   storage layer with progress, streaming completion, LoRA adapter load/switch API.
5. **LLM shim** — map agent-core chat-completions calls (messages + tool schemas) onto
   wllama: prompt templating for Qwen tool-calling format, stream deltas, tool-call parsing.
6. **Browser tool pack** — fs tools (`read_file`, `write_file`, `list_dir`, `grep`)
   rooted at `<folder>/workspace/` via StorageProvider, `get_datetime`, `web_fetch`
   (registered only when online), HTML→PNG/SVG render via canvas, skill loader
   (SKILL.md from `<folder>/skills/`). Same names/schemas as AutoClaw where possible.
7. **Safety gates** — port step cap, wall-clock timeout, and the destructive-action
   confirmation flow (adapted to the virtual workspace); auto-confirm mode flag.
8. **Adapter manager** — registry mapping webapp contexts to adapters in
   `<folder>/adapters/`; download/cache; runtime switch; UI indicator of active adapter.
9. **Chat UI** — conversation list, streaming markdown rendering, tool-call trace panel
   (AutoClaw-style folded tool outputs), agent/persona picker, offline status + folder
   status (granted/needs re-grant).
10. **PWA offline hardening** — service worker precache of app code, offline e2e check
    (load with network disabled, model read from folder), install prompt.
11. **Tests** — vitest unit tests for agent loop (mirroring AutoClaw's own test style),
    storage layer (mock FS Access API), tool pack, adapter switching; Playwright e2e:
    offline chat round-trip with a small test model.

## Open risk to flag

- wllama's LoRA API: upstream added adapter support, but hot-swap ergonomics and Q5_K_M +
  adapter quality need an early spike (step 4 before everything else). If runtime adapter
  application proves broken, fallback is **offline merge** (merge LoRA into base GGUF at
  build time, ship per-webapp merged GGUFs) — keeps the UX, loses runtime swapping.
- 0.8B models are weak at reliable tool-calling; the shim needs strict output parsing and
  retry-on-malformed-tool-call (AutoClaw's retry pattern helps here).
