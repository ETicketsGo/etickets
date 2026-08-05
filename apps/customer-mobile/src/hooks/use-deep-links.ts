import { useEffect, useRef } from 'react';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { env } from '@/services/env';
import { resolveDeepLink, targetToHref } from '@/services/deep-links';
import { useAuth } from '@/hooks/use-auth';

/**
 * Handles URLs that open the app.
 *
 * WHAT THIS DOES AND DOES NOT REPLACE. Expo Router has built-in linking and will match
 * an incoming path against the file routes on its own. This hook sits in front of that
 * for the decisions the router cannot make: rejecting a hostile or off-host URL before
 * the app acts on it, and continuing a link that needs a session once the user has one.
 * It is not a substitute for the router's own matching, and it is not claimed to be —
 * a path that Expo Router recognises will still be matched by Expo Router.
 *
 * The auth-aware part is the reason this exists at all. A ticket link tapped in an
 * email by someone who is signed out would otherwise land on a sign-in prompt and lose
 * the destination; here the target is held and replayed once the session resolves.
 */
export function useDeepLinks() {
  const router = useRouter();
  const { isAuthenticated, status } = useAuth();

  /** A link that arrived while signed out and needs a session. Replayed after sign-in. */
  const pending = useRef<ReturnType<typeof targetToHref> | null>(null);
  /** Guards against handling the same cold-start URL twice. */
  const handled = useRef<string | null>(null);

  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url || handled.current === url) return;
      handled.current = url;

      const resolution = resolveDeepLink(url, env.webHost);

      if (resolution.status === 'rejected') {
        // Deliberately silent. A rejected link is either a probe or a mistake, and
        // telling the sender which of their URLs the app parses is free reconnaissance.
        // The user simply lands wherever they already were.
        return;
      }

      const href = targetToHref(resolution.target);

      if (resolution.status === 'ok' && resolution.requiresAuth && !isAuthenticated) {
        pending.current = href;
        router.push('/(auth)/login');
        return;
      }

      router.push(href as never);
    };

    // Cold start: the URL that launched the app.
    void Linking.getInitialURL().then(handle);

    // Warm: the app was already running.
    const sub = Linking.addEventListener('url', (event) => handle(event.url));
    return () => sub.remove();
  }, [router, isAuthenticated]);

  // Replay a held link once a session exists.
  useEffect(() => {
    if (status !== 'authenticated' || !pending.current) return;
    const href = pending.current;
    pending.current = null;
    router.replace(href as never);
  }, [status, router]);
}
