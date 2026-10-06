import { test, expect, type Locator } from '@playwright/test';
import { ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * The header's centred org name must not swallow presses meant for the controls under it.
 *
 * ── THE DEFECT THIS CLOSES ─────────────────────────────────────────────────────────
 * The masthead is centred with absolute positioning, and its wrapper correctly carries
 * `pointer-events-none` so the invisible full-width band cannot intercept anything. The box
 * INSIDE it then set `pointer-events-auto`, which gave the bug straight back: the name is
 * only as wide as the text, but on a narrow screen the centre of the header is exactly where
 * the appearance control is.
 *
 * Measured on the gate - a screen used on a phone by definition:
 *
 *     320px   the name covered Light, Dark AND Match system
 *     412px   it covered Light and Dark
 *     1440px  no overlap
 *
 * So on a phone the appearance control could not be pressed at all. Nothing caught it: the
 * markup is correct, the buttons are rendered, enabled and focusable, and every assertion of
 * the form "is it visible" passes. Only asking the browser WHICH ELEMENT IS ON TOP finds it.
 *
 * ── WHY IT RUNS AT FOUR WIDTHS ─────────────────────────────────────────────────────
 * The overlap is a function of viewport width and of how long the organisation's name is, so
 * a desktop-only check would have stayed green through the whole defect. 320 is the narrowest
 * phone worth supporting, 390 and 412 are the common ones, and the desktop case is there to
 * prove the fix did not simply stop rendering the control.
 */
const APPEARANCE = ['Light', 'Dark', 'Match system'];

/** What sits on top at this element's centre, or null when the element itself does. */
function coveredBy(control: Locator): Promise<string | null> {
  return control.evaluate((el: Element) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (!top || el.contains(top)) return null;
    return `<${top.tagName.toLowerCase()}> "${(top.textContent || '').trim().slice(0, 30)}"`;
  });
}

for (const width of [320, 390, 412, 1440]) {
  test(`the masthead does not cover the header controls at ${width}px`, async ({
    page,
    context,
    request,
  }) => {
    await page.setViewportSize({ width, height: 820 });
    const tokens = await apiLogin(request, 'owner@eticketsgo.test');
    await seedBrowserAuth(context, tokens);

    await page.goto(`${ORGANIZER}/organizer`);
    // The name has to be on screen, or this test would pass by the masthead being absent.
    const name = page.locator('header span[title]').first();
    await expect(name).toBeVisible({ timeout: 20_000 });

    /*
      Found FIRST, and asserted. The first version of this test skipped a control it could not
      find, so when it found none it passed having checked nothing - and it did exactly that
      against the broken build, which is how the hole was noticed. A test whose assertions can
      all be skipped reports the absence of evidence as evidence.

      `radio`, not `button`: the appearance control is a segmented radiogroup, which is the
      correct markup for three mutually exclusive choices. Asking for the wrong role found
      nothing, and "nothing" was being read as "nothing wrong".
    */
    const present: string[] = [];
    for (const label of APPEARANCE) {
      if ((await page.getByRole('radio', { name: label }).count()) > 0) present.push(label);
    }
    expect(present, 'the appearance control should be in the header').toEqual(APPEARANCE);

    /*
      Not `toBeVisible`, and not a click for the sweep. A covered control is still visible, and
      a click on one either lands somewhere else or times out - a slow, vague failure that
      reads as flake. Asking what sits on top answers the actual question and names the culprit.
    */
    for (const label of APPEARANCE) {
      const control = page.getByRole('radio', { name: label });
      expect(await coveredBy(control), `"${label}" is covered at ${width}px`).toBeNull();
    }

    /*
      The rest of the header too, because a fix that uncovers the appearance switch by
      covering something else is not a fix. Skipped where a control is not rendered at this
      width - that is a layout choice, not a defect - and the appearance group above is
      already asserted to be present, so this loop cannot quietly check nothing.
    */
    for (const label of ['Toggle navigation', 'Sign out']) {
      const control = page.getByRole('button', { name: label });
      if ((await control.count()) === 0) continue;
      expect(await coveredBy(control), `"${label}" is covered at ${width}px`).toBeNull();
    }

    /*
      And one real press, which is the claim that actually matters. `elementFromPoint` says
      nothing is on top; clicking proves the browser agrees and that the control still does its
      job. Dark is used because its effect is observable on the document element: the scheme is
      applied as a `dark` CLASS on <html>, which is what Tailwind's dark variant reads.
    */
    await page.getByRole('radio', { name: 'Dark' }).click({ timeout: 5_000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')), {
        timeout: 5_000,
      })
      .toBe(true);
  });
}
