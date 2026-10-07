import { test, expect } from '@playwright/test';
import { ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * The header does not overlap itself on a phone.
 *
 * -- THE DEFECT THIS CLOSES ---------------------------------------------------------------
 * The workspace name was centred with `position: absolute; inset-inline: 0`, which is right
 * on a wide header and impossible on a narrow one: at 390px the centre of the header IS where
 * the theme control is, so the name sat on top of it.
 *
 * It was found and then half-fixed. `pointer-events-none` was added so the control underneath
 * could still be pressed, and the measurements were recorded in the source - 320px covered all
 * three theme buttons, 412px covered two - but the overlap itself was accepted. The control
 * worked and still looked broken, which is the kind of defect that survives every test suite
 * and every screenshot review where nobody is looking at that corner.
 *
 * -- WHY THIS MEASURES GEOMETRY ------------------------------------------------------------
 * A screenshot proves nothing automatically and a DOM assertion ("the name is visible") would
 * have passed throughout the defect. Two boxes overlapping is a fact about rectangles, so it
 * is checked as one: the name's client rect against every interactive control in the header.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

/** The narrow widths a real phone uses, plus the desktop ones that must keep true centring. */
const WIDTHS = [
  { w: 320, h: 720, note: 'the narrowest phone still in use' },
  { w: 390, h: 844 },
  { w: 412, h: 915 },
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
];

test.describe('the organizer header at every width', () => {
  let owner: Awaited<ReturnType<typeof apiLogin>>;

  test.beforeAll(async ({ request }) => {
    // Minted once: the auth throttle counts requests, not logins.
    owner = await apiLogin(request, ORGANIZER_EMAIL);
  });

  for (const { w, h, note } of WIDTHS) {
    test(`${w}px: the workspace name touches no control${note ? ` (${note})` : ''}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport: { width: w, height: h } });
      await seedBrowserAuth(context, owner);
      const page = await context.newPage();

      try {
        await page.goto(`${ORGANIZER}/organizer/venues`);
        await page.waitForLoadState('networkidle').catch(() => undefined);

        const collisions = await page.evaluate(() => {
          const header = document.querySelector('header');
          if (!header) return ['no header rendered'];

          /*
            BOTH copies carry the hook. The element differs by width - a phone gets the one
            that flows in the left cluster, wider screens the absolutely centred one - so
            every visible copy is checked rather than whichever happens to exist.

            An earlier version matched on text and silently picked the "ETicketsGo - Organizer"
            attribution link instead, which nests its own spans and therefore "overlapped"
            itself at every desktop width. A heuristic selector reported a defect that was not
            there; the hook reports the one that is.
          */
          const hits: string[] = [];
          for (const nameEl of header.querySelectorAll('[data-testid="workspace-name"]')) {
            const n = nameEl.getBoundingClientRect();
            if (n.width === 0 || n.height === 0) continue;

            for (const el of header.querySelectorAll('button, a, input, select')) {
              if (el.contains(nameEl) || nameEl.contains(el)) continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              // Two rectangles overlap unless one is entirely past the other on an axis.
              const apart =
                r.right <= n.left || r.left >= n.right || r.bottom <= n.top || r.top >= n.bottom;
              if (!apart) {
                hits.push((el.getAttribute('aria-label') || el.textContent || el.tagName).trim());
              }
            }
          }
          return hits;
        });

        expect(collisions).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test('the header never forces the page to scroll sideways', async ({ browser }) => {
    // The other way a header breaks a phone: it fits visually and pushes the document wider.
    const context = await browser.newContext({ viewport: { width: 320, height: 720 } });
    await seedBrowserAuth(context, owner);
    const page = await context.newPage();
    try {
      await page.goto(`${ORGANIZER}/organizer/venues`);
      await page.waitForLoadState('networkidle').catch(() => undefined);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(2);
    } finally {
      await context.close();
    }
  });
});
