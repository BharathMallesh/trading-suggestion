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
  const config = {
    maxSteps: 25,
    autoConfirm: false,
    _emit: onEvent,
    _confirm: (id: string) =>
      new Promise<boolean>((ok) => {
        confirmResolvers.set(id, ok);
      }),
  };
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
    const bytes = await storage.readBytes(modelPath);
    await loadWorkerModel(worker, new Blob([bytes as Uint8Array<ArrayBuffer>]), onProgress);
    return worker;
  } catch (err) {
    worker.terminate();
    throw err;
  }
}
