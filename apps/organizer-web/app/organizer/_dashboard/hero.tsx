'use client';

import { BadgeCheck } from 'lucide-react';
import { ImageFrame, StatusPill, SetupPill, eventImageSource } from '@eticketsgo/web-kit';

/**
 * The welcome band at the top of the Overview: who this is for, today's date, and one line
 * about the day - the reference's hero, without the stock concert photo.
 *
 * ── THE PICTURE IS THEIRS OR IT IS NOT THERE ───────────────────────────────────────
 * The reference puts a crowd photo here. An organizer's console showing somebody else's crowd
 * reads as their event, so the band shows the organizer's OWN artwork - the cover of their next
 * event - when there is one, labelled with its title, and a drawn pattern made of the theme's
 * tokens when there is not. Nothing in it is a sample.
 *
 * The heading is the welcome (`h1`), the organization is the line above it: an organizer with
 * two organizations needs to see which one they are in before anything else.
 */
export function WelcomeHero({
  orgName,
  orgStatus,
  verified,
  firstName,
  dateLine,
  dayLine,
  setupOpen,
  feature,
}: {
  orgName: string;
  orgStatus: string;
  verified: boolean;
  firstName?: string;
  /** "Saturday, 10 October 2026", in the viewer's zone. */
  dateLine: string;
  /** One sentence about the day, from real counts; absent when they could not be read. */
  dayLine?: string;
  /** Open setup steps, or null while unknown. */
  setupOpen: number | null;
  /** The next event's cover, when it has one. */
  feature?: {
    title: string;
    imagePath?: string | null;
    imageVariants?: Partial<Record<string, string>> | null;
  } | null;
}) {
  const image = feature
    ? eventImageSource({ variants: feature.imageVariants, path: feature.imagePath }, 'banner')
    : null;
  return (
    <section
      aria-labelledby="overview-welcome"
      className="relative isolate overflow-hidden rounded-xl border border-border bg-gradient-to-br from-tile-blue via-background-surface to-tile-teal shadow-xs"
    >
      {/* The drawn pattern: concentric rings and a soft glow, from the theme's own colours. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-28 -z-10 h-[22rem] w-[22rem] rounded-full opacity-70"
        style={{
          backgroundImage:
            'radial-gradient(closest-side, hsl(var(--tile-teal-foreground) / 0.16), transparent 70%), repeating-radial-gradient(circle at center, transparent 0 22px, hsl(var(--tile-teal-foreground) / 0.08) 22px 23px)',
        }}
      />
      <div className="flex h-full flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-center lg:gap-8 lg:p-7">
        <div className="min-w-0 flex-1">
          <p
            className="line-clamp-2 break-words text-micro font-semibold uppercase tracking-[0.08em] text-action-primary"
            title={orgName}
          >
            {orgName}
          </p>
          <h1
            id="overview-welcome"
            className="mt-2 break-words font-display text-display font-bold leading-tight tracking-tight text-text-primary"
          >
            Welcome back{firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="mt-2 text-[0.9375rem] text-text-secondary">
            <span className="font-medium text-text-primary">{dateLine}</span>
            {dayLine ? <span>. {dayLine}</span> : null}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
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
            {/* Only the good news here: open steps are listed, with their count, at the top of the page. */}
            {setupOpen === 0 && <SetupPill missing={0} />}
          </div>
        </div>
        {feature && image ? (
          <figure className="hidden w-[17rem] shrink-0 lg:block xl:w-[19rem]">
            <ImageFrame
              src={image.src}
              srcSet={image.srcSet}
              sizes="304px"
              alt={`Artwork for ${feature.title}`}
              ratio="16:9"
              rounded="lg"
              className="shadow-md ring-1 ring-border"
            />
            <figcaption className="mt-2 truncate text-caption text-text-muted">
              Next up: <span className="font-medium text-text-secondary">{feature.title}</span>
            </figcaption>
          </figure>
        ) : (
          <TicketArt />
        )}
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

/**
 * Two ticket stubs drawn from the theme's tokens - the band's picture when the organizer has no
 * artwork of their own yet. Plainly an illustration: no names, no numbers, nothing to mistake
 * for one of their events.
 */
function TicketArt() {
  return (
    <div aria-hidden className="relative hidden h-40 w-[17rem] shrink-0 lg:block xl:w-[18rem]">
      <div className="absolute right-6 top-3 h-28 w-52 rotate-[8deg] rounded-lg bg-tile-teal-foreground/15 ring-1 ring-tile-teal-foreground/20" />
      <div className="absolute left-2 top-6 flex h-32 w-60 -rotate-[4deg] overflow-hidden rounded-lg bg-nav shadow-lg ring-1 ring-white/10">
        <div className="relative flex-1 p-4">
          <span
            className="absolute inset-0 opacity-90"
            style={{
              backgroundImage:
                'radial-gradient(110% 90% at 100% 0%, hsl(var(--nav-accent) / 0.35), transparent 60%), repeating-linear-gradient(135deg, hsl(0 0% 100% / 0.04) 0 2px, transparent 2px 10px)',
            }}
          />
          <span className="relative block h-2 w-16 rounded-full bg-nav-accent" />
          <span className="relative mt-3 block h-2.5 w-28 rounded-full bg-white/70" />
          <span className="relative mt-2 block h-2 w-20 rounded-full bg-white/30" />
          <span className="relative mt-6 flex gap-1">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <span key={i} className="h-5 w-1.5 rounded-sm bg-white/25" />
            ))}
          </span>
        </div>
        {/* The perforation, then the stub. */}
        <div className="relative w-16 border-l-2 border-dashed border-white/20 bg-white/5">
          <span className="absolute -left-2 -top-2 h-4 w-4 rounded-full bg-tile-blue" />
          <span className="absolute -bottom-2 -left-2 h-4 w-4 rounded-full bg-tile-teal" />
          <span className="absolute inset-x-0 top-1/2 mx-auto block h-8 w-8 -translate-y-1/2 rounded-md bg-nav-accent/80" />
        </div>
      </div>
    </div>
  );
}
