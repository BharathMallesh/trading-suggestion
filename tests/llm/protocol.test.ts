import { describe, it, expect } from 'vitest';
import type {
  WorkerRequest,
  WorkerResponse,
  LoadModelRequest,
  CompletionRequest,
  SwitchAdapterRequest,
} from '../../src/llm/protocol';

const clone = <T>(value: T): T => structuredClone(value);

describe('worker protocol', () => {
  it('load request round-trips through structuredClone', () => {
    const req: LoadModelRequest = {
      type: 'load',
      modelUrl: 'https://example.com/model.gguf',
      adapterUrl: 'https://example.com/adapter.gguf',
      nCtx: 8192,
    };
    const rt = clone<WorkerRequest>(req);
    expect(rt.type).toBe('load');
    if (rt.type === 'load') {
      expect(rt.modelUrl).toBe(req.modelUrl);
      expect(rt.adapterUrl).toBe(req.adapterUrl);
      expect(rt.nCtx).toBe(8192);
    }
  });

  it('completion request round-trips through structuredClone', () => {
    const req: CompletionRequest = {
      type: 'completion',
      id: 7,
      params: {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'f' } }],
        tool_choice: 'auto',
        max_tokens: 128,
        temperature: 0.7,
        stream: true,
      },
    };
    const rt = clone<WorkerRequest>(req);
    expect(rt.type).toBe('completion');
    if (rt.type === 'completion') {
      expect(rt.id).toBe(7);
      expect(rt.params.stream).toBe(true);
      expect(rt.params.tool_choice).toBe('auto');
    }
  });

  it('set_adapter and abort requests round-trip through structuredClone', () => {
    const setAdapter: SwitchAdapterRequest = { type: 'set_adapter', adapterUrl: null };
    const rt1 = clone<WorkerRequest>(setAdapter);
    expect(rt1.type).toBe('set_adapter');
    if (rt1.type === 'set_adapter') expect(rt1.adapterUrl).toBeNull();

    const rt2 = clone<WorkerRequest>({ type: 'abort', id: 7 });
    expect(rt2.type).toBe('abort');
    if (rt2.type === 'abort') expect(rt2.id).toBe(7);
  });

  it('every response variant keeps its type discriminant', () => {
    const responses: WorkerResponse[] = [
      { type: 'load_progress', loaded: 10, total: 100 },
      { type: 'loaded', loraSupported: false },
      { type: 'chunk', id: 1, chunk: { choices: [{ delta: { content: 'a' } }] } },
      { type: 'done', id: 1 },
      { type: 'error', id: 1, message: 'boom' },
      { type: 'error', message: 'load failed' },
      { type: 'adapter_set', ok: false, error: 'not supported' },
      { type: 'adapter_set', ok: true },
    ];
    for (const res of responses) {
      const rt = clone<WorkerResponse>(res);
      expect(rt.type).toBe(res.type);
    }
  });
});
