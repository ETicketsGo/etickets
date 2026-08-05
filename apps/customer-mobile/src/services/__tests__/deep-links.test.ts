import { resolveDeepLink, targetToHref } from '../deep-links';

/**
 * Deep links are attacker-reachable: anyone can put one in an email, a QR code, or a
 * web page. These tests are mostly about what the app REFUSES to do.
 */

const HOST = 'qa.eticketsgo.com';

describe('scheme handling', () => {
  it('accepts the custom scheme', () => {
    expect(resolveDeepLink('etickets://event/sunburn-arena-bengaluru')).toMatchObject({
      status: 'ok',
      target: { kind: 'event', slug: 'sunburn-arena-bengaluru' },
    });
  });

  it('accepts an https universal link on our own host', () => {
    expect(resolveDeepLink(`https://${HOST}/event/devconf-india-2026`, HOST)).toMatchObject({
      status: 'ok',
      target: { kind: 'event', slug: 'devconf-india-2026' },
    });
  });

  it.each([
    'javascript:alert(document.cookie)',
    'file:///data/data/com.eticketsgo.customer/databases/tickets.db',
    'intent://scan/#Intent;scheme=zxing;end',
    'content://com.android.providers/1',
    'data:text/html,<script>1</script>',
  ])('rejects %s outright', (url) => {
    const result = resolveDeepLink(url, HOST);
    expect(result.status).toBe('rejected');
  });

  it('rejects a malformed URL rather than guessing', () => {
    expect(resolveDeepLink('not a url', HOST).status).toBe('rejected');
  });
});

describe('host validation for web links', () => {
  it('refuses an https link from a look-alike host', () => {
    // Without this the app would open a real booking screen from a phishing page,
    // lending it the app's credibility.
    const result = resolveDeepLink('https://qa.eticketsgo.com.evil.example/booking/abc12345', HOST);

    expect(result).toMatchObject({ status: 'rejected' });
  });

  it('refuses any https link when no universal-link host is configured', () => {
    // A dev build with no host must not accept web links from everywhere.
    expect(resolveDeepLink('https://anything.example/event/x', null).status).toBe('rejected');
  });

  it('matches the host case-insensitively', () => {
    expect(resolveDeepLink(`https://QA.ETICKETSGO.COM/tickets`, HOST).status).toBe('ok');
  });
});

describe('parameter validation', () => {
  it('rejects a path-traversal attempt in a slug', () => {
    const result = resolveDeepLink('etickets://event/..%2F..%2Fadmin', HOST);
    expect(result.status).toBe('unknown');
  });

  it('rejects a slug carrying a query or scheme', () => {
    expect(resolveDeepLink('etickets://event/evil?x=1#y', HOST)).toMatchObject({
      // "evil" is a legal slug; the query and fragment are simply not part of it.
      status: 'ok',
      target: { kind: 'event', slug: 'evil' },
    });
    expect(resolveDeepLink('etickets://event/https:%2F%2Fevil.example', HOST).status).toBe(
      'unknown',
    );
  });

  it('rejects a booking id that is not identifier-shaped', () => {
    expect(resolveDeepLink('etickets://booking/../../x', HOST).status).toBe('unknown');
    expect(resolveDeepLink('etickets://booking/short', HOST).status).toBe('unknown');
    expect(resolveDeepLink("etickets://booking/abc';DROP TABLE", HOST).status).toBe('unknown');
  });

  it('accepts a real cuid booking id', () => {
    expect(resolveDeepLink('etickets://booking/cmsecjsgv000apk9z1mugtd8x', HOST)).toMatchObject({
      status: 'ok',
      target: { kind: 'booking', bookingId: 'cmsecjsgv000apk9z1mugtd8x' },
      requiresAuth: true,
    });
  });

  it('strips control characters out of a search query', () => {
    const result = resolveDeepLink('etickets://search?q=rock%00%0Aconcert', HOST);

    expect(result).toMatchObject({
      status: 'ok',
      target: { kind: 'search', query: 'rockconcert' },
    });
  });

  it('bounds an absurdly long search query', () => {
    const result = resolveDeepLink(`etickets://search?q=${'a'.repeat(5000)}`, HOST);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.target.kind !== 'search') return;
    expect(result.target.query?.length).toBe(120);
  });

  it('drops an invalid email on an auth link instead of passing it through', () => {
    const result = resolveDeepLink('etickets://login?email=<script>', HOST);

    expect(result).toMatchObject({ status: 'ok', target: { kind: 'login', email: undefined } });
  });

  it('keeps a valid email prefill', () => {
    expect(resolveDeepLink('etickets://register?email=a%40b.com', HOST)).toMatchObject({
      target: { kind: 'register', email: 'a@b.com' },
    });
  });
});

