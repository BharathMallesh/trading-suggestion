import type { StorageProvider } from '@core/storage';

interface Registry {
  contexts: Record<string, string>;
}

function parseJsonFile(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Corrupt JSON in ${path}: ${(e as Error).message}`);
  }
}

/**
 * Maps adapter contexts to artifact paths and persists the active selection.
 * Artifact-agnostic: per the Task 11 spike (docs/lora-spike.md) wllama 3.6.1
 * has no runtime LoRA API, so a context's path may be a build-time merged
 * full-model GGUF rather than a bare adapter. Swapping models in the worker
 * (unload + reload) is the caller's job (Task 15 UI glue); activate() only
 * persists the selection.
 */
export class AdapterManager {
  private storage: StorageProvider;

  constructor(storage: StorageProvider) {
    this.storage = storage;
  }

  private async readRegistry(): Promise<Registry> {
    if (!(await this.storage.exists('adapters/registry.json'))) return { contexts: {} };
    const parsed = parseJsonFile(await this.storage.readText('adapters/registry.json'), 'adapters/registry.json');
    const contexts = (parsed as Registry).contexts;
    if (!contexts || typeof contexts !== 'object') return { contexts: {} };
    return { contexts };
  }

  async listContexts(): Promise<string[]> {
    return Object.keys((await this.readRegistry()).contexts).sort();
  }

  async adapterPath(context: string): Promise<string | null> {
    return (await this.readRegistry()).contexts[context] ?? null;
  }

  async activeContext(): Promise<string | null> {
    if (!(await this.storage.exists('adapters/active.json'))) return null;
    const parsed = parseJsonFile(await this.storage.readText('adapters/active.json'), 'adapters/active.json');
    const context = (parsed as { context?: unknown }).context;
    return typeof context === 'string' ? context : null;
  }

  /** Persist selection; the caller then reloads the worker with the
      artifact for this context (merged-model fallback, see class doc). */
  async activate(context: string): Promise<void> {
    const path = await this.adapterPath(context);
    if (!path) throw new Error(`Unknown adapter context: ${context}`);
    if (!(await this.storage.exists(path))) throw new Error(`Adapter file missing: ${path}`);
    await this.storage.writeText('adapters/active.json', JSON.stringify({ context, path }));
  }
}
