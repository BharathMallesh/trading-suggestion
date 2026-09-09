# LoRA feasibility spike — verdict: NOT supported (use merged GGUFs)

Date: 2026-09-09. Package: `@wllama/wllama@3.6.1` (installed, pinned `^3.6.1`).

## What was checked

1. `grep -ri lora node_modules/@wllama/wllama/esm/` — hits in:
   - `esm/types/types.d.ts`: `LoadModelParams.lora_adapters?: { path: string; scale?: number }[]` and `lora_init_without_apply?: boolean`.
   - `esm/index.js`: these are forwarded verbatim into the native `load_req` message as `lora_paths` / `lora_scales` / `lora_init_without_apply`.
   - `esm/wasm/wllama.wasm`: the native side accepts the fields (libllama glue).
2. The full request-verb inventory of the JS->wasm protocol (`grep -o '"[a-z_]*_req"' esm/index.js`): only
   `load_req`, `cmpl_req`, `cncl_req`, `embd_req`, `gres_req`, `rrnk_req`, `tbop_req`.
   There is **no runtime apply/switch-adapter verb** — adapters can only be named at load time, and `lora_init_without_apply` has no matching "apply" action exposed.
3. Delivery problem: `lora_paths` are paths inside the wasm virtual FS (`/models/...`). That FS is populated
   exclusively by `prepareBlobs` during `loadModel`/`loadModelFromUrl`, which renames every input blob to
   `model-XXXXX-of-YYYYY.gguf` (or `mmproj.gguf`). There is no API to write an arbitrary adapter file under a
   stable path, so `lora_adapters` cannot be pointed at a real file through the supported load paths.
4. Vendored upstream README (`node_modules/@wllama/wllama/README.md`, TODO section) lists
   "Add support for LoRA adapter" as an open item.

## Verdict

Runtime LoRA switching is **not supported** by wllama 3.6.1. Load-time `lora_adapters` exists in the types and
reaches the native layer, but it is effectively unusable via `loadModelFromUrl` (no adapter-file delivery path)
and still would not enable hot-swapping. The worker therefore reports `loraSupported: false` on `loaded` and
answers `set_adapter` with `{ ok: false, error }`.

## Fallback (unchanged plan, different artifact)

- Build-time merge: a `scripts/merge-lora.mjs` script that shells out to llama.cpp's `export-lora`
  (a.k.a. `--convert-lora-to-gguf` / merge flow) to bake an adapter into a per-webapp **merged GGUF**.
- The adapter manager (Task 14) hot-swaps **merged models** (unload base, load merged) instead of swapping
  lightweight adapter files. Semantics for the rest of the plan are identical; only the artifact swapped differs.
- Cost note: merged GGUFs duplicate the base weights per adapter, so adapter count is limited by storage.
  The `LoadModelRequest.adapterUrl` field and the `set_adapter` protocol message stay in place; if a future
  wllama release adds runtime adapter support, the worker can wire them through without a protocol change.

## Wasm assets (offline)

v3.6.1 ships a single `esm/wasm/wllama.wasm` (~8.5 MB, pthreads built in — no separate
single-thread/multi-thread builds; the only `AssetsPathConfig` key read at runtime is `default`).
It is copied to `public/wllama-wasm/wllama.wasm` and referenced as
`new Wllama({ default: '/wllama-wasm/wllama.wasm' })`. The bare `@wllama/wllama` import is broken in this
tarball (package `main: index.js` missing at the package root), so the worker imports the ESM build directly
from `@wllama/wllama/esm/index.js`. `vite-plugin-pwa` precaches it via
`workbox.globPatterns` (added `wasm`) and `maximumFileSizeToCacheInBytes: 20 MiB`.
