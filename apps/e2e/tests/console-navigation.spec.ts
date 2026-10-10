import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ORGANIZER, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * The console navigation, driven the way a keyboard user drives it.
 *
 * Organizer and admin share one shell (`AppShell` + `sidebar-nav.tsx`), so the same claims
 * are checked in both: groups start folded except the current one, Ctrl+K finds a page by
 * name, the collapsed rail is a row of NAMED group buttons whose tooltip shows on focus and
 * whose flyout opens, walks and closes from the keyboard, and the sidebar never adds a
 * second scroll at a 768px-tall window.
 *
 * Found by role and name only: if a test cannot find a control that way, neither can a
 * screen reader.
 */

const SIDEBAR_KEY = 'etg_sidebar_collapsed';

async function setRail(page: Page, collapsed: boolean) {
  await page.addInitScript(([key, on]) => localStorage.setItem(key as string, on ? '1' : '0'), [
    SIDEBAR_KEY,
    collapsed,
  ] as const);
}

for (const app of [
  {
    name: 'organizer',
    base: ORGANIZER,
    email: 'owner@eticketsgo.test',
    home: '/organizer',
    nav: 'Main',
    // A page in a group that is folded on the home page, and a word to find it by.
    target: { query: 'payouts', label: 'Payouts', url: /\/organizer\/payouts$/ },
    group: 'Business',
    groupLink: 'Finance & payouts',
    // The page whose open group is the longest: the worst case for a short window.
    tallest: '/organizer/payouts',
    drawer: 'Navigation',
  },
  {
    name: 'admin',
    base: ADMIN,
    email: 'admin@eticketsgo.test',
    home: '/admin',
    nav: 'Admin',
    target: { query: 'settle', label: 'Settlements', url: /\/admin\/settlements$/ },
    group: 'Payouts & reconciliation',
    groupLink: 'Payouts',
    tallest: '/admin/payment-config',
    drawer: 'Admin menu',
  },
]) {
  test.describe(`${app.name} navigation`, () => {
    let tokens: AuthTokens;
    test.beforeAll(async ({ request }) => {
      // Minted once: the auth throttle counts requests, not logins.
      tokens = await apiLogin(request, app.email);
    });
    test.beforeEach(async ({ context }) => {
      await seedBrowserAuth(context, tokens);
    });

    test('only the group holding the current page starts open', async ({ page }) => {
      await setRail(page, false);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${app.base}${app.home}`);
      const nav = page.getByRole('navigation', { name: app.nav });
      const group = nav.getByRole('button', { name: app.group, exact: true });
      await expect(group).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 });
      await expect(nav.getByRole('link', { name: app.groupLink, exact: true })).toBeHidden();
      await group.click();
      await expect(group).toHaveAttribute('aria-expanded', 'true');
      await expect(nav.getByRole('link', { name: app.groupLink, exact: true })).toBeVisible();
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    });

    test('Ctrl+K finds a page by name and Enter opens it', async ({ page }) => {
      await setRail(page, false);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${app.base}${app.home}`);
      await expect(page.getByRole('button', { name: /Find a page/ })).toBeVisible({
        timeout: 30_000,
      });
      await page.keyboard.press('Control+k');
      const dialog = page.getByRole('dialog', { name: 'Find a page' });
      await expect(dialog).toBeVisible();
      const field = dialog.getByRole('combobox', { name: 'Page name' });
      await expect(field).toBeFocused();
      await field.fill(app.target.query);
      await expect(dialog.getByRole('option').first()).toContainText(app.target.label);
      await expect(dialog.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(app.target.url);
      await expect(dialog).toBeHidden();
      // And the group it lives in opened on arrival.
      await expect(
        page
          .getByRole('navigation', { name: app.nav })
          .getByRole('button', { name: app.group, exact: true }),
      ).toHaveAttribute('aria-expanded', 'true');
    });

    test('Escape closes quick navigation and gives focus back', async ({ page }) => {
      await setRail(page, false);
      await page.goto(`${app.base}${app.home}`);
      const trigger = page.getByRole('button', { name: /Find a page/ });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Find a page' });
      await dialog.getByRole('combobox').fill('zzzz-no-such-page');
      await expect(dialog.getByText(/No page matches/)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    test('the collapsed rail works from the keyboard alone', async ({ page }) => {
      await setRail(page, true);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${app.base}${app.home}`);
      const nav = page.getByRole('navigation', { name: app.nav });
      const group = nav.getByRole('button', { name: app.group, exact: true });
      await expect(group).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

      // Reach the group button with Tab, as a keyboard user would.
      await page.getByRole('button', { name: /Find a page/ }).focus();
      for (let i = 0; i < 20; i++) {
        if (await group.evaluate((el) => el === document.activeElement)) break;
        await page.keyboard.press('Tab');
      }
      await expect(group).toBeFocused();
      // A tooltip on FOCUS, not only on hover, with the group's name.
      await expect(page.locator('[data-rail-tooltip]')).toHaveText(app.group);

      // Arrow Right opens the flyout on its first link; arrows walk it; Escape comes back.
      await page.keyboard.press('ArrowRight');
      await expect(group).toHaveAttribute('aria-expanded', 'true');
      const flyout = page.getByRole('group', { name: app.group, exact: true });
      await expect(flyout.getByRole('link').first()).toBeFocused();
      await expect(flyout.getByRole('link', { name: app.groupLink, exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(group).toHaveAttribute('aria-expanded', 'false');
      await expect(group).toBeFocused();

      // Enter opens it too, and a link in it navigates.
      await page.keyboard.press('Enter');
      await flyout.getByRole('link', { name: app.groupLink, exact: true }).click();
      await expect(page).not.toHaveURL(new RegExp(`${app.home}$`));
      await expect(flyout).toBeHidden();
    });

    test('at a 768px-tall window the sidebar adds no second scroll', async ({ page }) => {
      await setRail(page, false);
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.goto(`${app.base}${app.tallest}`);
      const nav = page.getByRole('navigation', { name: app.nav });
      await expect(nav).toBeVisible({ timeout: 30_000 });
      const overflow = await nav.evaluate((el) => el.scrollHeight - el.clientHeight);
      expect(overflow, 'the sidebar list scrolls on its own').toBeLessThanOrEqual(1);
      // And every group heading is on screen, not clipped below the fold.
      const last = nav.getByRole('button').last();
      const box = await last.boundingBox();
      expect(box && box.y + box.height).toBeLessThanOrEqual(768);
    });

    test('collapse and expand on desktop, and the choice holds across navigation', async ({
      page,
    }) => {
      await setRail(page, false);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${app.base}${app.home}`);
      const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
      await expect(collapse).toHaveAttribute('aria-expanded', 'true', { timeout: 30_000 });
      await collapse.click();

      // Collapsed: the toggle says so, keeps focus, and the rail shows named group buttons.
      const expand = page.getByRole('button', { name: 'Expand sidebar' });
      await expect(expand).toHaveAttribute('aria-expanded', 'false');
      await expect(expand).toBeFocused();
      const nav = page.getByRole('navigation', { name: app.nav });
      const group = nav.getByRole('button', { name: app.group, exact: true });
      await expect(group).toBeVisible();

      // Navigate through a flyout; the rail is still a rail on the next page.
      await group.click();
      await page
        .getByRole('group', { name: app.group, exact: true })
        .getByRole('link', { name: app.groupLink, exact: true })
        .click();
      await expect(page).not.toHaveURL(new RegExp(`${app.home}$`));
      await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
      await expect(page.getByRole('group', { name: app.group, exact: true })).toBeHidden();
      // And the current page's group says so in its name.
      await expect(
        nav.getByRole('button', { name: `${app.group}, current section`, exact: true }),
      ).toBeVisible();

      // Expand again: the labels are back and the current page is marked.
      await page.getByRole('button', { name: 'Expand sidebar' }).click();
      await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeFocused();
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(nav.getByRole('button', { name: app.group, exact: true })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });

    test('on a phone the drawer opens, closes and hands focus back', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${app.base}${app.home}`);
      const toggle = page.getByRole('button', { name: 'Toggle navigation' });
      await expect(toggle).toBeVisible({ timeout: 30_000 });
      // No desktop sidebar at this width: the drawer is the only navigation.
      await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeHidden();

      const drawer = page.getByRole('dialog', { name: app.drawer });
      // Escape closes it and focus returns to the menu button.
      await toggle.click();
      await expect(drawer).toBeVisible();
      await expect(drawer.locator('[aria-current="page"]')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(toggle).toBeFocused();

      // The close button does the same.
      await toggle.click();
      await drawer.getByRole('button', { name: 'Close navigation' }).click();
      await expect(drawer).toBeHidden();
      await expect(toggle).toBeFocused();

      // A link in a folded group: open the group, follow the link, the drawer closes itself.
      await toggle.click();
      await drawer.getByRole('button', { name: app.group, exact: true }).click();
      await drawer.getByRole('link', { name: app.groupLink, exact: true }).click();
      await expect(page).not.toHaveURL(new RegExp(`${app.home}$`));
      await expect(drawer).toBeHidden();

      // Reopened on the new page: its group is open and the new page is the current one.
      await toggle.click();
      await expect(drawer.getByRole('button', { name: app.group, exact: true })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(drawer.locator('[aria-current="page"]')).toHaveText(app.groupLink);
      await page.keyboard.press('Escape');
    });
  });
}
