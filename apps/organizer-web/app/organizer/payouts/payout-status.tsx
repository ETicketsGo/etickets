'use client';

import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Ban,
  Building2,
  CheckCircle2,
  Clock,
  HelpCircle,
  ShieldCheck,
} from 'lucide-react';
import { api, ButtonLink, Card, Skeleton, type PayoutAccountState } from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { PAYOUT_JOURNEY, payoutStatusView, type PayoutStatusTone } from '@/lib/payout-status-view';

/**
 * Where this organizer's payouts stand, and who is waiting on whom.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────────────
 * One badge reading UNVERIFIED. It said nothing about whether the organizer could still sell,
 * whether money could reach them, or whether anybody was waiting on them - and because
 * verification is an ETicketsGo job, the honest answer to the last one was "no", which the word
 * UNVERIFIED manages to imply the opposite of.
 *
 * ── THE SERVER DECIDES, THIS RENDERS ───────────────────────────────────────────────
 * Every judgement here comes from `GET /payouts/account-state`. This component does not look at
 * `verifiedAt`, `chargesEnabled`, `payoutsEnabled`, `requirementsDue` or `disabledReason`, and
 * must not start: a second interpretation of those five is exactly what the server model was
 * built to prevent, and it would drift the moment one of them changed meaning.
 *
 * The only mapping this file owns is presentational - which icon and which tone - and it is
 * keyed on the state CODE, so a new state fails visibly rather than rendering as a default.
 */

/**
 * The icon per state. Heading, tone and every word live in `payoutStatusView`, which is pure and
 * is tested exhaustively - an icon is the one presentational choice a test could not meaningfully
 * assert, so it is the only one left here.
 */
const ICON: Record<PayoutAccountState['code'], typeof Clock> = {
  NO_ACCOUNT: Building2,
  DETAILS_REQUIRED: AlertTriangle,
  UNDER_REVIEW: Clock,
  ACTION_REQUIRED: AlertTriangle,
  RESTRICTED: Ban,
  VERIFIED: ShieldCheck,
  PAYOUTS_ENABLED: CheckCircle2,
};

const TONE_CLASS: Record<PayoutStatusTone, string> = {
  neutral: 'bg-background-subtle text-text-secondary',
  waiting: 'bg-tint-primary text-action-primary',
  attention: 'bg-tint-warning text-status-warning',
  good: 'bg-tint-success text-status-success',
  stopped: 'bg-tint-error text-status-error',
};

/**
 * One availability line.
 *
 * Selling and payouts are reported SEPARATELY and never merged, because the server keeps them
 * separate: a provider can hold charges while payouts work, and a missing bank account stops
 * neither sale nor show. Collapsing them would tell an organizer their event cannot sell when it
 * can, which is the more expensive of the two mistakes.
 *
 * The word carries the meaning; the colour only agrees with it. A reader who sees no colour at
 * all still reads "Available" or "Not ready yet".
 */
function Availability({
  label,
  value,
  affected,
}: {
  label: string;
  value: string;
  affected: boolean;
}) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd
        className={`mt-0.5 font-medium ${affected ? 'text-status-warning' : 'text-status-success'}`}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * The journey, shown only where the account is genuinely progressing through it.
 *
 * Deliberately NOT drawn for ACTION_REQUIRED or RESTRICTED: those are interruptions, and a
 * progress bar beside them would say everything is advancing normally when it has stopped. It is
 * also not a claim that every provider walks these four steps - the server's current state always
 * wins, and this only ever illustrates one that is already true.
 */
function Journey({ step }: { step: number | null }) {
  // Null means this state is an interruption, not a point on the line. See `payoutStatusView`.
  if (step === null) return null;
  return (
    <ol className="mt-4 flex flex-wrap gap-2" aria-label="Payout setup progress">
      {PAYOUT_JOURNEY.map((label, i) => {
        const done = i < step;
        const here = i === step;
        return (
          <li
            key={label}
            aria-current={here ? 'step' : undefined}
            className={`rounded-full px-3 py-1 text-caption ${
              here
                ? 'bg-action-primary text-text-inverse'
                : done
                  ? 'bg-tint-success text-status-success'
                  : 'bg-background-subtle text-text-muted'
            }`}
          >
            {/* The state is in the words, so this reads correctly with no colour at all. */}
            {done ? 'Done: ' : here ? 'Now: ' : ''}
            {label}
          </li>
        );
      })}
    </ol>
  );
}

export function PayoutStatus({ orgId }: { orgId: string }) {
  const { activeOrgSentenceName } = useOrg();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['organizer', 'payout-account-state', orgId],
    queryFn: () => api.payouts.accountState(orgId),
  });

  if (isLoading) {
    return (
      <div data-testid="payout-status">
        <Card title="Payout status">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="mt-3 h-16 w-full" />
        </Card>
      </div>
    );
  }

  /*
    A failure is NOT a payout state.

    Rendering "no account" or "under review" because a request failed would be a reassuring lie
    about money. The honest answer is that we do not currently know, said plainly, with a retry.
  */
  if (isError || !data) {
    return (
      <div data-testid="payout-status">
        <Card title="Payout status">
          <div className="flex items-start gap-3">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${TONE_CLASS.neutral}`}
            >
              <HelpCircle className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <p className="font-semibold text-text-primary">We cannot check your payout status</p>
              <p className="mt-1 text-sm text-text-secondary">
                This is a problem reading the status, not a change to your account. Nothing about
                your payouts has changed.
              </p>
              <button
                type="button"
                onClick={() => void refetch()}
                className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-background-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-primary"
              >
                Try again
              </button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const view = payoutStatusView(data);
  const Icon = ICON[data.code];

  return (
    <div data-testid="payout-status">
      <Card title="Payout status">
        <div className="flex items-start gap-3">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${TONE_CLASS[view.tone]}`}
          >
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-text-primary">{view.heading}</p>
            {/*
            Which organization this money belongs to, using the one identity implementation from
            PR 1. It matters most here: somebody holding two organizations with the same name can
            otherwise configure the wrong one's bank account and never find out.
          */}
            <p className="mt-0.5 text-caption text-text-muted">For {activeOrgSentenceName}</p>

            {/* The server's own sentence. Never provider-internal text. */}
            <p className="mt-2 text-sm text-text-secondary">{view.explanation}</p>

            <dl className="mt-3 grid gap-2 sm:grid-cols-2">
              <Availability
                label="Paid ticket sales"
                value={view.salesWord}
                affected={view.salesAffected}
              />
              <Availability
                label="Receiving payouts"
                value={view.payoutWord}
                affected={view.payoutsAffected}
              />
            </dl>

            {view.cta ? (
              <div className="mt-4">
                <ButtonLink href={view.cta.href}>{view.cta.label}</ButtonLink>
              </div>
            ) : (
              /*
              Said out loud, because the absence of a button is not an answer. An organizer who
              sees a status and no control cannot tell whether they are blocked or simply waiting.
            */
              <p className="mt-4 rounded-md bg-background-subtle px-3 py-2 text-sm text-text-secondary">
                {view.noActionNotice}
              </p>
            )}

            <Journey step={view.journeyStep} />
          </div>
        </div>
      </Card>
    </div>
  );
}
