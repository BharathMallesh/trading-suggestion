import type { ChatChunk } from '@core/chat-model';

export interface LoadModelRequest {
  type: 'load';
  modelUrl: string; // served URL or blob URL for the base GGUF
  adapterUrl?: string; // LoRA adapter GGUF, if supported (see docs/lora-spike.md)
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

export interface SwitchAdapterRequest {
  type: 'set_adapter';
  adapterUrl: string | null;
}

export type WorkerRequest =
  | LoadModelRequest
  | CompletionRequest
  | SwitchAdapterRequest
  | { type: 'abort'; id: number };

export type WorkerResponse =
  | { type: 'load_progress'; loaded: number; total: number }
  | { type: 'loaded'; loraSupported: boolean }
  | { type: 'chunk'; id: number; chunk: ChatChunk }
  | { type: 'done'; id: number }
  | { type: 'error'; id?: number; message: string }
  | { type: 'adapter_set'; ok: boolean; error?: string };
