// Owns the runtime graph for one app session: tool registry -> Agent over the
// wllama worker, with confirmation gating bridged to the UI via confirmResolvers.
import { Agent } from '@core/agent';
import { buildToolRegistry } from '@core/tools';
import type { AgentEventSink } from '@core/events';
import type { StorageProvider } from '@core/storage';
import { WllamaChatModel } from '../llm/shim';
import { createWllamaWorker } from '../llm/worker-client';
import type { WorkerRequest, WorkerResponse } from '../llm/protocol';

export interface AgentHost {
  agent: Agent;
  worker: Worker;
  resolveConfirm: (id: string, ok: boolean) => void;
}

export function createAgentHost(
  storage: StorageProvider,
  worker: Worker,
  model: string,
  onEvent: AgentEventSink,
): AgentHost {
  buildToolRegistry(storage, { online: typeof navigator !== 'undefined' ? navigator.onLine : false });
  const confirmResolvers = new Map<string, (ok: boolean) => void>();
  // Dynamic configuration based on the model type
  const isThinkingModel = model.toLowerCase().includes('r1') || model.toLowerCase().includes('reasoning') || model.toLowerCase().includes('think');
  
  // Base configuration
  const config: any = {
    maxSteps: 25,
    autoConfirm: false,
    _emit: onEvent,
    _confirm: (id: string) =>
      new Promise<boolean>((ok) => {
        confirmResolvers.set(id, ok);
      }),
  };

  // Assign model-specific sampling parameters
  if (isThinkingModel) {
    // Thinking mode defaults (e.g., DeepSeek-R1 recommends temp=0.6, top_p=0.95)
    config.temperature = 0.6;
    config.top_p = 0.95;
    config.top_k = 50;
    config.repetition_penalty = 1.0; // Reasoning models usually shouldn't have high repetition penalties
    config.isThinkingMode = true;
  } else if (model.toLowerCase().includes('qwen')) {
    // Qwen specific defaults
    config.temperature = 0.7;
    config.top_p = 0.8;
    config.top_k = 40;
    config.repetition_penalty = 1.05;
  } else if (model.toLowerCase().includes('llama')) {
    // Llama specific defaults
    config.temperature = 0.8;
    config.top_p = 0.9;
    config.top_k = 40;
    config.repetition_penalty = 1.1;
  } else {
    // Generic fallback defaults
    config.temperature = 0.7;
    config.top_p = 0.9;
    config.top_k = 40;
    config.repetition_penalty = 1.1;
  }

  const agent = new Agent(new WllamaChatModel(worker, model), model, config, storage, onEvent);
  return {
    agent,
    worker,
    resolveConfirm: (id: string, ok: boolean) => {
      confirmResolvers.get(id)?.(ok);
      confirmResolvers.delete(id);
    },
  };
}

/**
 * Drive the worker's load lifecycle until exactly one `loaded` or `error`
 * arrives (completions are only accepted after loaded). Replaces
 * worker.onmessage; the shim installs its own handler when the host is built.
 */
export function loadWorkerModel(
  worker: Worker,
  model: Blob,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'load_progress') {
        onProgress?.(msg.loaded, msg.total);
      } else if (msg.type === 'loaded') {
        resolve();
      } else if (msg.type === 'error') {
        reject(new Error(msg.message));
      }
    };
    worker.postMessage({ type: 'load', model } satisfies WorkerRequest);
  });
}

/** Spawn a fresh worker and load a model file from storage into it. */
export async function bootWorker(
  storage: StorageProvider,
  modelPath: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Worker> {
  const worker = createWllamaWorker();
  try {
    // readFile() returns the raw Blob without an extra Uint8Array copy; the
    // model GGUF may be hundreds of MiB so avoiding redundant in-memory copies matters.
    const blob = await storage.readFile(modelPath);
    await loadWorkerModel(worker, blob, onProgress);
    return worker;
  } catch (err) {
    worker.terminate();
    throw err;
  }
}
