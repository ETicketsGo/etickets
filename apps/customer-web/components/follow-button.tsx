'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Check, Plus } from 'lucide-react';
import { BrandButton, useToast, type FollowStatus } from '@eticketsgo/web-kit';
import { api, type FollowSource } from '@/lib/api';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useSignedIn, isAuthFailure } from '@/components/sign-in-required';
import { hasFollowIntent, signInToFollowHref, withoutFollowIntent } from '@/lib/follow-intent';
import { followPreferencesKey } from '@/components/follow-preferences';
import { FollowPreferencesDialog } from '@/components/follow-preferences-dialog';

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
 * ── AFTER A FOLLOW, AND PRESSING "FOLLOWING" ───────────────────────────────────────
 * A follow that saved opens a dialog: "You are following <name>", with what they hear from
 * this organizer. Pressing "Following" opens the same choices plus an explicit
 * "Unfollow <name>". It used to unfollow on the first press, with no way to reach the
 * choices except the account page. A follow that failed opens nothing.
 *
 * Following never turns on email. Each email is off until the person turns it on.
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

  /*
    Which view of the dialog is open, if any. `followed` right after a follow saved; `manage`
    when a follower presses "Following". Pressing "Following" never unfollows by itself.
  */
  const [dialogOpen, setDialogOpen] = useState(false);
  // Kept after closing, so the heading does not change while the dialog animates out.
  const [dialogMode, setDialogMode] = useState<'followed' | 'manage'>('manage');
  const openDialog = (mode: 'followed' | 'manage') => {
    setDialogMode(mode);
    setDialogOpen(true);
  };

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['following'] });
    qc.invalidateQueries({ queryKey: ['organizer', organizationId] });
    qc.invalidateQueries({ queryKey: followPreferencesKey(organizationId) });
  };

  const follow = useMutation({
    mutationFn: () => api.follow(organizationId, source),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: followKey(organizationId) });
      const previous = qc.getQueryData<FollowStatus>(followKey(organizationId));
      qc.setQueryData<FollowStatus>(followKey(organizationId), {
        organizationId,
        following: true,
      });
      return { previous };
    },
    onError: (error, _v, context) => {
      qc.setQueryData(followKey(organizationId), context?.previous);
      if (isAuthFailure(error)) {
        router.push(signInToFollowHref(pathname, organizationId));
        return;
      }
      toast.push(t('saveError'), 'error');
    },
    onSuccess: () => {
      refresh();
      // The dialog is the confirmation: it says "You are following <name>".
      openDialog('followed');
    },
  });

  const unfollow = useMutation({
    mutationFn: () => api.unfollow(organizationId),
    onError: (error) => {
      if (isAuthFailure(error)) {
        router.push(signInToFollowHref(pathname, organizationId));
        return;
      }
      toast.push(t('saveError'), 'error');
    },
    onSuccess: () => {
      qc.setQueryData<FollowStatus>(followKey(organizationId), {
        organizationId,
        following: false,
      });
      setDialogOpen(false);
      toast.push(t('unfollowed', { name: organizationName }), 'success');
      refresh();
    },
  });

  /*
    Back from signing in with `?follow=<this organizer>`: finish what they started, once.
    The parameter goes first, so a reload cannot repeat it.
  */
  useEffect(() => {
    if (signedIn !== true || completed.current || follow.isPending) return;
    if (!hasFollowIntent(window.location.search, organizationId)) return;
    completed.current = true;
    window.history.replaceState(
      window.history.state,
      '',
      withoutFollowIntent(window.location.pathname, window.location.search, window.location.hash),
    );
    follow.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, organizationId]);

  const following = status.data?.following ?? false;
  const busy = follow.isPending || unfollow.isPending;

  const onClick = () => {
    if (signedIn !== true) {
      router.push(signInToFollowHref(pathname, organizationId));
      return;
    }
    if (busy) return;
    if (following) openDialog('manage');
    else follow.mutate();
  };

  const button = (
    <BrandButton
      variant={following ? 'secondary' : 'primary'}
      size={size}
      onClick={onClick}
      aria-haspopup={following ? 'dialog' : undefined}
      aria-label={
        following
          ? t('manageLabel', { name: organizationName })
          : t('followLabel', { name: organizationName })
      }
      disabled={signedIn === null || (signedIn === true && status.isLoading) || busy}
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

  return (
    <>
      {button}
      <FollowPreferencesDialog
        open={dialogOpen}
        mode={dialogMode}
        organizationId={organizationId}
        organizationName={organizationName}
        onClose={() => setDialogOpen(false)}
        onUnfollow={() => unfollow.mutate()}
        unfollowPending={unfollow.isPending}
      />
    </>
  );
}
