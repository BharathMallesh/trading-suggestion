/// <reference lib="webworker" />
import { Wllama, WllamaAbortError, LoggerWithoutDebug } from '@wllama/wllama/esm/index.js';
import type { ChatCompletionParams, ChatCompletionChunk } from '@wllama/wllama/esm/index.js';
import type { WorkerRequest, WorkerResponse } from './protocol';
import type { ChatChunk } from '@core/chat-model';

// wllama chunks allow null where agent-core ChatChunk does not; normalize at the boundary
const toChatChunk = (c: ChatCompletionChunk): ChatChunk => ({
  choices: c.choices.map((ch) => ({
    delta: { content: ch.delta.content ?? undefined, tool_calls: ch.delta.tool_calls },
    finish_reason: ch.finish_reason,
  })),
  usage: c.usage ?? undefined,
});

// v3.6.1 ships a single wasm with pthread support; 'default' is the only key read at runtime
const wllama = new Wllama({ default: '/wllama-wasm/wllama.wasm' }, { logger: LoggerWithoutDebug });

const controllers = new Map<number, AbortController>();
let loaded = false;

const post = (m: WorkerResponse) => self.postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await wllama.loadModelFromUrl(msg.modelUrl, {
        n_ctx: msg.nCtx ?? 4096,
        // SPIKE verdict (docs/lora-spike.md): load-time lora_adapters exists in
        // LoadModelParams but no FS delivery path for the adapter file; runtime
        // switching has no API. adapterUrl is accepted in the protocol but ignored.
        progressCallback: ({ loaded, total }) => post({ type: 'load_progress', loaded, total }),
      });
      loaded = true;
      post({ type: 'loaded', loraSupported: false });
    } else if (msg.type === 'completion') {
      if (!loaded) throw new Error('model not loaded');
      const controller = new AbortController();
      controllers.set(msg.id, controller);
      try {
        const stream = await wllama.createChatCompletion({
          ...(msg.params as Omit<ChatCompletionParams, 'stream'>),
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
    }
  } catch (err) {
    if (err instanceof WllamaAbortError) {
      post({ type: 'done', id: (msg as { id?: number }).id ?? -1 });
    } else {
      post({ type: 'error', id: (msg as { id?: number }).id, message: err instanceof Error ? err.message : String(err) });
    }
  }
};

export {};
