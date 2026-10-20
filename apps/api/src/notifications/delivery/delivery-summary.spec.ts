import { summariseDelivery } from './delivery-summary';

/**
 * What the admin view says happened, from every fact on the row.
 *
 * The first two cases are the rows QA and production actually hold: written SENT by the old
 * sweep about messages that went nowhere. They are never rewritten, so this mapping is the
 * only thing standing between them and an operator reading "sent" as "delivered".
 */
describe('summariseDelivery', () => {
  it('reads an old WhatsApp skip (SENT, provider none, no_destination) as not sent', () => {
    expect(
      summariseDelivery({
        channel: 'whatsapp',
        status: 'SENT',
        provider: 'none',
        lastError: 'no_destination',
        latest: { status: 'REJECTED', provider: 'none', outcomeClass: 'NO_DESTINATION' },
      }),
    ).toEqual({
      verdict: 'NOT_SENT',
      delivered: false,
      label: 'Not sent, because there is no phone number on the account.',
    });
  });

  it('reads an old log-mode email (SENT, provider log, ACCEPTED) as not delivered', () => {
    const s = summariseDelivery({
      channel: 'email',
      status: 'SENT',
      provider: 'log',
      latest: { status: 'ACCEPTED', provider: 'log', outcomeClass: 'PROVIDER_ACCEPTED' },
    });
    expect(s.verdict).toBe('LOG_ONLY');
    expect(s.delivered).toBe(false);
    expect(s.label).toBe(
      'Not delivered. No email provider is set up here, so it was only written to the server log.',
    );
  });

  it('reads the new statuses the same way', () => {
    expect(
      summariseDelivery({ channel: 'push', status: 'LOGGED', latest: { status: 'LOGGED' } })
        .verdict,
    ).toBe('LOG_ONLY');
    expect(
      summariseDelivery({
        channel: 'email',
        status: 'SKIPPED',
        lastError: 'destination_suppressed',
        latest: { status: 'SKIPPED', provider: 'none', outcomeClass: 'POLICY_SUPPRESSED' },
      }),
    ).toMatchObject({ verdict: 'NOT_SENT', delivered: false });
  });

  it('reads an old suppression (FAILED, destination_suppressed, no attempt) as not sent', () => {
    expect(
      summariseDelivery({ channel: 'email', status: 'FAILED', lastError: 'destination_suppressed' })
        .verdict,
    ).toBe('NOT_SENT');
  });

  it('says delivered only when the provider said so', () => {
    expect(
      summariseDelivery({
        channel: 'email',
        status: 'SENT',
        provider: 'ses',
        latest: { status: 'DELIVERED', provider: 'ses' },
      }),
    ).toEqual({ verdict: 'DELIVERED', delivered: true, label: 'Delivered by ses.' });
  });

  it('does not guess when the provider has not reported', () => {
    expect(
      summariseDelivery({
        channel: 'email',
        status: 'SENT',
        provider: 'ses',
        latest: { status: 'ACCEPTED', provider: 'ses' },
      }),
    ).toMatchObject({ verdict: 'ACCEPTED', delivered: null });
    expect(
      summariseDelivery({ channel: 'email', status: 'SENT', provider: null, latest: null }),
    ).toMatchObject({ verdict: 'ACCEPTED', delivered: null });
  });

  it('says an accepted-then-undelivered email was not delivered, though the row says SENT', () => {
    // 393 rows like this on QA: SES accepted them and reported a soft bounce.
    expect(
      summariseDelivery({
        channel: 'email',
        status: 'SENT',
        provider: 'ses',
        latest: { status: 'UNDELIVERED', provider: 'ses' },
      }),
    ).toEqual({
      verdict: 'NOT_DELIVERED',
      delivered: false,
      label: 'Not delivered. It was accepted by ses but could not be delivered.',
    });
  });

  it('treats an in-app row as in the inbox, and a pending one as not sent yet', () => {
    expect(summariseDelivery({ channel: 'in_app', status: 'SENT' }).verdict).toBe('IN_APP');
    expect(summariseDelivery({ channel: 'email', status: 'PENDING' })).toMatchObject({
      verdict: 'IN_PROGRESS',
      delivered: null,
    });
  });

  it('writes plain ASCII', () => {
    const labels = [
      summariseDelivery({ channel: 'sms', status: 'LOGGED' }).label,
      summariseDelivery({ channel: 'push', status: 'SKIPPED', lastError: 'no_device' }).label,
      summariseDelivery({ channel: 'email', status: 'FAILED' }).label,
    ];
    for (const l of labels) expect(l).toMatch(/^[\x20-\x7E]+$/);
  });
});
