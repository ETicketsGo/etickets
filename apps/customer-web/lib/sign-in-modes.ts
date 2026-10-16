'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Which sign-in tabs to offer, and which one to open on.
 *
 * `phoneSignIn` comes from GET /capabilities. It is false only when the platform has declared
 * text messages off (SMS_ENABLED=false). Anything else -- true, absent, or the request
 * failing -- keeps the usual behaviour, so a slow or broken capabilities call can never lock
 * phone sign-in away from a platform that has it.
 *
 * `smsCountries` is the same answer made specific: the countries a code can actually reach.
 * An EMPTY list is the same as SMS declared off - no number anywhere can be sent a code, so a
 * Mobile tab would be a form that can only fail (QA today: log mode, every request a 503).
 * Absent means an API older than the list, and changes nothing.
 */
export type SignInMode = 'phone' | 'email';

export function signInModes(
  phoneSignIn: boolean | undefined,
  prefilledEmail: boolean,
  smsCountries?: readonly string[],
): { modes: SignInMode[]; initial: SignInMode } {
  if (phoneSignIn === false || (smsCountries && smsCountries.length === 0)) {
    return { modes: ['email'], initial: 'email' };
  }
  return { modes: ['phone', 'email'], initial: prefilledEmail ? 'email' : 'phone' };
}

/**
 * The capabilities sign-in and sign-up both need, fetched once per page.
 *
 * Until it answers the page shows a neutral placeholder rather than a tab that may vanish; if
 * the call fails it falls back to the usual two tabs.
 */
export function useSmsCapability(): {
  loaded: boolean;
  phoneSignIn: boolean | undefined;
  smsCountries: string[] | undefined;
} {
  const [state, setState] = useState<{
    loaded: boolean;
    phoneSignIn: boolean | undefined;
    smsCountries: string[] | undefined;
  }>({ loaded: false, phoneSignIn: undefined, smsCountries: undefined });
  useEffect(() => {
    let live = true;
    api
      .capabilities()
      .then((c) => {
        if (!live) return;
        setState({
          loaded: true,
          phoneSignIn: c.phoneSignIn,
          smsCountries: Array.isArray(c.phoneSignInCountries) ? c.phoneSignInCountries : undefined,
        });
      })
      .catch(() => live && setState((s) => ({ ...s, loaded: true })));
    return () => {
      live = false;
    };
  }, []);
  return state;
}
