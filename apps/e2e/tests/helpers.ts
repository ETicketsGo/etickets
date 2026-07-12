import { expect, type Page } from '@playwright/test';

export const CUSTOMER = process.env.CUSTOMER_URL ?? 'http://localhost:3000';
export const ORGANIZER = process.env.ORGANIZER_URL ?? 'http://localhost:3001';
export const ADMIN = process.env.ADMIN_URL ?? 'http://localhost:3002';

export const SEED_PASSWORD = 'Password123!';

export function uniqueEmail(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}@e2e.test`;
}

/** Signs in through a LoginForm page (prefilled email may be overridden). */
export async function login(page: Page, baseUrl: string, email?: string) {
  await page.goto(`${baseUrl}/login`);
  if (email) {
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(SEED_PASSWORD);
  }
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
}

export function futureLocal(daysAhead: number, hour: number): string {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  d.setHours(hour, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
