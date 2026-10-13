import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every button that holds only an icon on the payment configuration page has a name.
 *
 * The walkthrough's axe run found one with none (button-name, critical): the route's delete
 * button was a bare bin icon, so a screen reader announced "button". Read from the source, since
 * the page needs a signed-in admin to render.
 */
describe('payment configuration icon buttons', () => {
  const src = readFileSync(resolve(__dirname, '../app/admin/payment-config/page.tsx'), 'utf8');

  it('names the delete-route button', () => {
    const button =
      /<Button[^>]*?>\s*<Trash2/s.exec(src) ?? /<Button(?:(?!<\/Button>).)*<Trash2/s.exec(src);
    expect(button, 'the delete button is no longer found').not.toBeNull();
    expect(button![0]).toMatch(/aria-label=/);
  });
});
