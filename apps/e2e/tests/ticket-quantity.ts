import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The event page's ticket quantity, as a stepper.
 *
 * It was a native `<select>` reading "0" (audit C4: small, a full-screen wheel on a phone, and a
 * zero that read as a price that failed to load). It is now a minus, a count and a plus, 44px
 * each, in a group that keeps the select's accessible name ("Quantity of Lawn"). What a buyer can
 * do is unchanged - choose how many of each ticket - so these helpers only change HOW a test
 * chooses: by pressing the buttons, the way a person does.
 *
 * `data-quantity-stepper` marks the group, `data-quantity` carries the current count, and
 * `data-step="up" | "down"` marks the buttons (components/booking-brand.tsx).
 */
export const QUANTITY_STEPPER = '[data-quantity-stepper]';

/** Every quantity stepper on the page. */
export function quantitySteppers(page: Page): Locator {
  return page.locator(QUANTITY_STEPPER);
}

/** The "one more" button of a stepper: what a test checks to ask "can this ticket be bought?". */
export function moreButton(stepper: Locator): Locator {
  return stepper.locator('[data-step="up"]');
}

/** Press + or - until the stepper shows `count`. Fails if a press does not move the count. */
export async function chooseQuantity(stepper: Locator, count: number): Promise<void> {
  await expect(stepper).toBeVisible({ timeout: 30_000 });
  for (let presses = 0; presses < 60; presses++) {
    const now = Number(await stepper.getAttribute('data-quantity'));
    if (now === count) return;
    const next = now < count ? now + 1 : now - 1;
    await stepper.locator(now < count ? '[data-step="up"]' : '[data-step="down"]').click();
    await expect(stepper).toHaveAttribute('data-quantity', String(next));
  }
  throw new Error(`the quantity stepper did not reach ${count}`);
}
