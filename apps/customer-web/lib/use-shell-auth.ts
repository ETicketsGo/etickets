'use client';

import { useEffect, useState } from 'react';
import { useIsAuthenticated } from '@eticketsgo/web-kit';
import { useRouter } from '@/i18n/navigation';
import { tokenStore } from '@/lib/api';
import { currentUserId } from '@/lib/offline/identity';
import { purgeUser } from '@/lib/offline/wallet-store';

/**
 * Is the person looking at this page signed in? One answer for every piece of site chrome.
 *
 * The storefront header, the marketing header and the marketing footer all branch on this, and
 * they must agree: a signed-in customer who opens Features from the footer and sees "Sign in"
 * in the bar has been told they were signed out (N1). So the rule lives here once.
 *
 * - `authed`: the token decides once mounted. Before that (the server render and the first
 *   client paint) the session-hint cookie the server read decides, so hydration has nothing to
 *   reconcile and a signed-in customer is not served "Sign in" first.
 * - `known`: false only while the hint said "signed out" and the token has not been read yet.
 *   That is the one moment the answer may be wrong (a session that predates the cookie), so a
 *   bar that must never show "Sign in" to a signed-in person can draw a placeholder instead.
 *
 * Subscribed, not read once: Next keeps the layout mounted across client navigation, and
 * signing in or out in another tab changes the answer here too.
 */
export function useShellAuth(initialSignedIn: boolean): { authed: boolean; known: boolean } {
  const live = useIsAuthenticated();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return {
    authed: mounted ? live : initialSignedIn,
    known: mounted || initialSignedIn,
  };
}

/**
 * Sign out from any bar, and land on the home page.
 *
 * Shared-device safety: this user's cached wallet and QR payloads are removed before the session
 * is cleared, so nothing private survives on the device.
 */
export function useSignOut(): () => void {
  const router = useRouter();
  return () => {
    const uid = currentUserId();
    if (uid) void purgeUser(uid);
    tokenStore.clear();
    router.push('/');
  };
}
