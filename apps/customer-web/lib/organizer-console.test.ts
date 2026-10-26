import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
  A plain function, not vi.fn(): vitest's spy tracks a returned promise's outcome on a derived
  promise, so a rejection the code under test DOES catch is still reported as unhandled.
*/
const handoff = vi.hoisted(() => ({
  calls: [] as string[],
  impl: (() => Promise.resolve({ code: '', expiresInSeconds: 60 })) as () => Promise<{
    code: string;
    expiresInSeconds: number;
  }>,
}));
const createHandoff = (audience: string) => {
  handoff.calls.push(audience);
  return handoff.impl();
};
vi.mock('@eticketsgo/web-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eticketsgo/web-kit')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      auth: { ...actual.api.auth, createHandoff: (a: string) => createHandoff(a) },
    },
  };
});

import { JWT_LIKE } from '@eticketsgo/web-kit';
import { ORGANIZER_LOGIN_URL, ORGANIZER_URL, openOrganizerConsole } from './organizer-console';

const CODE = 'b25lLXRpbWUtY29kZS1vZi10aGlydHktdHdvLWJ5dGVzLXhYeA';

describe('openOrganizerConsole', () => {
  beforeEach(() => {
    handoff.calls = [];
  });

  it('carries a one-time code in the fragment, and no token anywhere in the address', async () => {
    handoff.impl = () => Promise.resolve({ code: CODE, expiresInSeconds: 60 });
    const navigate = vi.fn();

    const target = await openOrganizerConsole(navigate);

    expect(handoff.calls).toEqual(['organizer']);
    expect(navigate).toHaveBeenCalledWith(target);
    const url = new URL(target);
    expect(url.origin).toBe(new URL(ORGANIZER_URL).origin);
    expect(url.pathname).toBe('/handoff');
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#code=${CODE}`);
    expect(target).not.toMatch(JWT_LIKE);
  });

  it('opens the console sign-in when no code can be made, never a dead click', async () => {
    handoff.impl = () => Promise.reject(new Error('403'));
    const navigate = vi.fn();
    expect(await openOrganizerConsole(navigate)).toBe(ORGANIZER_LOGIN_URL);
    expect(navigate).toHaveBeenCalledWith(ORGANIZER_LOGIN_URL);
  });
});
