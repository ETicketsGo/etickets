import { describe, expect, it } from 'vitest';
import { appReturnUrl } from './app-return';

const q = (s: string) => new URLSearchParams(s);

describe('appReturnUrl', () => {
  it('hands an app checkout back to the app scheme', () => {
    expect(
      appReturnUrl(q('booking=bk_123&via=app&session_id=cs_1'), 'return', 'etgnative-qa'),
    ).toBe('etgnative-qa://checkout/return?booking=bk_123');
    expect(appReturnUrl(q('booking=bk_123&via=app'), 'cancel', 'etgnative')).toBe(
      'etgnative://checkout/cancel?booking=bk_123',
    );
  });

  it('does nothing for a web checkout or when no scheme is configured', () => {
    expect(appReturnUrl(q('booking=bk_123'), 'return', 'etgnative')).toBeNull();
    expect(appReturnUrl(q('booking=bk_123&via=app'), 'return', undefined)).toBeNull();
  });

  it('refuses any scheme that is not the app, and any odd booking id', () => {
    expect(appReturnUrl(q('booking=bk_1&via=app'), 'return', 'javascript')).toBeNull();
    expect(appReturnUrl(q('booking=bk_1&via=app'), 'return', 'https')).toBeNull();
    expect(appReturnUrl(q('booking=a/../b&via=app'), 'return', 'etgnative')).toBeNull();
    expect(appReturnUrl(q('booking=x%26evil%3D1&via=app'), 'return', 'etgnative')).toBeNull();
    expect(appReturnUrl(q(`booking=${'a'.repeat(65)}&via=app`), 'return', 'etgnative')).toBeNull();
  });
});
