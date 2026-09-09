import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveHandle, loadHandle, clearHandle, queryPermission, requestPermission } from '../../src/storage/handle-store';

const mocks = vi.hoisted(() => ({ store: new Map<string, unknown>() }));

vi.mock('idb-keyval', () => ({
  get: async (k: string) => mocks.store.get(k),
  set: async (k: string, v: unknown) => {
    mocks.store.set(k, v);
  },
  del: async (k: string) => {
    mocks.store.delete(k);
  },
}));

function fakeHandle(overrides: Record<string, unknown> = {}) {
  return { kind: 'directory', ...overrides } as unknown as FileSystemDirectoryHandle;
}

describe('handle-store', () => {
  beforeEach(() => mocks.store.clear());

  it('loadHandle returns undefined when nothing was saved', async () => {
    expect(await loadHandle()).toBeUndefined();
  });

  it('save/load round-trips the handle', async () => {
    const handle = fakeHandle();
    await saveHandle(handle);
    expect(await loadHandle()).toBe(handle);
  });

  it('clearHandle removes the saved handle', async () => {
    await saveHandle(fakeHandle());
    await clearHandle();
    expect(await loadHandle()).toBeUndefined();
  });

  it('queryPermission returns the handle status', async () => {
    await expect(queryPermission(fakeHandle({ queryPermission: async () => 'granted' }))).resolves.toBe('granted');
    await expect(queryPermission(fakeHandle({ queryPermission: async () => 'prompt' }))).resolves.toBe('prompt');
  });

  it('queryPermission returns "denied" instead of throwing', async () => {
    const noMethod = fakeHandle();
    const throwing = fakeHandle({
      queryPermission: async () => {
        throw new Error('boom');
      },
    });
    await expect(queryPermission(noMethod)).resolves.toBe('denied');
    await expect(queryPermission(throwing)).resolves.toBe('denied');
  });

  it('requestPermission returns true only when granted', async () => {
    await expect(requestPermission(fakeHandle({ requestPermission: async () => 'granted' }))).resolves.toBe(true);
    await expect(requestPermission(fakeHandle({ requestPermission: async () => 'prompt' }))).resolves.toBe(false);
  });

  it('requestPermission returns false instead of throwing', async () => {
    const noMethod = fakeHandle();
    const throwing = fakeHandle({
      requestPermission: async () => {
        throw new Error('boom');
      },
    });
    await expect(requestPermission(noMethod)).resolves.toBe(false);
    await expect(requestPermission(throwing)).resolves.toBe(false);
  });
});
