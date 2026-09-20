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
    /*
      Every test runs as a visitor IN INDIA, because that is where the seeded inventory is.
      Discovery scopes to the visitor's country whether or not we sell there, so a browser
      reporting a US clock would meet an empty storefront and dozens of tests would fail on
      a catalogue that is working exactly as designed.
      The zone is what decides it: `visitorCountry()` reads the IANA time zone first and only
      then the language. That is deliberate here — the French suite keeps its fr-CA locale for
      the UI while still shopping in the country the events are in.
    */
    timezoneId: 'Asia/Kolkata',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
