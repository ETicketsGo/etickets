import { describe, expect, it, vi } from 'vitest';
import { JWT_LIKE, consoleHandoffUrl } from '@eticketsgo/web-kit';
import { afterHandoff, takeHandoffCode } from './handoff';

const CODE = 'Q2hvb3NlLWEtcmFuZG9tLWNvZGUtb2YtMzItYnl0ZXMtaGVyZQ';

describe('takeHandoffCode', () => {
  it('reads the code and removes the fragment from the address bar and history at once', () => {
    const replaceState = vi.fn();
    const code = takeHandoffCode(
      { hash: `#code=${CODE}`, pathname: '/handoff', search: '' },
      { replaceState },
    );
    expect(code).toBe(CODE);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/handoff');
    expect(String(replaceState.mock.calls[0][2])).not.toContain(CODE);
  });

  it('refuses anything that is not a plausible code, and still clears the fragment', () => {
    const replaceState = vi.fn();
    const bad = takeHandoffCode(
      { hash: '#code=%3Cscript%3E', pathname: '/handoff', search: '' },
      { replaceState },
    );
    expect(bad).toBeNull();
    expect(replaceState).toHaveBeenCalled();
    const none = takeHandoffCode(
      { hash: '', pathname: '/handoff', search: '' },
      { replaceState: vi.fn() },
    );
    expect(none).toBeNull();
  });
});

describe('the handoff URL', () => {
  it('carries a code in the fragment only, never a token, never in the query', () => {
    const url = new URL(consoleHandoffUrl('https://organizer.eticketsgo.com/', CODE));
    expect(url.origin).toBe('https://organizer.eticketsgo.com');
    expect(url.pathname).toBe('/handoff');
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#code=${CODE}`);
    expect(url.toString()).not.toMatch(JWT_LIKE);
  });
});

describe('afterHandoff', () => {
  it('sends organizers to the console and back-office accounts to the choice page', () => {
    expect(afterHandoff(['CUSTOMER', 'ORGANIZER_OWNER'])).toBe('/organizer');
    expect(afterHandoff(['ADMIN', 'ORGANIZER_MANAGER'])).toBe('/back-office?next=%2Forganizer');
  });
});
