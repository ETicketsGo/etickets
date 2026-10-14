'use client';

import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ErrorState,
  PageHeader,
  brandButtonClasses,
  errorMessage,
  useToast,
} from '@eticketsgo/web-kit';
import { venuePayload } from '@/components/venue-fields';
import { ArrowRight, Banknote, CheckCircle2, Circle, FlaskConical, LifeBuoy } from 'lucide-react';
import { useOrg } from '@/components/org-context';
import {
  useOnboardingProgress,
  setOnboardingDismissed,
  type OnboardingStep,
} from '@/lib/onboarding';
import { EXPERIENCE_TEMPLATES } from '@/lib/templates';

/*
  ── GET STARTED (organizer recovery) ──────────────────────────────────────────────
  This page used to show the same five steps twice: once as a progress checklist (the server's
  action list) and again as a wall of six cards that re-derived the same steps in the browser,
  two of them always "Done". Below that, five template cards and two more cards. An organizer
  scrolled past 2,000px to read one list.

  Now there is one list, from the server's one action list (`useOnboardingProgress`, the same
  read as the sidebar's "Finish setup" and Overview's "Needs you"): the required steps with the
  progress they make up, then the optional ones, each with ONE action. Beside it, the shortcuts
  that are not steps - templates, a sample draft event, payouts and help - as short rows.
*/

const RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface';

function StepRow({ step }: { step: OnboardingStep }) {
  return (
    <li className="flex flex-col gap-3 border-t border-brand-line py-4 first:border-t-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {step.done ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-brand-positive" aria-hidden />
        ) : (
          <Circle className="mt-0.5 h-5 w-5 shrink-0 text-brand-ink-3" aria-hidden />
        )}
        <div className="min-w-0">
          <p className="text-brand-ui font-semibold text-brand-ink">
            {step.title}
            <span className="sr-only">{step.done ? ', done' : ', to do'}</span>
          </p>
          <p className="text-brand-meta text-brand-ink-2">{step.description}</p>
        </div>
      </div>
      {step.done ? (
        <Link
          href={step.href}
          className={`self-start text-brand-meta font-semibold text-brand-ink underline-offset-4 hover:underline sm:self-center ${RING}`}
        >
          {step.cta}
        </Link>
      ) : (
        <Link
          href={step.href}
          className={`self-start sm:self-center ${brandButtonClasses('secondary', 'sm')}`}
        >
          {step.cta}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      )}
    </li>
  );
}

function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="min-w-0 rounded-brand-card border border-brand-line bg-brand-surface"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pb-3 pt-4 md:px-6">
        <h2 id={id} className="text-brand-body font-semibold text-brand-ink">
          {title}
        </h2>
        {aside}
      </div>
      <div className="border-t border-brand-line px-4 md:px-6">{children}</div>
    </section>
  );
}

/** A shortcut that is not a setup step: an icon, a line of words, and where it goes. */
function ShortcutRow({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon: typeof Banknote;
  title: string;
  detail: string;
  action: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 border-t border-brand-line py-4 first:border-t-0">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-ink-3" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-brand-ui font-semibold text-brand-ink">{title}</p>
        <p className="text-brand-meta text-brand-ink-2">{detail}</p>
        <div className="mt-1">{action}</div>
      </div>
    </li>
  );
}

