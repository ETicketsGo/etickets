import { describe, it, expect } from 'vitest';
import type { PayoutAccountState } from '@eticketsgo/web-kit';
import { payoutStatusView, PAYOUT_JOURNEY } from './payout-status-view';

/**
 * These test PRESENTATION, not derivation. What a combination of provider facts MEANS is settled
 * on the server and proved there; what is checked here is that each state the server can return
 * reaches an organizer intact - above all that no button is offered when nobody is waiting on
 * them, and that selling and payouts never get merged into one verdict.
 */
const state = (
  over: Partial<PayoutAccountState> & { code: PayoutAccountState['code'] },
): PayoutAccountState => ({
  organizationId: 'org1',
  basis: 'BANK',
  salesAffected: false,
  payouts: 'AVAILABLE',
  organizerActionRequired: false,
  explanation: 'Something the server said.',
  action: null,
  outstandingRequirements: 0,
  ...over,
});

const ALL_CODES: PayoutAccountState['code'][] = [
  'NO_ACCOUNT',
  'DETAILS_REQUIRED',
  'UNDER_REVIEW',
  'ACTION_REQUIRED',
  'RESTRICTED',
  'VERIFIED',
  'PAYOUTS_ENABLED',
];

describe('payoutStatusView', () => {
  it('renders every state the server can return', () => {
    // A new server state must fail here rather than quietly falling back to a default heading.
    for (const code of ALL_CODES) {
      const view = payoutStatusView(state({ code }));
      expect(view.heading).toBeTruthy();
      expect(view.heading).not.toBe(code);
      expect(view.tone).toBeTruthy();
    }
  });

  it('passes the server’s sentence through untouched', () => {
    const view = payoutStatusView(
      state({
        code: 'UNDER_REVIEW',
        explanation: 'We have your bank details and are checking them.',
      }),
    );
    expect(view.explanation).toBe('We have your bank details and are checking them.');
  });

  it('offers no call to action while under review', () => {
    /*
      THE rule. Verification is ETicketsGo's job, so nobody is waiting on the organizer and there
      is no honest control to press.
    */
    const view = payoutStatusView(
      state({ code: 'UNDER_REVIEW', payouts: 'PENDING', organizerActionRequired: false }),
    );
    expect(view.cta).toBeNull();
    expect(view.noActionNotice).toBe('No action is required from you right now.');
  });

  it('offers the server’s real destination when action is genuinely required', () => {
    const view = payoutStatusView(
      state({
        code: 'ACTION_REQUIRED',
        payouts: 'PENDING',
        organizerActionRequired: true,
        action: {
          kind: 'CONTINUE_PROVIDER_ONBOARDING',
          label: 'Finish your payout details',
          href: '/organizer/payouts',
        },
      }),
    );
    expect(view.cta).toEqual({ label: 'Finish your payout details', href: '/organizer/payouts' });
    expect(view.noActionNotice).toBeNull();
  });

  it('gives NO_ACCOUNT a genuine setup path', () => {
    const view = payoutStatusView(
      state({
        code: 'NO_ACCOUNT',
        payouts: 'PENDING',
        organizerActionRequired: true,
        action: {
          kind: 'ADD_BANK_ACCOUNT',
          label: 'Add your bank account',
          href: '/organizer/payouts',
        },
      }),
    );
    expect(view.cta?.href).toBe('/organizer/payouts');
  });

  it('never shows a call to action and a no-action notice together', () => {
    // One or the other, for every state. Both at once is the contradiction this page removes.
    for (const code of ALL_CODES) {
      for (const required of [true, false]) {
        const view = payoutStatusView(
          state({
            code,
            organizerActionRequired: required,
            action: required
              ? { kind: 'CONTACT_SUPPORT', label: 'Contact ETicketsGo', href: '/organizer/help' }
              : null,
          }),
        );
        expect(Boolean(view.cta) && Boolean(view.noActionNotice)).toBe(false);
        expect(Boolean(view.cta) || Boolean(view.noActionNotice)).toBe(true);
      }
    }
  });

  it('does not say payouts are enabled merely because the account is verified', () => {
    /*
      VERIFIED means a person checked the bank account. Whether money can actually leave is a
      separate fact, and the two states must read differently.
    */
    const verified = payoutStatusView(state({ code: 'VERIFIED' }));
    const enabled = payoutStatusView(state({ code: 'PAYOUTS_ENABLED' }));
    expect(verified.heading).not.toBe(enabled.heading);
    expect(verified.heading.toLowerCase()).not.toContain('payouts are active');
  });

  it('says plainly when payouts are working', () => {
    const view = payoutStatusView(state({ code: 'PAYOUTS_ENABLED', payouts: 'AVAILABLE' }));
    expect(view.payoutWord).toBe('Available');
    expect(view.heading).toBe('Payouts are active');
  });

  it('keeps selling and payouts independent in both directions', () => {
    const sellingStopped = payoutStatusView(
      state({ code: 'RESTRICTED', salesAffected: true, payouts: 'AVAILABLE' }),
    );
    expect(sellingStopped.salesWord).toBe('Not available');
    expect(sellingStopped.payoutWord).toBe('Available');

    const payoutsWaiting = payoutStatusView(
      state({ code: 'UNDER_REVIEW', salesAffected: false, payouts: 'PENDING' }),
    );
    expect(payoutsWaiting.salesWord).toBe('Available');
    expect(payoutsWaiting.payoutWord).toBe('Not ready yet');
  });

  it('never implies a missing bank account stops selling', () => {
    // The server says sales are unaffected; the page must not add a consequence of its own.
    const view = payoutStatusView(
      state({ code: 'NO_ACCOUNT', salesAffected: false, payouts: 'PENDING' }),
    );
    expect(view.salesWord).toBe('Available');
  });

  it('distinguishes payouts not ready from payouts unavailable', () => {
    /*
      The three words the three-value contract exists for. A VERIFIED account is being got ready,
      which is not the same as a RESTRICTED one where nothing is in flight at all.
    */
    expect(payoutStatusView(state({ code: 'UNDER_REVIEW', payouts: 'PENDING' })).payoutWord).toBe(
      'Not ready yet',
    );
    expect(payoutStatusView(state({ code: 'RESTRICTED', payouts: 'UNAVAILABLE' })).payoutWord).toBe(
      'Not available',
    );
    expect(
      payoutStatusView(state({ code: 'PAYOUTS_ENABLED', payouts: 'AVAILABLE' })).payoutWord,
    ).toBe('Available');
  });

  it('never says a VERIFIED account can receive payouts', () => {
    // The whole point of the corrected contract, asserted at the surface an organizer reads.
    const view = payoutStatusView(state({ code: 'VERIFIED', payouts: 'PENDING' }));
    expect(view.payoutWord).toBe('Not ready yet');
    expect(view.payoutWord).not.toBe('Available');
  });

  it('interrupts the journey rather than pretending an interruption is progress', () => {
    expect(payoutStatusView(state({ code: 'ACTION_REQUIRED' })).journeyStep).toBeNull();
    expect(payoutStatusView(state({ code: 'RESTRICTED' })).journeyStep).toBeNull();
  });

  it('places the ordinary states along the journey in order', () => {
    expect(payoutStatusView(state({ code: 'NO_ACCOUNT' })).journeyStep).toBe(0);
    expect(payoutStatusView(state({ code: 'UNDER_REVIEW' })).journeyStep).toBe(1);
    expect(payoutStatusView(state({ code: 'VERIFIED' })).journeyStep).toBe(2);
    expect(payoutStatusView(state({ code: 'PAYOUTS_ENABLED' })).journeyStep).toBe(3);
    expect(PAYOUT_JOURNEY).toHaveLength(4);
  });

  it('shows nothing the provider wrote', () => {
    /*
      The server already strips provider text, but the page must not reintroduce it by rendering
      a field it was handed. Only `explanation` reaches the organizer.
    */
    const view = payoutStatusView(
      state({
        code: 'RESTRICTED',
        salesAffected: true,
        payouts: 'PENDING',
        organizerActionRequired: true,
        explanation: 'Your payout account has been stopped by the payment provider.',
        action: { kind: 'CONTACT_SUPPORT', label: 'Contact ETicketsGo', href: '/organizer/help' },
        outstandingRequirements: 0,
      }),
    );
    const rendered = JSON.stringify(view);
    expect(rendered).not.toContain('requirements');
    expect(rendered).not.toContain('disabled');
    expect(view.cta?.label).toBe('Contact ETicketsGo');
  });
});
