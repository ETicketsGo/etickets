'use client';

import type { RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Dialog } from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import { BrandActionButton } from '@/components/brand-forms';
import { FollowPreferences, followPreferencesKey } from '@/components/follow-preferences';

/**
 * The dialog the Follow button opens. Two views of the same choices:
 *
 *   - `followed`: just after a follow saved. Says so, and offers what they hear.
 *   - `manage`:   an existing follower pressed "Following". The same choices, plus an
 *                 explicit "Unfollow <name>". Nothing is unfollowed until that is pressed.
 *
 * A bottom sheet on a phone, a centred dialog from `sm` up.
 */
export function FollowPreferencesDialog({
  open,
  mode,
  organizationId,
  organizationName,
  onClose,
  onUnfollow,
  unfollowPending = false,
  returnFocusRef,
}: {
  open: boolean;
  mode: 'followed' | 'manage';
  organizationId: string;
  organizationName: string;
  onClose: () => void;
  onUnfollow: () => void;
  unfollowPending?: boolean;
  /** Where focus goes when the dialog closes (the Follow button). */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations('storefront.follow');

  const prefs = useQuery({
    queryKey: followPreferencesKey(organizationId),
    queryFn: () => api.followPreferences(organizationId),
    enabled: open,
    retry: false,
  });

  const name = { name: organizationName };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      brand
      sheetOnMobile
      returnFocusRef={returnFocusRef}
      title={mode === 'followed' ? t('followedTitle', name) : t('manageTitle', name)}
      description={mode === 'followed' ? t('followedLead') : t('manageLead')}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {mode === 'manage' && (
            <BrandActionButton
              variant="secondary"
              className="!text-brand-critical"
              loading={unfollowPending}
              onClick={onUnfollow}
              data-testid="follow-dialog-unfollow"
            >
              {t('unfollowAction', name)}
            </BrandActionButton>
          )}
          <BrandActionButton variant="primary" onClick={onClose} data-testid="follow-dialog-done">
            {t('done')}
          </BrandActionButton>
        </div>
      }
    >
      {prefs.isPending ? (
        <p role="status" aria-busy="true" className="py-4 text-brand-ui text-brand-ink-2">
          {t('prefsLoading')}
        </p>
      ) : prefs.isError || !prefs.data ? (
        <div role="alert" className="space-y-3 py-2">
          <p className="text-brand-ui text-brand-critical">{t('prefsLoadError')}</p>
          <BrandActionButton variant="secondary" size="sm" onClick={() => prefs.refetch()}>
            {t('retry')}
          </BrandActionButton>
        </div>
      ) : (
        <FollowPreferences organizationId={organizationId} initial={prefs.data} feedback="inline" />
      )}
    </Dialog>
  );
}
