import { describe, it, expect } from 'vitest';
import { FakeStorage } from '../helpers/fake-storage';
import { AdapterManager } from '../../src/adapters/manager';

describe('AdapterManager', () => {
  it('lists adapters from registry.json and marks the active one', async () => {
    const s = new FakeStorage();
    await s.writeText(
      'adapters/registry.json',
      JSON.stringify({
        contexts: { support: 'adapters/support/adapter.gguf', legal: 'adapters/legal/adapter.gguf' },
      }),
    );
    await s.writeText('adapters/support/adapter.gguf', 'gguf-bytes');
    const m = new AdapterManager(s);
    expect(await m.listContexts()).toEqual(['legal', 'support']);
    await m.activate('support');
    expect(await m.activeContext()).toBe('support');
  });

  it('returns null active context on fresh storage', async () => {
    expect(await new AdapterManager(new FakeStorage()).activeContext()).toBeNull();
  });

  it('rejects activating an unknown context', async () => {
    const s = new FakeStorage();
    await s.writeText('adapters/registry.json', JSON.stringify({ contexts: {} }));
    await expect(new AdapterManager(s).activate('nope')).rejects.toThrow(/unknown/i);
  });

  it('rejects activating a context whose adapter file is missing', async () => {
    const s = new FakeStorage();
    await s.writeText(
      'adapters/registry.json',
      JSON.stringify({ contexts: { support: 'adapters/support/adapter.gguf' } }),
    );
    const m = new AdapterManager(s);
    expect(await m.listContexts()).toEqual(['support']);
    await expect(m.activate('support')).rejects.toThrow(/missing/i);
  });

  it('writes active.json with {context, path} on activation', async () => {
    const s = new FakeStorage();
    await s.writeText(
      'adapters/registry.json',
      JSON.stringify({ contexts: { legal: 'adapters/legal/merged.gguf' } }),
    );
    await s.writeText('adapters/legal/merged.gguf', 'gguf-bytes');
    await new AdapterManager(s).activate('legal');
    expect(JSON.parse(await s.readText('adapters/active.json'))).toEqual({
      context: 'legal',
      path: 'adapters/legal/merged.gguf',
    });
  });

  it('accepts a path to a merged full-model GGUF (build-time merge fallback)', async () => {
    const s = new FakeStorage();
    await s.writeText(
      'adapters/registry.json',
      JSON.stringify({ contexts: { legal: 'models/legal-merged.gguf' } }),
    );
    await s.writeText('models/legal-merged.gguf', 'gguf-bytes');
    const m = new AdapterManager(s);
    expect(await m.adapterPath('legal')).toBe('models/legal-merged.gguf');
    await m.activate('legal');
    expect(await m.activeContext()).toBe('legal');
  });

  it('reports a clear error for corrupt registry.json', async () => {
    const s = new FakeStorage();
    await s.writeText('adapters/registry.json', '{ not json');
    await expect(new AdapterManager(s).listContexts()).rejects.toThrow(/adapters\/registry\.json/);
  });

  it('reports a clear error for corrupt active.json', async () => {
    const s = new FakeStorage();
    await s.writeText('adapters/active.json', '[ oops');
    await expect(new AdapterManager(s).activeContext()).rejects.toThrow(/adapters\/active\.json/);
  });
});
