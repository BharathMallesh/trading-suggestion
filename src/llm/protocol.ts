import type { ChatChunk, ChatMessage } from '@core/chat-model';

export interface LoadModelRequest {
  type: 'load';
  /**
   * Bytes of the base GGUF. Transported as a Blob because wllama's
   * loadModelFromUrl validates that URLs end in ".gguf" and so rejects the
   * blob: URLs the app would otherwise have to use; the worker passes the
   * Blob straight to wllama's loadModel() instead.
   */
  model: Blob;
  adapterUrl?: string; // LoRA adapter GGUF, if supported (see docs/lora-spike.md)
  nCtx?: number;
}

export interface CompletionRequest {
  type: 'completion';
  id: number;
  params: {
    messages: ChatMessage[]; // normalized to wllama's shape in the worker
    tools?: unknown[]; // agent-core types these as unknown[]; asserted at the worker boundary
    tool_choice?: 'auto';
    max_tokens?: number;
    temperature?: number;
    stream: true;
  };
}

export interface SwitchAdapterRequest {
  type: 'set_adapter';
  adapterUrl: string | null;
}

export type WorkerRequest =
  | LoadModelRequest
  | CompletionRequest
  | SwitchAdapterRequest
  | { type: 'abort'; id: number };

// Lifecycle contract:
// - 'load'     -> any number of load_progress, then exactly one loaded or error (terminal).
//                 Completions are only accepted after loaded.
// - 'completion' -> zero or more chunk, then exactly one done, or one error.
//                 A mid-stream error is terminal: no done follows it.
//                 An abort yields done (not error).
// - 'abort'    -> no direct response; it turns the matching completion into done.
// - 'set_adapter' -> exactly one adapter_set.
export type WorkerResponse =
  | { type: 'load_progress'; loaded: number; total: number }
  | { type: 'loaded'; loraSupported: boolean }
  | { type: 'chunk'; id: number; chunk: ChatChunk }
  | { type: 'done'; id: number }
  | { type: 'error'; id?: number; message: string }
  | { type: 'adapter_set'; ok: boolean; error?: string };
