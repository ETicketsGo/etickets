'use client';

import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api } from '@eticketsgo/web-kit';

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
  key: 'organization' | 'venue' | 'team' | 'experience';
  title: string;
  description: string;
  done: boolean;
  /** Where the primary action for this step lives. */
  href: string;
  cta: string;
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
 * Derives onboarding completion entirely from existing list endpoints — no new
 * backend. Reuses the same query keys as the venues/team/events pages so the
 * cache is shared. `orgName` comes from the active org (guaranteed by OrgProvider,
 * which blocks rendering until an organization exists — so the org step is always met).
 */
export function useOnboardingProgress(orgId: string, orgName: string): OnboardingProgress {
  const venuesQ = useQuery({
    queryKey: ['venues', orgId],
    queryFn: () => api.venues.list(orgId),
  });
  const membersQ = useQuery({
    queryKey: ['members', orgId],
    queryFn: () => api.organizations.members(orgId),
  });
  const eventsQ = useQuery({
    queryKey: ['events', orgId],
    queryFn: () => api.events.list(orgId),
  });

  const hasVenue = (venuesQ.data?.length ?? 0) > 0;
  // A team member beyond the sole owner.
  const hasTeam = (membersQ.data ?? []).filter((m) => m.role !== 'ORGANIZER_OWNER').length > 0;
  const hasPublished = (eventsQ.data ?? []).some((e) => e.status === 'PUBLISHED');
  const eventCount = eventsQ.data?.length ?? 0;
  const memberCount = membersQ.data?.length ?? 0;

  const steps: OnboardingStep[] = [
    {
      key: 'organization',
      title: 'Create your organization',
      description: orgName,
      done: true,
      href: '/organizer/settings',
      cta: 'View',
    },
    {
      key: 'venue',
      title: 'Add your first venue',
      description: hasVenue
        ? `${venuesQ.data?.length} venue(s) added`
        : 'Where will your experiences happen?',
      done: hasVenue,
      href: '/organizer/onboarding',
      cta: hasVenue ? 'Manage' : 'Add venue',
    },
    {
      key: 'team',
      title: 'Invite a team member',
      description: hasTeam
        ? `${memberCount} member(s) on your team`
        : 'Add managers or check-in staff.',
      done: hasTeam,
      href: '/organizer/team',
      cta: hasTeam ? 'Manage team' : 'Invite',
    },
    {
      key: 'experience',
      title: 'Create & publish an experience',
      description: hasPublished
        ? 'Your first experience is live.'
        : eventCount > 0
          ? `${eventCount} event(s) — publish one to finish.`
          : 'Build your first event and submit it for review.',
      done: hasPublished,
      href: '/organizer/events/new',
      cta: eventCount > 0 ? 'Manage events' : 'Create experience',
    },
  ];

  const completed = steps.filter((s) => s.done).length;

  return {
    steps,
    completed,
    total: steps.length,
    allComplete: completed === steps.length,
    isLoading: venuesQ.isLoading || membersQ.isLoading || eventsQ.isLoading,
    isError: venuesQ.isError || membersQ.isError || eventsQ.isError,
    refetch: () => {
      venuesQ.refetch();
      membersQ.refetch();
      eventsQ.refetch();
    },
  };
}
