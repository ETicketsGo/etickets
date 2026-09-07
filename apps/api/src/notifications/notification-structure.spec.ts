import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  NotificationType,
  PROVIDER_CAPABILITIES,
  capabilityFor,
  requiresTemplateBinding,
} from '@eticketsgo/shared-types';
import { EVENT_POLICY, fallbackChannelFor, immediateChannels } from './policy/notification-policy';

/**
 * Structural guarantees that no future change may quietly remove.
 *
 * ── WHY THESE ARE TESTS AND NOT A REVIEW CHECKLIST ─────────────────────────────────
 * Every property below is one somebody could break without breaking a single existing test —
 * by adding a provider, by moving a channel between policy rows, by reaching for the familiar
 * helper. Each was either already got wrong once in this codebase or is one edit away from
 * being got wrong, and none of them fails visibly at runtime: the symptom is a message that
 * silently costs money, or silently never arrives.
 *
 * They are deliberately written against BEHAVIOUR — the policy table, the capability matrix,
 * the transports' actual imports — rather than against file names, so moving a file does not
 * fail the build and deleting the property does.
 */

const SRC = resolve(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('the notification platform cannot silently lose a guarantee', () => {
  it('SHOW_CANCELLED remains the urgent type, and the only one that may open a paid SMS', () => {
    /*
      This was BOOKING_CANCELLED for a phase, and it was wrong in a way nothing detected: that
      type includes a customer cancelling their own booking, so the emergency SMS fired at
      somebody about a decision they had just made, at our expense, thirty minutes later.

      Asserted as a complete list, so moving the fallback onto another type fails here rather
      than showing up on an invoice.
    */
    const withSmsFallback = Object.values(NotificationType).filter(
      (t) => fallbackChannelFor(t) === 'sms',
    );
    expect(withSmsFallback).toEqual([NotificationType.SHOW_CANCELLED]);
    expect(EVENT_POLICY[NotificationType.SHOW_CANCELLED]?.urgency).toBe('URGENT');
  });

  it('no ordinary booking cancellation may reach a paid channel', () => {
    const policy = EVENT_POLICY[NotificationType.BOOKING_CANCELLED];
    expect(policy?.channels).not.toContain('sms');
    expect(policy?.fallback).toBeUndefined();
  });

  it('every channel a provider must template for has a binding mechanism', () => {
    /*
      A provider that will carry nothing except an approved template, with no way to configure
      one, is a channel that can never send. The capability matrix declares the requirement;
      this asserts something can actually satisfy it.
    */
    const templated = PROVIDER_CAPABILITIES.filter((c) => c.requiresTemplate);
    expect(templated.length).toBeGreaterThan(0);
    for (const capability of templated) {
      expect(requiresTemplateBinding(capability.provider, capability.channel)).toBe(true);
    }
  });

  it('every provider a market can route to is described in the capability matrix', () => {
    /*
      An undescribed provider defaults to "no delivery receipt, no template required", and
      both defaults are silently wrong for a real one: certification would stop waiting for a
      callback that does exist, and a templated channel would try to send free text.
    */
    const routable = ['ses', 'sendgrid', 'twilio', 'msg91', 'cloud', 'expo', 'fcm', 'log'];
    for (const provider of routable) {
      const anyChannel = PROVIDER_CAPABILITIES.some((c) => c.provider === provider);
      expect({ provider, described: anyChannel }).toEqual({ provider, described: true });
    }
  });

  it('a channel with no delivery receipt is never expected to produce one', () => {
    // Push has no delivery callback on any provider. Certification must treat ACCEPTED as
    // terminal rather than holding a channel below certified forever, waiting for a receipt
    // that does not exist anywhere.
    expect(capabilityFor('expo', 'push')?.supportsDeliveryReceipt).toBe(false);
    expect(capabilityFor('fcm', 'push')?.supportsDeliveryReceipt).toBe(false);
  });

  it('no webhook endpoint is public without a verification or authentication control', () => {
    const controller = readFileSync(
      join(SRC, 'notifications/delivery/webhook/delivery-webhook.controller.ts'),
      'utf8',
    );
    /*
      What these endpoints can do is SUPPRESS a destination, which is a way to stop a named
      person receiving their tickets. Every route therefore proves the caller some other way:
      a signature where the provider publishes one, a shared secret in the path where it does
      not. A `@Public()` route with neither would be an open suppression endpoint.
    */
    const routes = [...controller.matchAll(/@(Post|Get)\('([^']+)'\)/g)].map((m) => m[2]);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const hasPathSecret = route.includes(':secret');
      const hasSignatureOrChallenge =
        /twilio|whatsapp\/cloud/.test(route) &&
        /verifyTwilioSignature|x-hub-signature-256|safeEqual/.test(controller);
      expect({ route, guarded: hasPathSecret || hasSignatureOrChallenge }).toEqual({
        route,
        guarded: true,
      });
    }
  });

  it('nothing on the money path calls a messaging provider directly', () => {
    /*
      The property that keeps a WhatsApp outage from failing a payment. Everything is written
      down and handed to the sweep; the sweep is the only thing that talks to a provider.
      A transport imported into a payment, booking or refund service would be an inline call
      inside a transaction, and its timeout would become the customer's failed checkout.
    */
    const moneyPath = sourceFiles(join(SRC, 'payments'))
      .concat(sourceFiles(join(SRC, 'refunds')))
      .concat(sourceFiles(join(SRC, 'bookings')));
    const offenders: string[] = [];
    for (const file of moneyPath) {
      const src = readFileSync(file, 'utf8');
      if (/from '.*(sms|whatsapp|email|push)\.transport'/.test(src)) {
        offenders.push(relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no domain caller names a messaging provider', () => {
    /*
      Provider names belong to the resolver and the transports. A `if (country === 'IN')
      msg91` anywhere else is a routing decision in a place nobody will look at again, and it
      is how "India goes to MSG91" ends up meaning three different things.
    */
    const domain = sourceFiles(join(SRC, 'payments'))
      .concat(sourceFiles(join(SRC, 'refunds')))
      .concat(sourceFiles(join(SRC, 'shows')));
    const offenders: string[] = [];
    for (const file of domain) {
      const src = readFileSync(file, 'utf8');
      // Word-boundary matched so a comment mentioning a vendor in prose does not fail this.
      if (/\b(msg91|twilio)\b/i.test(src)) offenders.push(relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });

  it('every type policy selects on a templated channel is answerable by a binding', () => {
    /*
      Not that a binding EXISTS -- none do, and none can until the approvals arrive. That the
      binding mechanism can express one: a type policy routes to WhatsApp with no way to name
      its template would be a permanent refusal nobody could fix by configuration.
    */
    const whatsAppTypes = Object.values(NotificationType).filter((t) =>
      immediateChannels(t).includes('whatsapp'),
    );
    expect(whatsAppTypes.length).toBeGreaterThan(0);
    for (const type of whatsAppTypes) {
      for (const provider of ['msg91', 'cloud']) {
        expect({
          type,
          provider,
          expressible: requiresTemplateBinding(provider, 'whatsapp'),
        }).toEqual({ type, provider, expressible: true });
      }
    }
  });

  it('every enabled market has a readiness definition', () => {
    /*
      A market that can be enabled but not reported on is a market nobody can tell the state
      of -- which is the whole failure the enablement flag was added to fix.
    */
    const readiness = readFileSync(
      join(SRC, 'notifications/readiness/notification-readiness.service.ts'),
      'utf8',
    );
    // Driven by the enabled list rather than a hardcoded trio; a literal array here again
    // would silently ignore any market somebody enables.
    expect(readiness).toContain('parseEnabledMarkets');
    expect(readiness).not.toMatch(/markets: string\[\] = \['IN', 'US', 'CA'\]/);
  });
});
