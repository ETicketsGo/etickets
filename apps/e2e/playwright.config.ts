import { defineConfig, devices } from '@playwright/test';

/**
 * E2E across the three web apps. Servers are expected to be running
 * (api :4000, customer :3000, organizer :3001, admin :3002) with the DB seeded.
 * In CI the workflow starts them before invoking Playwright.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
