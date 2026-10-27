import {
  buildUnsubscribeLinks,
  signUnsubscribeToken,
  unsubscribeKey,
  verifyUnsubscribeToken,
  type UnsubscribeClaims,
} from './unsubscribe-token';
import { listUnsubscribeHeaders } from '../notifications/channels/transports/email.transport';

const cfg = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as never;
const BASE = { JWT_ACCESS_SECRET: 'a-long-enough-secret-for-tests-only-0001' };
const KEY = unsubscribeKey(cfg(BASE));

const organizer: UnsubscribeClaims = {
  userId: 'u_1',
  email: 'Asha@Example.test',
  scope: 'organizer',
  organizationId: 'org_a',
  purpose: 'ALL',
};

function edit(token: string, change: (wire: Record<string, unknown>) => void): string {
  const [body, sig] = token.split('.');
  const wire = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  change(wire);
  return `${Buffer.from(JSON.stringify(wire)).toString('base64url')}.${sig}`;
}

describe('unsubscribe tokens', () => {
  it('round-trips, with the address lower-cased', () => {
    const claims = verifyUnsubscribeToken(signUnsubscribeToken(organizer, KEY), KEY);
    expect(claims).toEqual({ ...organizer, email: 'asha@example.test' });
  });

  it('refuses a token whose organizer, person or scope was edited', () => {
    const token = signUnsubscribeToken(organizer, KEY);
    expect(
      verifyUnsubscribeToken(
        edit(token, (w) => (w.o = 'org_b')),
        KEY,
      ),
    ).toBeNull();
    expect(
      verifyUnsubscribeToken(
        edit(token, (w) => (w.e = 'other@example.test')),
        KEY,
      ),
    ).toBeNull();
    expect(
      verifyUnsubscribeToken(
        edit(token, (w) => (w.s = 'g')),
        KEY,
      ),
    ).toBeNull();
  });

  it('refuses a token signed with another key', () => {
    const other = unsubscribeKey(
      cfg({ UNSUBSCRIBE_SIGNING_SECRET: 'another-secret-entirely-000' }),
    );
    expect(verifyUnsubscribeToken(signUnsubscribeToken(organizer, other), KEY)).toBeNull();
  });

  it('refuses garbage without throwing', () => {
    for (const bad of ['', 'abc', 'a.b.c', '.', `${'x'.repeat(3000)}.y`, 'eyJ2IjoxfQ.AAAA']) {
      expect(verifyUnsubscribeToken(bad, KEY)).toBeNull();
    }
  });

  it('will not sign claims that make no sense', () => {
    expect(() => signUnsubscribeToken({ ...organizer, organizationId: null }, KEY)).toThrow();
    expect(() =>
      signUnsubscribeToken(
        { ...organizer, scope: 'global', organizationId: null, purpose: 'OFFERS' },
        KEY,
      ),
    ).toThrow();
  });

  it('derives its key from the JWT secret rather than reusing it', () => {
    expect(KEY.equals(Buffer.from(BASE.JWT_ACCESS_SECRET))).toBe(false);
  });
});

describe('unsubscribe links and headers', () => {
  it('builds the page link, the one-click URL and the RFC 8058 headers', () => {
    const links = buildUnsubscribeLinks(
      cfg({
        ...BASE,
        APP_ENV: 'QA',
        CUSTOMER_WEB_URL: 'https://shop.example.test',
        PUBLIC_API_URL: 'https://api.example.test/',
      }),
      organizer,
    );
    expect(links.pageUrl).toMatch(/^https:\/\/shop\.example\.test\/unsubscribe\/[\w-]+\.[\w-]+$/);
    expect(links.oneClickUrl).toMatch(
      /^https:\/\/api\.example\.test\/api\/public\/unsubscribe\/[\w-]+\.[\w-]+$/,
    );
    expect(links.headers).toEqual({
      'List-Unsubscribe': `<${links.oneClickUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('refuses to put a localhost link in a deployed email', () => {
    expect(() =>
      buildUnsubscribeLinks(
        cfg({
          ...BASE,
          APP_ENV: 'PRODUCTION',
          CUSTOMER_WEB_URL: 'https://shop.example.test',
          // Required in PRODUCTION (no fallback to the sign-in secret there).
          UNSUBSCRIBE_SIGNING_SECRET: 'u'.repeat(40),
        }),
        organizer,
      ),
    ).toThrow(/PUBLIC_API_URL/);
  });

  it('lets only a clean https List-Unsubscribe reach the transport', () => {
    const msg = (value: string, post?: string) =>
      ({
        listUnsubscribe: { 'List-Unsubscribe': value, 'List-Unsubscribe-Post': post },
      }) as never;
    expect(listUnsubscribeHeaders({} as never)).toBeNull();
    expect(listUnsubscribeHeaders(msg('<http://api.example.test/x>'))).toBeNull();
    expect(listUnsubscribeHeaders(msg('<https://api.example.test/x>\r\nBcc: a@b.c'))).toBeNull();
    expect(listUnsubscribeHeaders(msg('https://api.example.test/x'))).toBeNull();
    expect(
      listUnsubscribeHeaders(msg('<https://api.example.test/x>', 'List-Unsubscribe=One-Click')),
    ).toEqual({
      'List-Unsubscribe': '<https://api.example.test/x>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    // Any other Post value is dropped, not passed through.
    expect(listUnsubscribeHeaders(msg('<https://api.example.test/x>', 'evil'))).toEqual({
      'List-Unsubscribe': '<https://api.example.test/x>',
    });
  });
});
