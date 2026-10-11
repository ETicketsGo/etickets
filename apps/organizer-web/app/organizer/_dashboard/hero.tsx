import { BadgeCheck } from 'lucide-react';
import { StatusPill, SetupPill } from '@eticketsgo/web-kit';

/**
 * The welcome band at the top of the Overview: whose console this is, the date, one line about
 * the day. One compact row, not a hero.
 *
 * ── WHY NO PICTURE ─────────────────────────────────────────────────────────────────
 * The first Overview gave this band a poster-sized slot with the next event's artwork or a drawn
 * ticket. It cost ~220px of the first screen for a sentence, and the artwork was shown again a
 * moment later on the event's own card. The band now says who and when, in one line on a
 * desktop and two on a phone, and the first screen is for what needs doing.
 *
 * The heading is the welcome (`h1`), the organization is the line above it: an organizer with
 * two organizations needs to see which one they are in before anything else.
 */
export function WelcomeBand({
  orgName,
  orgStatus,
  verified,
  firstName,
  dateLine,
  shortDateLine,
  dayLine,
  setupOpen,
}: {
  orgName: string;
  orgStatus: string;
  verified: boolean;
  firstName?: string;
  /** "Saturday, 10 October 2026", in the viewer's zone. */
  dateLine: string;
  /** "Sat, 10 Oct 2026": the same date for a phone, so the line stays short. */
  shortDateLine?: string;
  /** One sentence about the day, from real counts; absent when they could not be read. */
  dayLine?: string;
  /** Open setup steps, or null while unknown. */
  setupOpen: number | null;
}) {
  return (
    <section
      aria-labelledby="overview-welcome"
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-lg border border-border bg-gradient-to-r from-tile-blue/60 via-background-surface to-background-surface px-4 py-3 shadow-xs sm:px-5"
    >
      <div className="min-w-0">
        <p
          className="truncate text-micro font-semibold uppercase tracking-[0.08em] text-action-primary"
          title={orgName}
        >
          {orgName}
        </p>
        <h1
          id="overview-welcome"
          className="break-words font-display text-[1.375rem] font-bold leading-tight tracking-tight text-text-primary sm:text-headline"
        >
          Welcome back{firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="mt-0.5 text-caption text-text-secondary">
          {shortDateLine ? (
            <>
              <span className="font-medium text-text-primary sm:hidden">{shortDateLine}</span>
              <span className="hidden font-medium text-text-primary sm:inline">{dateLine}</span>
            </>
          ) : (
            <span className="font-medium text-text-primary">{dateLine}</span>
          )}
          {dayLine ? <span>. {dayLine}</span> : null}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={orgStatus === 'APPROVED' ? 'success' : 'warning'}>
          {orgStatusLabel(orgStatus)}
        </StatusPill>
        {verified && (
          <StatusPill tone="info" dot={false}>
            <span className="inline-flex items-center gap-1">
              <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
              Verified
            </span>
          </StatusPill>
        )}
        {/* Only the good news here: open steps are listed, with their count, under Needs action. */}
        {setupOpen === 0 && <SetupPill missing={0} />}
      </div>
    </section>
  );
}

/** The organization's standing with the platform, in plain words. */
export function orgStatusLabel(status: string): string {
  switch (status) {
    case 'APPROVED':
      return 'Approved organizer';
    case 'PENDING':
    case 'PENDING_REVIEW':
    case 'UNDER_REVIEW':
      return 'Waiting for approval';
    case 'SUSPENDED':
      return 'Suspended';
    case 'REJECTED':
      return 'Not approved';
    default:
      return status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');
  }
}
