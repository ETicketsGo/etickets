import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What an organizer may be told about our payment providers, and what they may not.
 *
 * ── WHY THE OLD PROBE WAS WRONG ────────────────────────────────────────────────────
 * The #169 check asserted the word "Route" was absent from the payouts page. That is not the
 * rule. "Payouts are settled via Razorpay Route - Razorpay holds the bank details you give them"
 * is copy an organizer NEEDS: it tells them which company has their account number, which is a
 * real question with a real answer. Asserting raw absence of a word forbids the useful sentence
 * and the harmful one together, so it would eventually be deleted or weakened by somebody adding
 * a legitimate disclosure - and a check that has to be weakened to ship normal work is not a
 * check.
 *
 * The actual boundary is about WHO the sentence is about:
 *
 *   ALLOWED      naming a provider to explain where the organizer's bank details live, or what
 *                the organizer still has to do.
 *   PROHIBITED   exposing OUR configuration - which provider capability this platform has or has
 *                not switched on - or a raw status enum. That is our implementation, the
 *                organizer can do nothing about it, and "contact support to enable Route" sends
 *                somebody to ask about a feature flag.
 *
 * ── WHY THIS READS SOURCE RATHER THAN A RENDERED PAGE ──────────────────────────────
 * The copy it guards only appears when a provider is configured for an organization, so a
 * rendered assertion needs a QA org with Stripe or Razorpay onboarding in a particular state.
 * That is exactly the fixture that rots, and it is not available at all for Razorpay, where
 * Route is not enabled on the test account. A source check runs on every commit and cannot be
 * silently skipped. It does NOT prove what a browser shows, which is why
 * `qa-payout-disclosure.spec.ts` exists as well - they catch different things and neither
 * replaces the other.
 */

const PAGE = resolve(__dirname, 'page.tsx');

/**
 * The file's code, with comments removed.
 *
 * Necessary rather than tidy: the page DOCUMENTS the copy #169 deleted, quoting it inside a
 * comment so the next person knows what was wrong with it. A naive scan flags that comment and
 * reports a regression in the very note explaining the fix.
 */
function code(): string {
  const raw = readFileSync(PAGE, 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

describe('what the payouts page tells an organizer about our providers', () => {
  describe('prohibited: our own configuration', () => {
    it('never says a provider capability is not enabled for this platform', () => {
      /*
        The #169 regression. It read: "Razorpay Route is not yet enabled for this platform -
        payouts are held". True, and none of the organizer's business: they cannot act on it, and
        it reads as the product being broken.
      */
      expect(code()).not.toMatch(/not (yet )?enabled for this platform/i);
      expect(code()).not.toMatch(
        /not (yet )?(been )?(enabled|configured) (on|for) (our|the) (platform|account)/i,
      );
    });

    it('never sends an organizer to support to have a provider feature switched on', () => {
      expect(code()).not.toMatch(/contact support to (enable|switch on|turn on)/i);
      expect(code()).not.toMatch(/ask (support|us) to enable/i);
    });

    it('never renders a raw provider or onboarding status enum', () => {
      /*
        A screaming-snake-case token on screen is always our vocabulary leaking. It is also how
        an organizer ends up reading "RESTRICTED" about themselves with no idea what to do.
      */
      const enums = [
        'NOT_STARTED',
        'PENDING_VERIFICATION',
        'RESTRICTED',
        'REJECTED',
        'NEEDS_CLARIFICATION',
        'CHARGES_DISABLED',
        'TRANSFER_PROCESSING',
      ];
      const found = enums.filter(
        (token) => code().includes(`"${token}"`) || code().includes(`'${token}'`),
      );
      // Listed, so a failure names the token rather than only failing.
      expect(found).toEqual([]);
    });

    it('never labels a capability badge with a provider product name', () => {
      /*
        The other half of #169: an `EnabledBadge label="Route"`. A badge saying Route is on or off
        describes OUR integration. Badges that describe what the ORGANIZER can do - Charges,
        Payouts, Details submitted - are fine and deliberately still here.
      */
      const labels = [...code().matchAll(/label=\{?["']([^"']+)["']/g)].map((m) => m[1]);
      expect(labels.length).toBeGreaterThan(0);

      const productNames = /^(route|connect|express|custom|standard)$/i;
      expect(labels.filter((label) => productNames.test(label.trim()))).toEqual([]);
    });
  });

  describe('allowed, and required: where the money and the bank details go', () => {
    it('tells an Indian organizer that Razorpay holds their bank details', () => {
      // The sentence the old probe would have banned. It answers a real question.
      expect(code()).toMatch(/Razorpay holds the bank details/i);
    });

    it('tells an organizer elsewhere that Stripe holds their bank details', () => {
      // The Stripe equivalent, so the rule is proven symmetric rather than asserted to be.
      expect(code()).toMatch(/Stripe holds the bank details/i);
    });

    it('names the provider that settles each market, which is not a leak', () => {
      /*
        "Payouts are settled via Razorpay Route" and "Payouts are handled by Stripe" both name a
        provider, and both are allowed: the organizer is choosing where their money arrives.
      */
      expect(code()).toMatch(/Razorpay Route/);
      expect(code()).toMatch(/Stripe/);
    });
  });

  describe('the check itself', () => {
    it('ignores the comment that quotes the deleted copy', () => {
      /*
        Guarding the guard. The page quotes the #169 sentence in a comment on purpose; if comment
        stripping ever breaks, this test suite starts failing on its own documentation and
        somebody deletes the documentation to make it pass.
      */
      const raw = readFileSync(PAGE, 'utf8');
      expect(raw).toMatch(/not yet enabled for this platform/i);
      expect(code()).not.toMatch(/not yet enabled for this platform/i);
    });
  });
});
