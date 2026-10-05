import { test, expect } from '@playwright/test';
import { ORGANIZER, API, apiLogin, seedBrowserAuth } from './helpers';

/**
 * The header's centred org name must not swallow presses meant for the controls under it.
 *
 * ── THE DEFECT THIS CLOSES ─────────────────────────────────────────────────────────
 * The masthead is centred with absolute positioning, and its wrapper correctly carries
 * `pointer-events-none` so the invisible full-width band cannot intercept anything. The box
 * INSIDE it then set `pointer-events-auto`, which gave the bug straight back: the name is
 * only as wide as the text, but on a narrow screen the centre of the header is exactly where
 * the theme controls are.
 *
 * Measured on the gate - a screen used on a phone by definition:
 *
 *     320px   the name covered Light, Dark AND Match system
 *     412px   it covered Light and Dark
 *     1440px  no overlap
 *
 * So on a phone the theme control could not be pressed at all. Nothing caught it: the markup
 * is correct, the buttons are rendered, enabled and focusable, and every assertion of the form
 * "is it visible" passes. Only asking the browser WHICH ELEMENT IS ON TOP finds it, which is
 * why this test does that rather than clicking and hoping.
 *
 * ── WHY IT RUNS AT TWO WIDTHS ──────────────────────────────────────────────────────
 * The overlap is a function of viewport width and the length of the organisation's name, so a
 * desktop-only check would have stayed green through the whole defect.
 */
const CONTROLS = ['Light', 'Dark', 'Match system'];

for (const width of [320, 412]) {
  test(`the masthead does not cover the header controls at ${width}px`, async ({
    page,
    context,
    request,
  }) => {
    await page.setViewportSize({ width, height: 780 });
    const tokens = await apiLogin(request, 'owner@eticketsgo.test');
    await seedBrowserAuth(context, tokens);

    await page.goto(`${ORGANIZER}/organizer`);
    // The name has to be on screen, or this test would pass by the masthead being absent.
    const name = page.locator('header span[title]').first();
    await expect(name).toBeVisible({ timeout: 20_000 });

    /*
      Found FIRST, and asserted. The first version of this test skipped a control it could not
      find, so when it could not find any of them it passed having checked nothing - and it
      did exactly that against the broken build, which is how the hole was noticed. A test
      whose assertions can all be skipped reports the absence of evidence as evidence.
    */
    const found: string[] = [];
    for (const label of CONTROLS) {
      if ((await page.getByRole('radio', { name: label }).count()) > 0) found.push(label);
    }
    expect(found, 'the header theme controls should be on this page').toEqual(CONTROLS);

    for (const label of CONTROLS) {
      // `radio`, not `button`: the appearance control is a segmented radiogroup, which is the
      // right markup for it. Asking for the wrong role found nothing and skipped everything.
      const button = page.getByRole('radio', { name: label });

      /*
        Not `toBeVisible` and not a click. A covered button is still visible, and a click
        either lands somewhere else or times out after thirty seconds - a slow, vague failure
        that reads as flake. Asking the browser what sits at the button's centre answers the
        actual question and names the culprit when it fails.
      */
      const blockedBy = await button.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        if (!top || el.contains(top)) return null;
        return `<${top.tagName.toLowerCase()}> "${(top.textContent || '').trim().slice(0, 30)}"`;
      });
      expect(blockedBy, `"${label}" is covered at ${width}px by ${blockedBy}`).toBeNull();
    }
  });
}
