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
  key: 'organization' | 'venue' | 'seating' | 'payouts' | 'team' | 'experience';
  title: string;
  description: string;
  done: boolean;
  /** Where the primary action for this step lives. */
  href: string;
  cta: string;
  /**
   * Shown, but not counted against completion.
   *
   * Reserved seating is not something every organizer needs — a promoter selling standing
   * tickets is finished without ever drawing a seat map, and a checklist that tells them
   * they are 4-of-5 done is lying to make a feature look important. It is listed because it
   * is otherwise undiscoverable, and marked optional because it genuinely is.
   */
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
  /*
    Rooms that could actually host reserved seating — the same list the seating picker uses,
    so the checklist cannot claim a step is done while the picker still shows nothing.
  */
  const roomsQ = useQuery({
    queryKey: ['seating-rooms', orgId],
    queryFn: () => api.events.seatingRooms(orgId),
  });
  /*
    Whether this organization could actually be PAID.

    `canSellPaidTickets` is the server's own verdict, not a guess assembled here from
    onboarding flags — the payouts page already shows it, and two readings of the same
    question would eventually disagree.
  */
  const payoutsQ = useQuery({
    queryKey: ['organizer-payments-status', orgId],
    queryFn: () => api.organizerPayments.status(orgId),
  });

  const hasVenue = (venuesQ.data?.length ?? 0) > 0;
  // A team member beyond the sole owner.
  const hasTeam = (membersQ.data ?? []).filter((m) => m.role !== 'ORGANIZER_OWNER').length > 0;
  const hasPublished = (eventsQ.data ?? []).some((e) => e.status === 'PUBLISHED');
  const roomCount = roomsQ.data?.length ?? 0;
  const canBePaid = payoutsQ.data?.canSellPaidTickets ?? false;
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
      key: 'seating',
      title: 'Set up a room with a seat map',
      description:
        roomCount > 0
          ? `${roomCount} room(s) ready for reserved seating`
          : 'Only needed if buyers should pick their own seats.',
      done: roomCount > 0,
      optional: true,
      href: '/organizer/cinemas',
      cta: roomCount > 0 ? 'Manage rooms' : 'Set up a room',
    },
    {
      /*
        Required, deliberately, even though an organizer running only free events does not
        need it.

        This was missing entirely, while a checklist headed "a few quick steps to start
        selling tickets" reported them 2-of-4 done. Somebody could publish an event, sell it,
        and first learn at settlement that no money could reach them. A rare free-only
        organizer sitting at 4-of-5 is a much smaller harm than that, and the description
        says plainly which case it applies to.
      */
      key: 'payouts',
      title: 'Set up how you get paid',
      description: canBePaid
        ? 'Ready to receive settlements.'
        : 'Needed before you can sell paid tickets. Free events do not require it.',
      done: canBePaid,
      href: '/organizer/payouts',
      cta: canBePaid ? 'View payouts' : 'Set up payouts',
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

  /*
    Progress counts the REQUIRED steps only. Including an optional one would mean an
    organizer who will never sell a numbered seat can never reach 100%, and a checklist that
    cannot be finished stops being a checklist and becomes a permanent nag.
  */
  const required = steps.filter((s) => !s.optional);
  const completed = required.filter((s) => s.done).length;

  return {
    steps,
    completed,
    total: required.length,
    allComplete: completed === required.length,
    isLoading: venuesQ.isLoading || membersQ.isLoading || eventsQ.isLoading,
    isError: venuesQ.isError || membersQ.isError || eventsQ.isError,
    // `roomsQ` is deliberately absent from isLoading/isError: the optional step must never
    // be able to make the whole checklist look broken or stuck.
    refetch: () => {
      venuesQ.refetch();
      membersQ.refetch();
      eventsQ.refetch();
      roomsQ.refetch();
      payoutsQ.refetch();
    },
  };
}
