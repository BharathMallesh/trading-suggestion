import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { restoreStorage } from '../../src/storage/index';
import { OpfsStorage } from '../../src/storage/opfs';

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

describe('restoreStorage', () => {
  beforeEach(() => {
    mocks.store.clear();
    delete (window as any).showDirectoryPicker; // jsdom has no picker by default
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as any).showDirectoryPicker;
  });

  it("returns ready with OPFS storage when the picker isn't supported", async () => {
    vi.spyOn(OpfsStorage, 'create').mockResolvedValue({ kind: 'opfs' } as unknown as OpfsStorage);
    const result = await restoreStorage();
    expect(result.status).toBe('ready');
    if (result.status === 'ready') expect(result.storage.kind).toBe('opfs');
  });

  it('returns no-handle when the picker exists but nothing is saved', async () => {
    (window as any).showDirectoryPicker = vi.fn();
    await expect(restoreStorage()).resolves.toEqual({ status: 'no-handle' });
  });
});
