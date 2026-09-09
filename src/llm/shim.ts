// ChatModel over the wllama worker protocol (src/llm/protocol.ts).
// Owns request id allocation, routes worker messages back to the right
// pending stream, and translates abort/done/error into iterator semantics.
import type { ChatModel, ChatCompletionParams, ChatChunk } from '@core/chat-model';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { createWllamaWorker } from './worker-client';

interface Pending {
  queue: ChatChunk[];
  resolve: (() => void) | null;
  error: Error | null;
  done: boolean;
  onAbort: (() => void) | null;
}

const abortError = () => new DOMException('The operation was aborted', 'AbortError');

export class WllamaChatModel implements ChatModel {
  private worker: Worker;
  readonly model: string;
  private nextId = 0;
  private pending = new Map<number, Pending>();

  constructor(worker: Worker, model: string) {
    this.worker = worker;
    this.model = model;
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
  }

  // id-bearing responses route to their stream; a bare error (e.g. 'model not
  // loaded') faults every in-flight stream since the worker can't attribute it
  private onMessage(msg: WorkerResponse): void {
    if (msg.type === 'chunk' || msg.type === 'done') {
      const p = this.pending.get(msg.id);
      if (!p) return; // stale message for an already-finished stream (e.g. post-abort done)
      if (msg.type === 'chunk') p.queue.push(msg.chunk);
      else p.done = true;
      p.resolve?.();
    } else if (msg.type === 'error') {
      const err = new Error(msg.message);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        p.error = err; // mid-stream error is terminal; no done follows
        p.resolve?.();
      } else {
        for (const p of this.pending.values()) {
          p.error = err;
          p.resolve?.();
        }
      }
    }
    // load_progress / loaded / adapter_set belong to the model-load flow (Task 13/14)
  }

  // idempotent: guards against a woken next() racing the abort handler
  private finish(id: number, p: Pending): void {
    if (this.pending.get(id) !== p) return;
    this.pending.delete(id);
    if (p.onAbort) {
      p.onAbort();
      p.onAbort = null;
    }
  }

  async createChatCompletionStream(
    params: ChatCompletionParams,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<ChatChunk>> {
    const signal = options?.signal;
    if (signal?.aborted) throw abortError();

    const id = this.nextId++;
    const p: Pending = { queue: [], resolve: null, error: null, done: false, onAbort: null };
    this.pending.set(id, p);

    if (signal) {
      const onAbort = () => {
        this.worker.postMessage({ type: 'abort', id } satisfies WorkerRequest);
        p.error = abortError();
        this.finish(id, p); // worker's trailing done for this id is ignored (pending gone)
        p.resolve?.();
      };
      p.onAbort = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort);
    }

    // params.messages is plain data from the agent loop; nothing non-cloneable is attached
    const req: WorkerRequest = {
      type: 'completion',
      id,
      params: {
        messages: params.messages,
        tools: params.tools,
        tool_choice: params.tool_choice,
        stream: true,
      },
    };
    this.worker.postMessage(req);

    const finish = () => this.finish(id, p);
    return {
      [Symbol.asyncIterator]() {
        return {
          // single-consumer serial iterator per the AsyncIterable contract;
          // p.resolve being a single slot is safe because next() is never
          // called concurrently on one iterator instance
          async next(): Promise<IteratorResult<ChatChunk>> {
            for (;;) {
              if (p.error) {
                finish();
                throw p.error;
              }
              if (p.queue.length) return { value: p.queue.shift()!, done: false };
              if (p.done) {
                finish();
                return { value: undefined, done: true };
              }
              await new Promise<void>((r) => {
                p.resolve = r;
              });
              p.resolve = null;
            }
          },
          // consumer broke out of for-await early: release the pending entry
          // and detach the abort listener
          return(): Promise<IteratorResult<ChatChunk>> {
            finish();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }
}

// spawn a real worker and wrap it; the import of createWllamaWorker above is what
// makes Vite emit the worker chunk
export function createWllamaChatModel(modelName: string): WllamaChatModel {
  return new WllamaChatModel(createWllamaWorker(), modelName);
}
