import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Pixel 7'],
      },
    },
  ],
  webServer: [
    {
      command:
        'bash -lc "cd apps/worker && rm -rf .wrangler/state/v3/d1 && npx wrangler d1 migrations apply gap-weekend-alarm --local --config wrangler.test.toml && npx wrangler dev --local --ip 127.0.0.1 --port 8787 --config wrangler.test.toml"',
      url: 'http://127.0.0.1:8787/api/v1/health',
      timeout: 180_000,
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev --workspace apps/web -- --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
