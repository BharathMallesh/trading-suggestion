/// <reference lib="webworker" />
import { Wllama, WllamaAbortError, LoggerWithoutDebug } from '@wllama/wllama/esm/index.js';
import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionTool,
} from '@wllama/wllama/esm/index.js';
import type { WorkerRequest, WorkerResponse } from './protocol';
import type { ChatChunk, ChatMessage } from '@core/chat-model';

// wllama chunks allow null where agent-core ChatChunk does not; normalize at the boundary
const toChatChunk = (c: ChatCompletionChunk): ChatChunk => ({
  choices: c.choices.map((ch) => ({
    delta: { content: ch.delta.content ?? undefined, tool_calls: ch.delta.tool_calls },
    finish_reason: ch.finish_reason,
  })),
  usage: c.usage ?? undefined,
});

// agent-core allows null/absent content and per-message role widening where wllama
// requires exact variants; map explicitly so no cast is needed
const toWllamaMessages = (messages: ChatMessage[]): ChatCompletionMessage[] =>
  messages.map((m) => {
    const content = m.content ?? '';
    if (m.role === 'system') return { role: 'system', content };
    if (m.role === 'user') return { role: 'user', content };
    if (m.role === 'tool') return { role: 'tool', content, tool_call_id: m.tool_call_id ?? '' };
    return { role: 'assistant', content: m.content ?? null, tool_calls: m.tool_calls };
  });

// Custom logger: extends LoggerWithoutDebug (already silences debug spam) and
// additionally suppresses two categories of expected-but-noisy warnings:
//   1. "No available adapters" / "requestAdapter returned null" — wllama probes
//      WebGPU on every load and emits this on browsers without GPU. The WASM
//      fallback kicks in automatically; the message is pure noise.
//   2. "model has unused tensor blk.N.nextn.*" — Qwen3.5's Multi-Token
//      Prediction (MTP) heads are not supported by wllama; they are safely
//      ignored and inference is unaffected.
const SUPPRESS = [
  /no available adapters/i,
  /requestAdapter returned null/i,
  /webgpu not available/i,
  /model has unused tensor.*nextn\./i,
  /model has unused tensor blk\.\d+\.(attn|ffn|post_attention|attn_norm|attn_q|attn_k|attn_v|attn_output|attn_q_norm|attn_k_norm)/i,
];
const wllama = new Wllama({ default: '/wllama-wasm/wllama.wasm' }, {
  logger: {
    ...LoggerWithoutDebug,
    warn:  (...args: unknown[]) => { const s = args.join(' '); if (!SUPPRESS.some(r => r.test(s))) LoggerWithoutDebug.warn(...args);  },
    error: (...args: unknown[]) => { const s = args.join(' '); if (!SUPPRESS.some(r => r.test(s))) LoggerWithoutDebug.error(...args); },
  },
});

const controllers = new Map<number, AbortController>();
let loaded = false;
let loading = false;

const post = (m: WorkerResponse) => self.postMessage(m);

// postMessage itself can throw while the worker is tearing down; error reporting must not double-fault
const safePost = (m: WorkerResponse) => {
  try {
    post(m);
  } catch {
    // worker scope is gone; nothing left to report to
  }
};

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  const id = 'id' in msg ? msg.id : undefined;
  try {
    if (msg.type === 'load') {
      // no reload path: a second load must be rejected. wllama exposes exit() as the
      // unload primitive; a future unload+load pair (merged-model hot-swap, Task 14) can
      // reset these flags via exit() then load again
      if (loaded || loading) throw new Error('model already loaded or loading');
      loading = true;
      try {
        // Blob, not a URL: wllama's loadModelFromUrl rejects blob: URLs (they
        // don't end in ".gguf"), so the bytes cross the boundary as a Blob and
        // go straight into loadModel(). That path has no download-progress
        // callback (the bytes are already local); emit a single tick so the
        // loading screen shows real numbers instead of an indeterminate bar.
        post({ type: 'load_progress', loaded: msg.model.size, total: msg.model.size });
        await wllama.loadModel([msg.model], {
          n_ctx: msg.nCtx ?? 4096,
          // SPIKE verdict (docs/lora-spike.md): load-time lora_adapters exists in
          // LoadModelParams but no FS delivery path for the adapter file; runtime
          // switching has no API. adapterUrl is accepted in the protocol but ignored.
        });
        loaded = true;
        post({ type: 'loaded', loraSupported: false });
      } finally {
        loading = false;
      }
    } else if (msg.type === 'completion') {
      if (!loaded) throw new Error('model not loaded');
      if (controllers.has(msg.id)) throw new Error(`duplicate completion id: ${msg.id}`);
      const controller = new AbortController();
      controllers.set(msg.id, controller);
      try {
        const stream = await wllama.createChatCompletion({
          messages: toWllamaMessages(msg.params.messages),
          tools: msg.params.tools as ChatCompletionTool[] | undefined,
          tool_choice: msg.params.tool_choice,
          max_tokens: msg.params.max_tokens,
          temperature: msg.params.temperature,
          top_p: msg.params.top_p,
          top_k: msg.params.top_k,
          penalty_repeat: msg.params.repetition_penalty,
          stream: true,
          abortSignal: controller.signal,
        });
        for await (const chunk of stream) post({ type: 'chunk', id: msg.id, chunk: toChatChunk(chunk) });
        post({ type: 'done', id: msg.id });
      } finally {
        controllers.delete(msg.id);
      }
    } else if (msg.type === 'abort') {
      controllers.get(msg.id)?.abort();
    } else if (msg.type === 'set_adapter') {
      // no runtime LoRA API in @wllama/wllama 3.6.1; adapter manager hot-swaps
      // merged GGUFs instead (docs/lora-spike.md)
      post({
        type: 'adapter_set',
        ok: false,
        error: 'runtime LoRA switching is not supported by @wllama/wllama 3.6.1; use merged GGUFs',
      });
    } else {
      const unknownType = (msg as { type?: unknown }).type;
      post({ type: 'error', message: `unknown request type: ${String(unknownType)}` });
    }
  } catch (err) {
    if (err instanceof WllamaAbortError && id !== undefined) {
      // abort of a completion: report as done, not error
      safePost({ type: 'done', id });
    } else {
      safePost({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
    }
  }
};

export {};
