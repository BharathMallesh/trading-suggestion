import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // Setup + two model loads (online pass, offline pass) on a wasm LLM: generous.
  timeout: 300_000,
  // Fetches the fixture model into public/fixtures/ before the server starts.
  globalSetup: './e2e/global-setup.ts',
  webServer: { command: 'npm run preview', port: 4173, reuseExistingServer: true },
  use: { baseURL: 'http://localhost:4173' },
});
