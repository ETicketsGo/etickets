import { signInHref } from '@/lib/sign-in-return';

/**
 * Remembering "I pressed Follow" across a sign-in.
 *
 * A signed-out visitor who presses Follow is sent to sign in. The page they come back to
 * carries `?follow=<organizationId>`, and the Follow button for that organizer completes the
 * follow once and removes the parameter. The intent lives in the URL rather than in storage,
 * so it survives a sign-in on another tab or a new account, and it cannot linger and follow
 * somebody later by surprise.
 */
export const FOLLOW_PARAM = 'follow';

/** `path` (with or without a query) plus `follow=<organizationId>`. */
export function withFollowIntent(path: string, organizationId: string): string {
  const [base, query = ''] = path.split('?', 2);
  const params = new URLSearchParams(query);
  params.set(FOLLOW_PARAM, organizationId);
  return `${base}?${params.toString()}`;
}

/** The sign-in link that brings the person back here and completes the follow. */
export function signInToFollowHref(currentPath: string, organizationId: string): string {
  return signInHref(withFollowIntent(currentPath, organizationId));
}

/** Whether this query string asks to follow exactly this organizer. */
export function hasFollowIntent(search: string, organizationId: string): boolean {
  return new URLSearchParams(search).get(FOLLOW_PARAM) === organizationId;
}

/** The same address without the follow parameter, for `history.replaceState`. */
export function withoutFollowIntent(pathname: string, search: string, hash = ''): string {
  const params = new URLSearchParams(search);
  params.delete(FOLLOW_PARAM);
  const rest = params.toString();
  return `${pathname}${rest ? `?${rest}` : ''}${hash}`;
}
