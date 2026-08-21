import { isValidOrganizationName, organizerConsoleUrl } from '../become-organizer';

/**
 * Becoming an organizer from the phone.
 *
 * The network side is a thin wrapper over two endpoints; what is worth pinning is the
 * pure logic around it — what counts as a name, and where the handover actually points.
 * A console link that goes to the wrong host is a dead end no error message explains.
 */
jest.mock('@/services/env', () => ({ env: { webHost: 'qa.eticketsgo.com', env: 'qa' } }));

describe('the organization name', () => {
  it('mirrors the server rule rather than inventing a looser one', () => {
    // `createOrganizationSchema` is min(2).max(160); accepting a shorter name here would
    // only produce a server rejection the operator cannot act on.
    expect(isValidOrganizationName('Asha Cinemas')).toBe(true);
    expect(isValidOrganizationName('AB')).toBe(true);
    expect(isValidOrganizationName('A')).toBe(false);
    expect(isValidOrganizationName('')).toBe(false);
  });

  it('ignores surrounding whitespace, as the server does', () => {
    expect(isValidOrganizationName('   ')).toBe(false);
    expect(isValidOrganizationName('  A  ')).toBe(false);
    expect(isValidOrganizationName('  Asha  ')).toBe(true);
  });

  it('refuses a name longer than the column allows', () => {
    expect(isValidOrganizationName('x'.repeat(160))).toBe(true);
    expect(isValidOrganizationName('x'.repeat(161))).toBe(false);
  });
});

describe('the handover to the organizer console', () => {
  it('points at the organizer host for THIS build, not production', () => {
    // A QA build sending its tester to the production console is the kind of mistake that
    // looks like a login bug for an hour.
    expect(organizerConsoleUrl()).toBe('https://organizer-qa.eticketsgo.com/login');
  });

  it('puts the environment BEFORE the domain, which is how the hosts are actually named', () => {
    /*
      qa.eticketsgo.com -> organizer-qa.eticketsgo.com, per the deployment runbook and the
      CORS_ORIGINS every environment ships. `organizer.qa.eticketsgo.com` — the obvious
      construction, and the one written first — does not resolve at all.
    */
    expect(organizerConsoleUrl()).not.toContain('organizer.qa.');
    expect(organizerConsoleUrl()).toContain('organizer-qa.eticketsgo.com');
  });

  it('prefills the email, because the console is a separate sign-in', () => {
    // The app's token is not visible to a browser, so a second sign-in is unavoidable.
    // Making them retype the address on a phone keyboard is not.
    expect(organizerConsoleUrl('asha@example.test')).toBe(
      'https://organizer-qa.eticketsgo.com/login?email=asha%40example.test',
    );
  });

  it('escapes an address that would otherwise break the query string', () => {
    expect(organizerConsoleUrl('a+b@example.test')).toContain('a%2Bb%40example.test');
  });

  it('is always https', () => {
    // Opened in a system browser; a plain-http handover would be a downgrade on a link we
    // construct ourselves.
    expect(organizerConsoleUrl()).toMatch(/^https:\/\//);
    expect(organizerConsoleUrl('x@y.test')).toMatch(/^https:\/\//);
  });
});
