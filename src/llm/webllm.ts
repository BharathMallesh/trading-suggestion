// WebGPU engine ("Turbo") implementing the same ChatModel seam as the wllama
// engine, so the Agent doesn't care which one it's talking to. Runs web-llm in
// a worker; streams OpenAI-shaped chunks that already match ChatChunk.
import { CreateWebWorkerMLCEngine } from '@mlc-ai/web-llm';
import type { MLCEngineInterface, InitProgressReport } from '@mlc-ai/web-llm';
import type { ChatModel, ChatCompletionParams, ChatChunk } from '@core/chat-model';

// Turbo model: small enough to download once and fast on the GPU, but smarter
// than the tiny CPU default (fewer tool-loop tangents). Supports tool calls.
export const TURBO_MODEL = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';

export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as any).gpu;
}

export class WebLLMChatModel implements ChatModel {
  constructor(
    private engine: MLCEngineInterface,
    readonly model: string,
  ) {}

  async createChatCompletionStream(
    params: ChatCompletionParams,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<ChatChunk>> {
    const signal = options?.signal;
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');

    // NOTE: web-llm only supports function calling on a few large Hermes models
    // — Qwen2.5 throws UnsupportedModelIdError when `tools` is set, which made
    // Turbo error on every message. So the Turbo engine is deliberately
    // chat-only: we drop tools rather than crash. Tool-driven actions (memory,
    // schedules, files) run on the default wllama engine instead.
    const stream = await this.engine.chat.completions.create({
      messages: params.messages as any,
      temperature: params.temperature,
      top_p: params.top_p,
      max_tokens: params.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
    });

    const engine = this.engine;
    const onAbort = () => void engine.interruptGenerate();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    return (async function* () {
      try {
        for await (const chunk of stream) {
          // web-llm chunks are already OpenAI-shaped (choices[].delta + usage).
          yield chunk as unknown as ChatChunk;
        }
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    })();
  }
}

/** Spawn the web-llm worker and load the Turbo model, reporting progress. */
export async function createWebLLMChatModel(
  modelId: string = TURBO_MODEL,
  onProgress?: (report: InitProgressReport) => void,
): Promise<{ model: WebLLMChatModel; engine: MLCEngineInterface }> {
  const worker = new Worker(new URL('./webllm-worker.ts', import.meta.url), { type: 'module' });
  const engine = await CreateWebWorkerMLCEngine(worker, modelId, { initProgressCallback: onProgress });
  return { model: new WebLLMChatModel(engine, modelId), engine };
}
