export interface AssetSpec {
  /** https URL (first download only; the app is offline afterwards). */
  url: string;
  /** folder-relative destination */
  path: string;
  /** expected size in bytes; when set, an existing file of this size is skipped */
  size?: number;
  /** optional integrity check */
  sha256?: string;
}

export const BASE_MODEL: AssetSpec = {
  url: 'https://huggingface.co/<USER>/Qwen3.5-0.8B-Q5_K_M/resolve/main/Qwen3.5-0.8B-Q5_K_M.gguf',
  path: 'models/Qwen3.5-0.8B-Q5_K_M.gguf',
};

export const ADAPTERS: AssetSpec[] = [
  // { url: '.../adapter-support.gguf', path: 'adapters/support/adapter.gguf' },
];

/**
 * The assets to fetch during setup. `?modelUrl=<url>` overrides BASE_MODEL's
 * url (used by the e2e suite to point at a tiny fixture GGUF, and by anyone
 * wanting to swap models without a rebuild).
 */
export function resolveAssetSpecs(): AssetSpec[] {
  let override: string | null = null;
  try {
    if (typeof location !== 'undefined') {
      override = new URLSearchParams(location.search).get('modelUrl');
    }
  } catch {
    override = null; // non-browser environment (tests, SSR)
  }
  const model = override ? { ...BASE_MODEL, url: override } : BASE_MODEL;
  return [model, ...ADAPTERS];
}