describe('unknown routes', () => {
  it('falls back to home rather than following the URL', () => {
    const result = resolveDeepLink('etickets://admin/settings', HOST);

    expect(result.status).toBe('unknown');
    expect(result.status === 'unknown' && result.target).toEqual({ kind: 'home' });
  });

  it('treats a bare scheme as home', () => {
    expect(resolveDeepLink('etickets://', HOST)).toMatchObject({ target: { kind: 'home' } });
  });
});

describe('authentication requirements', () => {
  it('marks bookings and tickets as needing a session', () => {
    expect(resolveDeepLink('etickets://tickets', HOST)).toMatchObject({ requiresAuth: true });
    expect(resolveDeepLink('etickets://booking/cmsecjsgv000apk9z1mugtd8x', HOST)).toMatchObject({
      requiresAuth: true,
    });
  });

  it('marks browsing routes as public', () => {
    for (const url of [
      'etickets://event/x-y',
      'etickets://movie/a-b',
      'etickets://search?q=jazz',
    ]) {
      expect(resolveDeepLink(url, HOST)).toMatchObject({ requiresAuth: false });
    }
  });

  it('does not treat an id in a link as authorization', () => {
    // The resolution says only "this is a booking route for this id". Whether the
    // holder of the phone may SEE that booking is decided by the API, not here.
    const result = resolveDeepLink('etickets://booking/cmsecjsgv000apk9z1mugtd8x', HOST);
    expect(result.status).toBe('ok');
    expect(Object.keys(result)).not.toContain('authorized');
  });
});

describe('route mapping', () => {
  it('maps every target kind to a real app route', () => {
    expect(targetToHref({ kind: 'event', slug: 's' })).toEqual({
      pathname: '/event/[slug]',
      params: { slug: 's' },
    });
    expect(targetToHref({ kind: 'session-seats', sessionId: 'id1', slug: 's' })).toEqual({
      pathname: '/session/[id]/seats',
      params: { id: 'id1', slug: 's' },
    });
    expect(targetToHref({ kind: 'booking', bookingId: 'b' })).toEqual({
      pathname: '/booking/[id]',
      params: { id: 'b' },
    });
    expect(targetToHref({ kind: 'tickets' })).toEqual({ pathname: '/(tabs)/tickets' });
    expect(targetToHref({ kind: 'home' })).toEqual({ pathname: '/(tabs)' });
  });

  it('omits optional params rather than passing undefined into the router', () => {
    expect(targetToHref({ kind: 'search' })).toEqual({ pathname: '/(tabs)/search' });
    expect(targetToHref({ kind: 'session-seats', sessionId: 'id1' })).toEqual({
      pathname: '/session/[id]/seats',
      params: { id: 'id1' },
    });
  });
});

describe('payment return', () => {
  it('resolves the payment return URL to the booking screen', () => {
    // followPaymentAction hands the browser etickets://booking/<id> as its return URL.
    // The screen it lands on re-reads the booking from the API — the return itself is
    // never treated as proof the payment settled.
    expect(resolveDeepLink('etickets://booking/cmsecjsgv000apk9z1mugtd8x')).toMatchObject({
      status: 'ok',
      target: { kind: 'booking' },
    });
  });
});