export default function OnboardingPage() {
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const progress = useOnboardingProgress(activeOrg.id);

  const venuesQ = useQuery({
    queryKey: ['venues', activeOrg.id],
    queryFn: () => api.venues.list(activeOrg.id),
  });

  // ── Load a sample DRAFT event (never published) using existing endpoints ──
  const loadSample = useMutation({
    mutationFn: async () => {
      let venueId = venuesQ.data?.[0]?.id;
      if (!venueId) {
        /*
          Through the SAME payload as every other venue. This built its own and omitted
          `region` and `timezone`, so the sample venue silently took the default zone -
          Asia/Kolkata - which is wrong for every organizer outside India, and a venue's
          timezone is what every showtime on its public listing is rendered in.

          The sample is explicitly an Indian venue, so it names its own zone rather than
          relying on a default that happens to match.
        */
        const created = await api.venues.create({
          organizationId: activeOrg.id,
          ...venuePayload({
            name: 'Sample Venue',
            city: 'Mumbai',
            address: '',
            capacity: '200',
            where: { country: 'India', region: 'Maharashtra', timezone: 'Asia/Kolkata' },
          }),
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

  const required = progress.steps.filter((s) => !s.optional);
  const optional = progress.steps.filter((s) => s.optional);
  const pct = progress.total === 0 ? 0 : Math.round((progress.completed / progress.total) * 100);
  const link = `text-brand-meta font-semibold text-brand-ink underline-offset-4 hover:underline ${RING}`;

  return (
    <div>
      <PageHeader
        title="Get started"
        description={`Set up ${activeOrg.name} to sell tickets. The required steps come first; the optional ones can wait until you need them.`}
        action={
          <button
            type="button"
            onClick={() => setOnboardingDismissed(true)}
            className={brandButtonClasses('quiet', 'md')}
          >
            Skip for now
          </button>
        }
      />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] xl:gap-8">
        <div className="flex min-w-0 flex-col gap-6">
          {progress.isError ? (
            <ErrorState
              message="We couldn't load your progress. Please try again."
              onRetry={progress.refetch}
            />
          ) : progress.isLoading ? (
            <div
              role="status"
              aria-busy="true"
              aria-label="Loading your setup steps"
              className="h-72 rounded-brand-card bg-brand-sunken motion-safe:animate-pulse"
            />
          ) : (
            <>
              <Panel
                title="Required to start selling"
                aside={
                  <p className="text-brand-meta tabular-nums text-brand-ink-2">
                    {progress.completed} of {progress.total} done
                  </p>
                }
              >
                <div className="pt-4">
                  <div
                    role="progressbar"
                    aria-valuenow={progress.completed}
                    aria-valuemin={0}
                    aria-valuemax={progress.total}
                    aria-label={`Setup progress: ${progress.completed} of ${progress.total} required steps done`}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-brand-sunken"
                  >
                    <div
                      className="h-full rounded-full bg-brand-ink transition-[width] duration-500 motion-reduce:transition-none"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                {required.length === 0 ? (
                  <p className="py-4 text-brand-ui text-brand-ink-2">
                    Nothing is required. You can sell tickets.
                  </p>
                ) : (
                  <ul className="mt-2">
                    {required.map((s) => (
                      <StepRow key={s.key} step={s} />
                    ))}
                  </ul>
                )}
              </Panel>

              {optional.length > 0 && (
                <Panel
                  title="Optional"
                  aside={
                    <p className="text-brand-meta text-brand-ink-2">Not counted in your progress</p>
                  }
                >
                  <ul>
                    {optional.map((s) => (
                      <StepRow key={s.key} step={s} />
                    ))}
                  </ul>
                </Panel>
              )}
            </>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Start from a template">
            <ul>
              {EXPERIENCE_TEMPLATES.map((t) => {
                const Icon = t.icon;
                return (
                  <li key={t.id} className="border-t border-brand-line first:border-t-0">
                    <Link
                      href={`/organizer/events/new?template=${t.id}`}
                      className={`group -mx-2 my-1 flex items-start gap-3 rounded-brand-control px-2 py-2.5 transition-colors duration-150 hover:bg-brand-sunken ${RING}`}
                    >
                      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-ink-3" aria-hidden />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-brand-ui font-semibold text-brand-ink group-hover:underline">
                          {t.label}
                        </span>
                        <span className="text-brand-meta text-brand-ink-2">{t.blurb}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel title="Also useful">
            <ul>
              {/*
                Payouts is listed here as well as in the required steps when the bank account is
                missing, because the payout ACCOUNT (Stripe or Razorpay) is a separate thing from
                the bank details, and an organizer selling only free events never needs it.
              */}
              <ShortcutRow
                icon={Banknote}
                title="Set up how you get paid"
                detail="Connect a payout account so settlements can reach your bank. Needed before you sell paid tickets; free events do not need it."
                action={
                  <Link href="/organizer/payouts" className={link}>
                    Open payouts
                  </Link>
                }
              />
              <ShortcutRow
                icon={FlaskConical}
                title="Just exploring?"
                detail="Load a sample draft event to try the tools. It stays a draft, it is never published, and you can delete it any time."
                action={
                  <button
                    type="button"
                    disabled={loadSample.isPending}
                    onClick={() => loadSample.mutate()}
                    className={`${link} disabled:opacity-50`}
                  >
                    {loadSample.isPending ? 'Creating the sample...' : 'Load a sample draft event'}
                  </button>
                }
              />
              <ShortcutRow
                icon={LifeBuoy}
                title="Need a hand?"
                detail="Guides for events, ticket types, publishing, payouts, refunds and check-in."
                action={
                  <Link href="/organizer/help" className={link}>
                    Visit help center
                  </Link>
                }
              />
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
