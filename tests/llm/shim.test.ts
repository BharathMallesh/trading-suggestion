import { describe, it, expect } from 'vitest';
import { WllamaChatModel } from '../../src/llm/shim';
import type { WorkerResponse } from '../../src/llm/protocol';

class MockWorker {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  posted: unknown[] = [];
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() {}
  emit(m: WorkerResponse) { this.onmessage?.({ data: m } as MessageEvent<WorkerResponse>); }
}

describe('WllamaChatModel', () => {
  it('yields chunks until done, then completes', async () => {
    const w = new MockWorker();
    const model = new WllamaChatModel(w as any, 'test-model');
    const p = model.createChatCompletionStream({ model: 'm', messages: [], stream: true });
    const it = (await p)[Symbol.asyncIterator]();
    w.emit({ type: 'chunk', id: 0, chunk: { choices: [{ delta: { content: 'he' } }] } });
    w.emit({ type: 'chunk', id: 0, chunk: { choices: [{ delta: { content: 'y' } }] } });
    w.emit({ type: 'done', id: 0 });
    const parts: string[] = [];
    let r = await it.next();
    while (!r.done) { parts.push((r.value as any).choices[0].delta.content); r = await it.next(); }
    expect(parts).toEqual(['he', 'y']);
  });
  it('rejects the stream on worker error', async () => {
    const w = new MockWorker();
    const model = new WllamaChatModel(w as any, 'm');
    const it = (await model.createChatCompletionStream({ model: 'm', messages: [], stream: true }))[Symbol.asyncIterator]();
    w.emit({ type: 'error', id: 0, message: 'boom' });
    await expect(it.next()).rejects.toThrow('boom');
  });
  it('abort() aborts in-flight requests', async () => {
    const w = new MockWorker();
    const model = new WllamaChatModel(w as any, 'm');
    const ac = new AbortController();
    const it = (await model.createChatCompletionStream({ model: 'm', messages: [], stream: true }, { signal: ac.signal }))[Symbol.asyncIterator]();
    ac.abort();
    await expect(it.next()).rejects.toThrow(/abort/i);
    expect(w.posted).toContainEqual({ type: 'abort', id: 0 });
  });
  it('breaking out of for-await releases the stream (return cleanup)', async () => {
    const w = new MockWorker();
    const model = new WllamaChatModel(w as any, 'm');
    const ac = new AbortController();
    const stream = await model.createChatCompletionStream({ model: 'm', messages: [], stream: true }, { signal: ac.signal });
    w.emit({ type: 'chunk', id: 0, chunk: { choices: [{ delta: { content: 'he' } }] } });
    for await (const chunk of stream) {
      expect((chunk as any).choices[0].delta.content).toBe('he');
      break;
    }
    // the abort listener must be detached: aborting now posts nothing for the abandoned id
    ac.abort();
    expect(w.posted).not.toContainEqual({ type: 'abort', id: 0 });
    // and the abandoned id no longer routes worker messages: a late done is dropped
    w.emit({ type: 'done', id: 0 });
    const it2 = (await model.createChatCompletionStream({ model: 'm', messages: [], stream: true }))[Symbol.asyncIterator]();
    w.emit({ type: 'chunk', id: 1, chunk: { choices: [{ delta: { content: 'ok' } }] } });
    const r = await it2.next();
    expect((r.value as any).choices[0].delta.content).toBe('ok');
  });
});
