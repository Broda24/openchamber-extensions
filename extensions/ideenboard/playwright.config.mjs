import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 15_000,
  use: { headless: true, viewport: { width: 600, height: 900 } },
  reporter: 'list',
});
