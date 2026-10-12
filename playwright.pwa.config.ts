import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/pwa',
  timeout: 45_000,
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  // Stop on the first reproducible failure; a green run still executes every case.
  maxFailures: process.env.CI ? 1 : undefined,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4175', serviceWorkers: 'allow', trace: 'retain-on-failure' },
  projects: [
    { name: 'pwa-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'pwa-mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'VITE_API_BASE_URL=http://127.0.0.1:4175 npm run build:web && node tests/pwa/server.mjs',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 180_000,
  },
});
