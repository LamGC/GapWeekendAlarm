import { defineConfig } from '@playwright/test';

// In-process Worker contracts and SQLite migrations, no browser/network/runtime.
export default defineConfig({
  testDir: './tests/worker',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
});
