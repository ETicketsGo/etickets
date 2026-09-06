'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  Badge,
  Button,
  ButtonLink,
  Card,
  PageHeader,
  errorMessage,
  useToast,
} from '@eticketsgo/web-kit';
import {
  Building2,
  Users,
  CalendarDays,
  Banknote,
  CheckCircle2,
  Sparkles,
  FlaskConical,
  ArrowRight,
  LifeBuoy,
} from 'lucide-react';
import { useOrg } from '@/components/org-context';
import { OnboardingChecklist } from '@/components/onboarding-checklist';
import { useOnboardingProgress, setOnboardingDismissed } from '@/lib/onboarding';
import { EXPERIENCE_TEMPLATES } from '@/lib/templates';

function StepBadge({ done, optional }: { done: boolean; optional?: boolean }) {
  if (done) {
    return (
      <Badge tone="success">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        Done
      </Badge>
    );
  }
  // "To do" on a step most organizers should skip reads as work outstanding. Say which it is.
  return <Badge tone="neutral">{optional ? 'Optional' : 'To do'}</Badge>;
}

export default function OnboardingPage() {
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const progress = useOnboardingProgress(activeOrg.id, activeOrg.name);

  const venuesQ = useQuery({
    queryKey: ['venues', activeOrg.id],
    queryFn: () => api.venues.list(activeOrg.id),
  });
  const hasVenue = (venuesQ.data?.length ?? 0) > 0;

  const stepMap = Object.fromEntries(progress.steps.map((s) => [s.key, s])) as Record<
    (typeof progress.steps)[number]['key'],
    (typeof progress.steps)[number]
  >;

  // ── Load a sample DRAFT event (never published) using existing endpoints ──
  const loadSample = useMutation({
    mutationFn: async () => {
      let venueId = venuesQ.data?.[0]?.id;
      if (!venueId) {
        const created = await api.venues.create({
          organizationId: activeOrg.id,
          name: 'Sample Venue',
          city: 'Mumbai',
          country: 'India',
          capacity: 200,
        });
        venueId = created.id;
      }
      const event = await api.events.create({
        organizationId: activeOrg.id,
        venueId,
        title: 'Sample: Summer Music Festival',
        category: 'Music',
        description:
          'This is a sample draft event created so you can explore the organizer tools. Edit or delete it any time — it is never published automatically.',
        feeMode: 'CUSTOMER_PAYS',
      });
      const startsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const endsAt = new Date(startsAt.getTime() + 3 * 60 * 60 * 1000);
      const session = await api.events.addSession(event.id, {
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      });
      await api.events.addTicketType({
        eventSessionId: session.id,
        name: 'General',
        priceMinor: 49900,
        quantityTotal: 100,
        maxPerOrder: 6,
      });
      return event;
    },
    onSuccess: (event) => {
      toast.push('Sample draft event created.', 'success');
      qc.invalidateQueries({ queryKey: ['events', activeOrg.id] });
      qc.invalidateQueries({ queryKey: ['venues', activeOrg.id] });
      router.push(`/organizer/events/${event.id}`);
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={`Welcome to ETicketsGo, ${activeOrg.name}`}
        description="Let's get your account ready to sell tickets. Follow the steps below — each links to the real tools."
        action={
          <Button variant="ghost" onClick={() => setOnboardingDismissed(true)}>
            Skip for now
          </Button>
        }
      />

      <OnboardingChecklist progress={progress} />

      {/* ── Guided steps ── */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* 1. Organization */}
        <Card>
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tint-primary text-action-primary">
              <Building2 className="h-5 w-5" />
            </span>
            <StepBadge done={stepMap.organization?.done ?? true} />
          </div>
          <p className="font-semibold text-text-primary">1. Confirm your organization</p>
          <p className="mt-1 text-[0.9375rem] text-text-muted">
            You&apos;re set up as{' '}
            <span className="font-medium text-text-secondary">{activeOrg.name}</span>. Manage its
            details and profile in Settings.
          </p>
          <ButtonLink href="/organizer/settings" variant="outline" size="sm" className="mt-4">
            Organization settings
          </ButtonLink>
        </Card>

        {/*
          2. Venue.

          This card used to carry its OWN create form — name, city, capacity, and a hardcoded
          country of India. Two forms for one object is how they drift, and they had: the
          venues page asks where the venue is, this one assumed. It now sends the organizer to
          the one form, which is also what the checklist link beside it does, so there is a
          single answer to "where do I add a venue".
        */}
        <Card>
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tint-primary text-action-primary">
              <Building2 className="h-5 w-5" />
            </span>
            <StepBadge done={hasVenue} />
          </div>
          <p className="font-semibold text-text-primary">2. Add your first venue</p>
          {hasVenue ? (
            <>
              <p className="mt-1 text-[0.9375rem] text-text-muted">
                {venuesQ.data?.length} venue(s) ready. You can add more any time.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <ButtonLink href="/organizer/venues" variant="outline" size="sm">
                  Manage venues
                </ButtonLink>
                <ButtonLink href="/organizer/events/new" variant="outline" size="sm">
                  Use in an event
                </ButtonLink>
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-[0.9375rem] text-text-muted">
                The hall, theatre or ground where your events happen. Its country decides the
                currency you sell in and the clock every show time is quoted in.
              </p>
              <ButtonLink href="/organizer/venues?new=1" size="sm" className="mt-4">
                Add venue
              </ButtonLink>
            </>
          )}
        </Card>

        {/*
          Seating — listed because it is otherwise undiscoverable.

          A room with a published seat map is the prerequisite for selling numbered seats,
          and the only route to one is a section that used to be called "Cinemas". An
          organizer running concerts had no reason to look there and no reason to know they
          needed to. Marked optional rather than numbered, because plenty of organizers never
          need it and a checklist should not manufacture work.
        */}
        <Card>
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tint-primary text-action-primary">
              <Building2 className="h-5 w-5" />
            </span>
            <StepBadge done={stepMap.seating?.done ?? false} optional />
          </div>
          <p className="font-semibold text-text-primary">Set up a room with a seat map</p>
          <p className="mt-1 text-[0.9375rem] text-text-muted">
            Only if buyers should choose their own seats. Draw the room once and any event held
            there can sell reserved seating — a concert or a play, not only a film.
          </p>
          <ButtonLink href="/organizer/cinemas" variant="outline" size="sm" className="mt-4">
            {stepMap.seating?.done ? 'Manage rooms' : 'Set up a room'}
          </ButtonLink>
        </Card>

        {/*
          Payouts. Placed before team because it is the step that decides whether the money
          from a sale can ever reach the organizer, and it was previously absent from a
          checklist that claimed to cover starting to sell.
        */}
        <Card>
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tint-primary text-action-primary">
              <Banknote className="h-5 w-5" />
            </span>
            <StepBadge done={stepMap.payouts?.done ?? false} />
          </div>
          <p className="font-semibold text-text-primary">3. Set up how you get paid</p>
          <p className="mt-1 text-[0.9375rem] text-text-muted">
            Connect a payout account so settlements can reach your bank. Needed before you can sell
            paid tickets — free events do not require it.
          </p>
          <ButtonLink href="/organizer/payouts" variant="outline" size="sm" className="mt-4">
            {stepMap.payouts?.done ? 'View payouts' : 'Set up payouts'}
          </ButtonLink>
        </Card>

        {/* 4. Team */}
        <Card>
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tint-primary text-action-primary">
              <Users className="h-5 w-5" />
            </span>
            <StepBadge done={stepMap.team?.done ?? false} />
          </div>
          <p className="font-semibold text-text-primary">4. Invite a team member</p>
          <p className="mt-1 text-[0.9375rem] text-text-muted">
            Add managers to help run events or check-in staff to scan tickets at the door.
          </p>
          <ButtonLink href="/organizer/team" variant="outline" size="sm" className="mt-4">
            Invite team
          </ButtonLink>
        </Card>

        {/* 5. Experience */}
        <Card>
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tint-primary text-action-primary">
              <CalendarDays className="h-5 w-5" />
            </span>
            <StepBadge done={stepMap.experience?.done ?? false} />
          </div>
          <p className="font-semibold text-text-primary">5. Create &amp; publish an experience</p>
          <p className="mt-1 text-[0.9375rem] text-text-muted">
            Build your event with sessions and ticket types, then submit it for review to go live.
          </p>
          <ButtonLink href="/organizer/events/new" size="sm" className="mt-4">
            Create experience
          </ButtonLink>
        </Card>
      </div>

      {/* ── Templates ── */}
      <Card
        title="Start from a template"
        action={
          <span className="flex items-center gap-1.5 text-caption text-text-muted">
            <Sparkles className="h-4 w-4" />
            Pre-fills the wizard
          </span>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {EXPERIENCE_TEMPLATES.map((t) => {
            const Icon = t.icon;
            return (
              <Link
                key={t.id}
                href={`/organizer/events/new?template=${t.id}`}
                className="group flex flex-col rounded-lg border border-border bg-background-surface p-4 shadow-sm transition-all duration-200 ease-premium hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tint-primary text-action-primary">
                  <Icon className="h-5 w-5" />
                </span>
                <p className="mt-3 font-semibold text-text-primary">{t.label}</p>
                <p className="mt-1 flex-1 text-caption text-text-muted">{t.blurb}</p>
                <span className="mt-3 inline-flex items-center gap-1 text-caption font-semibold text-action-primary">
                  Use template
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            );
          })}
        </div>
      </Card>

      {/* ── Sample data + Help ── */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tint-primary text-action-primary">
              <FlaskConical className="h-5 w-5" />
            </span>
            <div>
              <p className="font-semibold text-text-primary">Just exploring?</p>
              <p className="mt-1 text-[0.9375rem] text-text-muted">
                Load a <span className="font-medium text-text-secondary">sample draft event</span>{' '}
                to explore the tools. It is created as a draft only — never published — and you can
                delete it any time.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                loading={loadSample.isPending}
                onClick={() => loadSample.mutate()}
              >
                Load a sample draft event
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tint-primary text-action-primary">
              <LifeBuoy className="h-5 w-5" />
            </span>
            <div>
              <p className="font-semibold text-text-primary">Need a hand?</p>
              <p className="mt-1 text-[0.9375rem] text-text-muted">
                Browse the organizer knowledge base — creating events, ticket types, publishing,
                payouts, refunds, and check-in.
              </p>
              <ButtonLink href="/organizer/help" variant="outline" size="sm" className="mt-4">
                Visit help center
              </ButtonLink>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
