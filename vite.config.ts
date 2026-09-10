/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      workbox: {
        // wllama.wasm is ~8.5MB; default 2MB precache limit would drop it
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        // md: setup seeds bundled skills from /skills-builtin/** offline (Task 13)
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,wasm,md}'],
        // SPA fallback so an offline reload of any route serves the precached shell.
        // Deliberately no 'gguf' in globPatterns: models live in user storage (OPFS),
        // not the precache — the e2e fixture under public/fixtures stays network-only.
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'AutoClaw Offline Agents',
        short_name: 'AutoClaw',
        display: 'standalone',
        start_url: '/',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  resolve: { alias: { '@core': path.resolve(import.meta.dirname, 'src/agent-core') } },
  // the wllama worker chunk is emitted automatically: main.tsx -> llm/shim.ts
  // -> worker-client.ts -> new Worker(new URL('./wllama-worker.ts', ...))
  // wllama multi-threading requires cross-origin isolation
  server: { headers: { // 'credentialless' keeps cross-origin isolation (wllama multi-threading /
// SharedArrayBuffer) while still allowing third-party resources like the
// Clerk auth widget to load without CORP headers. (Chrome/Edge/Firefox; on
// Safari, isolation degrades gracefully to single-threaded inference.)
'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Opener-Policy': 'same-origin' } },
  preview: { headers: { // 'credentialless' keeps cross-origin isolation (wllama multi-threading /
// SharedArrayBuffer) while still allowing third-party resources like the
// Clerk auth widget to load without CORP headers. (Chrome/Edge/Firefox; on
// Safari, isolation degrades gracefully to single-threaded inference.)
'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Opener-Policy': 'same-origin' } },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'] },
});
