// Downloads the e2e fixture model (Qwen2.5-0.5B-Instruct Q2_K, ~252MB) into
// public/fixtures/ before the web server starts. The file is gitignored —
// it is fetched once per machine, not committed.
//
// Why not the usual ~2MB TinyStories fixture? The agent's system prompt plus
// tool definitions are ~2900 tokens, and TinyStories models have a trained
// context of 2048 that llama.cpp hard-caps the server slot to — the request
// can never fit. Qwen2.5-0.5B has a 32K context and answers "Say hi"
// reliably in headless Chromium wasm.

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const MODEL_DOWNLOAD_URL =
  'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q2_k.gguf';
const DEST = new URL('../public/fixtures/qwen2.5-0.5b-instruct-q2_k.gguf', import.meta.url).pathname;

export const FIXTURE_PATH = 'public/fixtures/qwen2.5-0.5b-instruct-q2_k.gguf';
export const FIXTURE_URL = '/fixtures/qwen2.5-0.5b-instruct-q2_k.gguf';

async function main(): Promise<void> {
  if (existsSync(DEST)) {
    if ((await readFile(DEST)).subarray(0, 4).toString() === 'GGUF') return; // already good
    await rm(DEST); // truncated/partial from a previous interrupted download
  }
  mkdirSync(dirname(DEST), { recursive: true });
  process.stdout.write(`[e2e setup] downloading fixture model (~252MB)...\n`);
  const res = await fetch(MODEL_DOWNLOAD_URL);
  if (!res.ok || !res.body) throw new Error(`fixture download failed: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const out = createWriteStream(DEST);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
    }
  } finally {
    reader.cancel().catch(() => {});
    await new Promise((r) => out.end(r));
  }
  if ((await readFile(DEST)).subarray(0, 4).toString() !== 'GGUF') {
    await rm(DEST);
    throw new Error('fixture download was not a valid GGUF file');
  }
  process.stdout.write(`[e2e setup] fixture ready at ${FIXTURE_PATH}\n`);
}

export default function globalSetup(): Promise<void> {
  return main();
}
