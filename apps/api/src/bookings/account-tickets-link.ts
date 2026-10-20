import type { ConfigService } from '@nestjs/config';
import { redirectUrl } from '../common/console-urls';

/**
 * Where an account holder's tickets live on the customer site: the booking's tickets page.
 *
 * ── WHY AN ACCOUNT BOOKING'S EMAIL CARRIES A LINK AT ALL ───────────────────────────
 * The confirmation used to carry a link for a guest only, on the reasoning that an account
 * holder "signs in instead". That left the one email that says "your tickets are ready" with no
 * way to the tickets: the buyer had a reference and had to find the right page themselves.
 *
 * This link is NOT a credential, which is the difference from the guest link. It names a page,
 * and the page asks the visitor to sign in (and sends them back here afterwards) before it shows
 * anything. Forwarding it gives nobody the tickets, so it can go in the email of somebody who
 * already has a password without weakening what they have.
 *
 * Built through `redirectUrl` for the reason every customer link is: derived from
 * CUSTOMER_WEB_URL, and refusing to invent localhost outside local development. No locale
 * prefix: the site's middleware chooses the language from the reader's stored choice.
 */
export function accountTicketsLink(config: ConfigService, bookingId: string): string {
  return redirectUrl(config, {
    site: 'customer',
    path: `/account/bookings/${encodeURIComponent(bookingId)}/tickets`,
    purpose: 'account tickets',
  });
}
