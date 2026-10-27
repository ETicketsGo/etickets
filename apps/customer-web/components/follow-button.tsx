'use client';

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Check, Plus } from 'lucide-react';
import { BrandButton, useToast, type FollowStatus } from '@eticketsgo/web-kit';
import { api, type FollowSource } from '@/lib/api';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useSignedIn, isAuthFailure } from '@/components/sign-in-required';
import { hasFollowIntent, signInToFollowHref, withoutFollowIntent } from '@/lib/follow-intent';

export const followKey = (organizationId: string) => ['follow', organizationId] as const;

/**
 * Follow / Following, backed by the API.
 *
 * ── WHAT IT REPLACES ───────────────────────────────────────────────────────────────
 * The old button wrote the organizer id to this browser's localStorage and nothing else.
 * Nothing on the server knew, another device did not know, and the page that said "we tell
 * you when they announce a new event" had nothing to tell anybody from.
 *
 * ── OPTIMISTIC, AND HONEST ABOUT FAILING ───────────────────────────────────────────
 * The label changes at once. If the API refuses, it changes back and says so - a button
 * that shows "Following" for a follow that never saved is the old bug again.
 *
 * ── SIGNED OUT ─────────────────────────────────────────────────────────────────────
 * Pressing it sends the person to sign in with `?follow=<id>` on the way back. When they
 * return signed in, this button completes the follow once and removes the parameter.
 *
 * Following never turns on email. That is a separate choice, on the Following page.
 */
export function FollowButton({
  organizationId,
  organizationName,
  source = 'ORGANIZER_PAGE',
  size = 'md',
}: {
  organizationId: string;
  organizationName: string;
  source?: FollowSource;
  size?: 'sm' | 'md' | 'lg';
}) {
  const t = useTranslations('storefront.follow');
  const signedIn = useSignedIn();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const completed = useRef(false);

  const status = useQuery({
    queryKey: followKey(organizationId),
    queryFn: () => api.followStatus(organizationId),
    enabled: signedIn === true,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      next ? api.follow(organizationId, source) : api.unfollow(organizationId),
    onMutate: async (next: boolean) => {
      await qc.cancelQueries({ queryKey: followKey(organizationId) });
      const previous = qc.getQueryData<FollowStatus>(followKey(organizationId));
      qc.setQueryData<FollowStatus>(followKey(organizationId), {
        organizationId,
        following: next,
      });
      return { previous };
    },
    onError: (error, _next, context) => {
      qc.setQueryData(followKey(organizationId), context?.previous);
      if (isAuthFailure(error)) {
        router.push(signInToFollowHref(pathname, organizationId));
        return;
      }
      toast.push(t('saveError'), 'error');
    },
    onSuccess: (_data, next) => {
      toast.push(
        next
          ? t('followed', { name: organizationName })
          : t('unfollowed', { name: organizationName }),
        'success',
      );
      qc.invalidateQueries({ queryKey: ['following'] });
      qc.invalidateQueries({ queryKey: ['organizer', organizationId] });
    },
  });

  /*
    Back from signing in with `?follow=<this organizer>`: finish what they started, once.
    The parameter goes first, so a reload cannot repeat it.
  */
  useEffect(() => {
    if (signedIn !== true || completed.current) return;
    if (!hasFollowIntent(window.location.search, organizationId)) return;
    completed.current = true;
    window.history.replaceState(
      window.history.state,
      '',
      withoutFollowIntent(window.location.pathname, window.location.search, window.location.hash),
    );
    mutation.mutate(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, organizationId]);

  const following = status.data?.following ?? false;

  const onClick = () => {
    if (signedIn !== true) {
      router.push(signInToFollowHref(pathname, organizationId));
      return;
    }
    mutation.mutate(!following);
  };

  return (
    <BrandButton
      variant={following ? 'secondary' : 'primary'}
      size={size}
      onClick={onClick}
      aria-pressed={signedIn === true ? following : undefined}
      aria-label={
        following
          ? t('unfollowLabel', { name: organizationName })
          : t('followLabel', { name: organizationName })
      }
      disabled={signedIn === null || (signedIn === true && status.isLoading) || mutation.isPending}
      data-testid="follow-button"
    >
      {following ? (
        <Check className="h-4 w-4" aria-hidden />
      ) : (
        <Plus className="h-4 w-4" aria-hidden />
      )}
      {following ? t('following') : t('follow')}
    </BrandButton>
  );
}
