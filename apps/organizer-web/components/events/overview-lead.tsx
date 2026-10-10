'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Armchair, ArrowRight, ChevronDown, ScanLine, Ticket, Users } from 'lucide-react';
import {
  Button,
  ButtonLink,
  IconTile,
  Menu,
  StatusPill,
  type MenuItem,
  type OrgEventDetail,
  type TileTone,
} from '@eticketsgo/web-kit';
import { type NextStep, type SaleState, type Setup } from './event-lifecycle';
import { seatingMix } from './seating-model';
import { ticketTotals, sessionBreakdown } from './event-overview-model';
import { timeAtVenue } from './event-list-model';

/**
 * The top of an event's overview: where it stands, in three separate answers, and the ONE
 * thing to do next.
 *
 * The page used to open with "About this event" - the description the organizer wrote
 * themselves - and kept the status and its buttons in a side column. What an organizer comes
 * to an event for is to sell it, run its door or fix what stops it, so that leads; the
 * description moved to the end.
 */
export function OverviewLead({
  event,
  sale,
  setup,
  next,
  onSubmit,
  onResume,
  onPause,
  onDelete,
  busy,
}: {
  event: OrgEventDetail;
  sale: SaleState;
  setup: Setup;
  next: NextStep;
  onSubmit: () => void;
  onResume: () => void;
  onPause: () => void;
  onDelete: () => void;
  busy: { submit: boolean; resume: boolean; pause: boolean };
}) {
  const base = `/organizer/events/${event.id}`;
  const [setupOpen, setSetupOpen] = useState(false);
  const booked = (event._count?.bookings ?? 0) > 0;

  const more: MenuItem[] = [{ kind: 'link', label: 'Edit details', href: `${base}/edit` }];
  if (event.status === 'PUBLISHED') more.push({ label: 'Pause sales', onSelect: onPause });
  more.push({ kind: 'link', label: 'Open check-in', href: `${base}/checkin` });
  more.push(
    booked
      ? {
          kind: 'note',
          label: 'Delete',
          reason: 'This event has bookings, so it cannot be deleted. Pause it to stop sales.',
        }
      : { label: 'Delete event', onSelect: onDelete, danger: true },
  );

  const primary =
    next.kind === 'submit' ? (
      <Button loading={busy.submit} onClick={onSubmit}>
        Submit for approval
      </Button>
    ) : next.kind === 'resume' ? (
      <Button loading={busy.resume} onClick={onResume}>
        Resume event
      </Button>
    ) : next.kind === 'link' ? (
      next.href.startsWith('#') ? (
        <a
          href={next.href}
          className="inline-flex h-10 items-center justify-center rounded-md bg-action-primary px-4 text-sm font-semibold text-action-primary-foreground hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          {next.label}
        </a>
      ) : (
        <ButtonLink href={next.href}>{next.label}</ButtonLink>
      )
    ) : null;

  return (
    <section
      aria-labelledby="next-step-title"
      className="rounded-lg border border-border bg-background-surface p-4 sm:p-5"
    >
      {/*
        Stage and sales are in the event's header, on every page of it. What is left here is
        the third answer - what is still the organizer's to set up - beside the one next step.
      */}
      <dl className="flex flex-wrap items-center gap-2 text-ui">
        <dt className="text-text-muted">Setup</dt>
        <dd>
          {setup.complete ? (
            <StatusPill tone="success" size="sm">
              {setup.label}
            </StatusPill>
          ) : (
            <button
              type="button"
              aria-expanded={setupOpen}
              aria-controls="setup-items"
              onClick={() => setSetupOpen((o) => !o)}
              className="inline-flex items-center gap-1 rounded-full bg-tint-warning px-2.5 py-0.5 text-micro font-semibold text-status-warning hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {setup.label}
              <ChevronDown
                aria-hidden
                className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${setupOpen ? 'rotate-180' : ''}`}
              />
            </button>
          )}
        </dd>
      </dl>
      {/* The server's own sentence for why it is not (fully) selling, beside its few words. */}
      {sale.detail && sale.state !== 'SELLING' ? (
        <p className="mt-2 max-w-prose break-words text-caption text-text-secondary">
          {sale.detail}
        </p>
      ) : null}
      {setupOpen && !setup.complete ? (
        <ul
          id="setup-items"
          className="mt-3 space-y-1.5 rounded-md bg-background-canvas p-3 text-sm"
        >
          {setup.items.map((item) => (
            <li key={item.label} className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="min-w-0 break-words text-text-primary">{item.label}</span>
              {item.href ? (
                <Link
                  href={item.href}
                  className="text-caption font-medium text-action-primary underline underline-offset-2"
                >
                  Fix this
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-t border-border pt-4">
        <div className="min-w-0 max-w-prose">
          <p className="text-caption font-medium uppercase tracking-wide text-text-muted">Next</p>
          <h2 id="next-step-title" className="text-title font-semibold text-text-primary">
            {next.title}
          </h2>
          <p className="mt-0.5 text-sm text-text-secondary">{next.body}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {primary}
          <Menu items={more} ariaLabel="More event actions" />
        </div>
      </div>
    </section>
  );
}

/**
 * The four places an organizer goes from an event, each with the one fact that makes it worth
 * going: how it is seated, how much is sold, how many bookings, when the door next opens.
 */
export function ManageTiles({ event }: { event: OrgEventDetail }) {
  const base = `/organizer/events/${event.id}`;
  const t = ticketTotals(event.sessions);
  const { upcoming } = sessionBreakdown(event.sessions, Date.now());
  const bookings = event._count?.bookings ?? 0;
  const tiles = [
    {
      href: `${base}/seating`,
      label: 'Seating',
      fact: seatingMix(event.sessions),
      icon: Armchair,
      tone: 'teal' as TileTone,
    },
    {
      href: `${base}/tickets`,
      label: 'Tickets',
      fact: t.types === 0 ? 'No ticket types yet' : `${t.sold} of ${t.capacity} sold`,
      icon: Ticket,
      tone: 'blue' as TileTone,
    },
    {
      href: `${base}/orders`,
      label: 'Bookings',
      fact: `${bookings} booking${bookings === 1 ? '' : 's'}`,
      icon: Users,
      tone: 'purple' as TileTone,
    },
    {
      href: `${base}/checkin`,
      label: 'Check-in',
      fact: upcoming[0]
        ? `Next: ${timeAtVenue(upcoming[0].startsAt, event.venue)}`
        : 'Nothing to come',
      icon: ScanLine,
      tone: 'amber' as TileTone,
    },
  ];
  return (
    <nav aria-label="Manage this event">
      <ul className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-4">
        {tiles.map(({ href, label, fact, icon, tone }) => (
          <li key={label} className="min-w-0">
            <Link
              href={href}
              className="group flex h-full min-h-[4.5rem] items-center gap-3 rounded-lg border border-border bg-background-surface p-3.5 shadow-xs transition-[box-shadow,transform] duration-150 hover:-translate-y-px hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            >
              <IconTile icon={icon} tone={tone} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-text-primary">{label}</span>
                <span className="block break-words text-caption tabular-nums text-text-muted">
                  {fact}
                </span>
              </span>
              <ArrowRight
                className="h-4 w-4 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
