import { redactProviderText } from './provider-text';

/**
 * Provider error text, before it is stored or logged.
 *
 * The failures columns said "never contains the destination" and Twilio's own messages name the
 * number they refused. These cases are the shapes providers actually print, and the last test
 * is the other half of the contract: what an operator needs to act on must survive.
 */
describe('redactProviderText', () => {
  it.each([
    ["The 'To' number +15551230000 is not a valid phone number.", '+15551230000'],
    ['Invalid To Phone Number: +1 (415) 555-0123', '(415) 555-0123'],
    ['Attempt to send to unsubscribed recipient 14155550123', '14155550123'],
    ['number 415-555-0123 is unreachable', '415-555-0123'],
    ['Indian number 97044 64007 rejected', '97044 64007'],
    ['mobile 919704464007 is on DND', '919704464007'],
  ])('removes the number from: %s', (text, number) => {
    const out = redactProviderText(text);
    expect(out).not.toContain(number);
    expect(out).toContain('[phone]');
  });

  it('removes credentials and the account they belong to', () => {
    /*
      Built at runtime, never written as literals. A credential-shaped string committed to the
      repository is flagged by secret scanning whether or not it is real -- and a test that
      teaches people to click "allow this secret" is teaching the wrong habit.
    */
    const fakeToken = '0123456789abcdef'.repeat(2);
    const fakeAccount = `AC${fakeToken}`;
    const out = redactProviderText(
      `Authenticate failed for ${fakeAccount} using ${fakeToken} via ` +
        'https://user:s3cret@api.example.com/x with Bearer eyJhbGciOi.payload-part',
    );
    expect(out).not.toContain(fakeAccount);
    expect(out).not.toContain(fakeToken);
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('eyJhbGciOi');
  });

  it('removes an email address', () => {
    expect(redactProviderText('rejected for deeptrics@gmail.com')).toBe('rejected for [email]');
  });

  it('keeps the error code, the message SID and a date, which an operator acts on', () => {
    const text =
      'twilio error 21211 for SM0123456789abcdef0123456789abcdef on 2026-09-11 (HTTP 400)';
    expect(redactProviderText(text)).toBe(text);
  });

  it('returns an empty string for nothing, rather than "undefined"', () => {
    expect(redactProviderText(undefined)).toBe('');
    expect(redactProviderText(null)).toBe('');
  });
});
