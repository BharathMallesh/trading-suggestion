import { test, expect } from '@playwright/test';

// Served by vite preview from public/fixtures/ (downloaded once per machine by
// the global setup — see e2e/global-setup.ts for why this model and not a
// ~2MB TinyStories one).
const FIXTURE_URL = '/fixtures/qwen2.5-0.5b-instruct-q2_k.gguf';

test('app loads and chats fully offline', async ({ page, context }) => {
  // First pass ONLINE: install SW + run setup with the fixture model pulled
  // into OPFS via the ?modelUrl= override in resolveAssetSpecs().
  await page.goto(`/?modelUrl=${FIXTURE_URL}`);
  // Wait until the SW is active: precache (incl. the 8.5MB wllama wasm)
  // completes during install, before activation.
  await expect
    .poll(async () =>
      page.evaluate(() => navigator.serviceWorker?.ready.then((r) => r.active?.state ?? null)),
    )
    .toBe('activated');

  // Seed OPFS instead of the folder picker: OPFS keeps headless CI simple.
  await page.getByRole('button', { name: /use built-in/i }).click();
  // Setup has no "complete" screen: after downloads it boots the model and
  // lands on the chat UI. The textbox is the setup-done signal.
  const composer = page.getByRole('textbox');
  await expect(composer).toBeVisible({ timeout: 120_000 });

  // Second pass OFFLINE: the SW serves the shell from precache; the model is
  // read back out of OPFS (no network). The query param must survive reload.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('textbox')).toBeVisible({ timeout: 120_000 });

  await page.getByRole('textbox').fill('Say hi');
  await page.getByRole('button', { name: /send/i }).click();
  await expect(page.locator('.assistant-message').last()).not.toBeEmpty({ timeout: 120_000 });
});
