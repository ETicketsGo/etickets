import { REDACTED, redactSecretSegments, safeRequestPath } from './request-path';

/**
 * The path, as it is safe to write down.
 *
 * Half of these are negative controls. A redactor that removed too much would be "safe" and
 * would also make the logs useless for the debugging they exist for — so the tests that assert
 * an ORDINARY path survives untouched matter as much as the ones that assert a secret does not.
 */

const SECRET = 'k9Vx2pQ7-Rj4LmN8sT1wY6bZ0cH3dF5gA';

describe('a credential in the path is redacted', () => {
  it('redacts the SES webhook secret', () => {
    expect(redactSecretSegments(`/api/notifications/webhooks/ses/${SECRET}`)).toBe(
      `/api/notifications/webhooks/ses/${REDACTED}`,
    );
  });

  it('redacts the MSG91 webhook secret, which has no signature behind it', () => {
    // MSG91 publishes no signature: this path segment is the ONLY authentication it has.
    expect(redactSecretSegments(`/api/notifications/webhooks/msg91/${SECRET}`)).toBe(
      `/api/notifications/webhooks/msg91/${REDACTED}`,
    );
  });

  it('keeps the route itself, so an operator can still tell who called', () => {
    const out = redactSecretSegments(`/api/notifications/webhooks/ses/${SECRET}`);
    expect(out).toContain('notifications/webhooks/ses');
    expect(out).not.toContain(SECRET);
  });

  it('does not depend on the global prefix being /api', () => {
    // API_GLOBAL_PREFIX is configuration. A redaction that hardcoded /api would stop working
    // silently the day somebody changed it.
    expect(redactSecretSegments(`/notifications/webhooks/ses/${SECRET}`)).toBe(
      `/notifications/webhooks/ses/${REDACTED}`,
    );
    expect(redactSecretSegments(`/v2/gateway/notifications/webhooks/ses/${SECRET}`)).toBe(
      `/v2/gateway/notifications/webhooks/ses/${REDACTED}`,
    );
  });

  it('redacts regardless of the secret’s shape', () => {
    for (const value of ['a', 'A'.repeat(200), 'has.dots', 'has-dashes_and_underscores', '%20']) {
      expect(redactSecretSegments(`/api/notifications/webhooks/ses/${value}`)).toBe(
        `/api/notifications/webhooks/ses/${REDACTED}`,
      );
    }
  });

  it('redacts only the credential segment when more path follows', () => {
    expect(redactSecretSegments(`/api/notifications/webhooks/ses/${SECRET}/extra`)).toBe(
      `/api/notifications/webhooks/ses/${REDACTED}/extra`,
    );
  });

  it('leaves the bare route alone when no segment follows', () => {
    // Nothing to redact, and inventing a [REDACTED] here would misreport what was called.
    expect(redactSecretSegments('/api/notifications/webhooks/ses')).toBe(
      '/api/notifications/webhooks/ses',
    );
    expect(redactSecretSegments('/api/notifications/webhooks/ses/')).toBe(
      '/api/notifications/webhooks/ses/',
    );
  });

  it('is case-insensitive about the route', () => {
    expect(redactSecretSegments(`/API/Notifications/Webhooks/SES/${SECRET}`)).not.toContain(SECRET);
  });
});

describe('a link token in the path is redacted', () => {
  /*
    Each of these IS an account or a ticket rather than a webhook secret. A back-office invite
    account holds its grants before it is accepted, so a readable invitation token in a 4xx log
    line is a takeover; a share token opens a guest QR; an attendee-invite token claims a ticket.
  */
  const TOKEN = 'Zk3pL9qR2sT5vW8xY1bC4dF7gH0jK6mN';

  it('redacts the invitation token on both of its routes', () => {
    expect(redactSecretSegments(`/api/public/invitations/${TOKEN}`)).toBe(
      `/api/public/invitations/${REDACTED}`,
    );
    expect(redactSecretSegments(`/api/public/invitations/${TOKEN}/accept`)).toBe(
      `/api/public/invitations/${REDACTED}/accept`,
    );
  });

  it('redacts a share-link token', () => {
    expect(redactSecretSegments(`/api/public/share/${TOKEN}`)).toBe(
      `/api/public/share/${REDACTED}`,
    );
  });

  it('redacts an attendee-invite token on accept and on decline', () => {
    expect(redactSecretSegments(`/api/attendee-invites/${TOKEN}/accept`)).toBe(
      `/api/attendee-invites/${REDACTED}/accept`,
    );
    expect(redactSecretSegments(`/api/attendee-invites/${TOKEN}/decline`)).toBe(
      `/api/attendee-invites/${REDACTED}/decline`,
    );
  });

  it('keeps the invite ID on resend, which is an identifier and not a credential', () => {
    expect(redactSecretSegments('/api/attendee-invites/cmtut10xc000jt06sn5knpcf7/resend')).toBe(
      '/api/attendee-invites/cmtut10xc000jt06sn5knpcf7/resend',
    );
  });

  it('does not mistake a longer action name for accept', () => {
    expect(redactSecretSegments('/api/attendee-invites/abc/acceptance-report')).toBe(
      '/api/attendee-invites/abc/acceptance-report',
    );
  });

  it('drops the query string AND redacts the token', () => {
    expect(safeRequestPath({ originalUrl: `/api/public/share/${TOKEN}?utm_source=mail` })).toBe(
      `/api/public/share/${REDACTED}`,
    );
  });
});

describe('negative controls — ordinary paths are untouched', () => {
  /*
    The failure this guards against is a redactor that quietly mangles the logs. A booking
    reference or an event slug in a path is exactly what somebody greps for when a customer
    calls, and replacing it with [REDACTED] would be a worse outcome than the leak.
  */
  const ORDINARY = [
    '/api/bookings/ETG-IN-2026-000123',
    '/api/public/events/the-grand-budapest-hotel',
    '/api/admin/notifications/cmtut10xc000jt06sn5knpcf7',
    '/api/notifications/webhooks/twilio',
    '/api/notifications/webhooks/whatsapp/cloud',
    '/api/admin/notifications/sns/pending-confirmation/reveal',
    '/api/health',
    '/',
    '',
  ];

  it.each(ORDINARY)('%s is logged verbatim', (path) => {
    expect(redactSecretSegments(path)).toBe(path);
  });

  it('does not touch a path that merely mentions ses somewhere', () => {
    // `ses` appears inside other words and other routes. Only the webhook route is a secret.
    expect(redactSecretSegments('/api/courses/ses-101/lessons/4')).toBe(
      '/api/courses/ses-101/lessons/4',
    );
    expect(redactSecretSegments('/api/venues/ses/seats/A12')).toBe('/api/venues/ses/seats/A12');
  });
});

describe('safeRequestPath', () => {
  it('drops the query string entirely', () => {
    // Not part of any route this platform defines, and where a third party's tokens and email
    // addresses turn up when they build a link.
    expect(safeRequestPath({ originalUrl: '/api/events?token=abc123&email=a@b.test' })).toBe(
      '/api/events',
    );
  });

  it('drops the query string AND redacts the credential', () => {
    expect(
      safeRequestPath({ originalUrl: `/api/notifications/webhooks/ses/${SECRET}?replay=1` }),
    ).toBe(`/api/notifications/webhooks/ses/${REDACTED}`);
  });

  it('falls back to url when originalUrl is absent, and to empty when both are', () => {
    expect(safeRequestPath({ url: '/api/events' })).toBe('/api/events');
    expect(safeRequestPath({})).toBe('');
  });
});
