'use client';

import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api, type OrganizerAction } from '@eticketsgo/web-kit';

/** localStorage flag for a manually dismissed / completed onboarding experience. */
export const ONBOARDING_DONE_KEY = 'etg_onboarding_done';

export function isOnboardingDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(ONBOARDING_DONE_KEY) === '1';
}

export function setOnboardingDismissed(dismissed: boolean): void {
  if (typeof window === 'undefined') return;
  if (dismissed) localStorage.setItem(ONBOARDING_DONE_KEY, '1');
  else localStorage.removeItem(ONBOARDING_DONE_KEY);
  window.dispatchEvent(new Event('etg-onboarding-change'));
}

/** Reactive read of the dismissed flag so the dashboard card hides/shows instantly. */
export function useOnboardingDismissed(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('etg-onboarding-change', cb);
      window.addEventListener('storage', cb);
      return () => {
        window.removeEventListener('etg-onboarding-change', cb);
        window.removeEventListener('storage', cb);
      };
    },
    () => isOnboardingDismissed(),
    () => false,
  );
}

export interface OnboardingStep {
  key: string;
  title: string;
  description: string;
  done: boolean;
  /** Where the primary action for this step lives. */
  href: string;
  cta: string;
  /** Shown, but not counted against completion. */
  optional?: boolean;
}

export interface OnboardingProgress {
  steps: OnboardingStep[];
  completed: number;
  total: number;
  allComplete: boolean;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * The setup steps, from the server's one action list.
 *
 * ── WHY THIS NO LONGER COMPUTES ANYTHING ───────────────────────────────────────────
 * It used to derive completion in the browser from four list endpoints - venues, members, events,
 * seating rooms - plus a payments status call. That made the dashboard card and the Get-started
 * page two independent checklists over five independently-cached queries, which could disagree
 * with each other and with "Needs your attention" the moment one of them was stale. One of those
 * disagreements was real: the payouts step asked "can this organization be paid" from
 * `canSellPaidTickets` while readiness asked it from `hasPayoutAccount`, in different words.
 *
 * Completion is now decided once, on the server. This maps it to the shape the two surfaces
 * already render.
 *
 * ── WHICH ACTIONS ARE "SETUP" ──────────────────────────────────────────────────────
 * The things an organizer BUILDS, plus getting paid. The money item appears here and in "Needs
 * your attention" deliberately: it is genuinely both, and showing it twice is safe now that both
 * read the same row - somebody could otherwise publish an event, sell it, and first learn at
 * settlement that no money could reach them. What is NOT here is the business-identity gaps;
 * those are attention items, not steps to selling.
 */
const SETUP_CATEGORIES: OrganizerAction['category'][] = ['OPERATIONS', 'MONEY'];

export function useOnboardingProgress(orgId: string): OnboardingProgress {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['organizer', 'actions', orgId],
    queryFn: () => api.organizations.actions(orgId),
  });

  const steps: OnboardingStep[] = (data?.actions ?? [])
    .filter((a) => SETUP_CATEGORIES.includes(a.category))
    .map((a) => ({
      key: a.key,
      title: a.title,
      description: a.consequence,
      done: a.done,
      href: a.fixPath,
      cta: a.actionLabel,
      optional: a.optional,
    }));

  // Optional steps are shown and never counted, so a promoter who never draws a seat map is not
  // told they are 3-of-4 done.
  const counted = steps.filter((s) => !s.optional);
  const completed = counted.filter((s) => s.done).length;

  return {
    steps,
    completed,
    total: counted.length,
    allComplete: counted.length > 0 && completed === counted.length,
    isLoading,
    isError,
    refetch: () => void refetch(),
  };
}
