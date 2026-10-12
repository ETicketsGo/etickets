/**
 * Which sign-in tabs to offer, and which one to open on.
 *
 * `phoneSignIn` comes from GET /capabilities. It is false only when the platform has declared
 * text messages off (SMS_ENABLED=false). Anything else -- true, absent, or the request
 * failing -- keeps the usual behaviour, so a slow or broken capabilities call can never lock
 * phone sign-in away from a platform that has it.
 */
export type SignInMode = 'phone' | 'email';

export function signInModes(
  phoneSignIn: boolean | undefined,
  prefilledEmail: boolean,
): { modes: SignInMode[]; initial: SignInMode } {
  if (phoneSignIn === false) return { modes: ['email'], initial: 'email' };
  return { modes: ['phone', 'email'], initial: prefilledEmail ? 'email' : 'phone' };
}
