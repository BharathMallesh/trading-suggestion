// Vite bundles wllama-worker.ts as a dedicated worker chunk because of the
// new Worker(new URL(...)) pattern below; keep this as the single entry point
// for spawning the llm worker (typed client wrapper lands with the shim task).
export function createWllamaWorker(): Worker {
  return new Worker(new URL('./wllama-worker.ts', import.meta.url), { type: 'module' });
}
