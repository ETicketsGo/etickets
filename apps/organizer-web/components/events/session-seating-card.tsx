'use client';

import Link from 'next/link';
import { Armchair, Eye, Lock, Users } from 'lucide-react';
import { Badge, Button, Menu, StatusBadge, money, type MenuItem } from '@eticketsgo/web-kit';
import { layoutLabel, type SessionSeating } from './seating-model';

/**
 * One show's seating, said in full: what kind, where, which layout version, what is sold, and
 * what can still be changed - with the reason in words wherever the answer is no.
 */
export function SessionSeatingCard({
  sessionId,
  eventId,
  when,
  status,
  seating,
  onPreview,
  onChange,
}: {
  sessionId: string;
  eventId: string;
  /** The start time at the venue, with its zone. */
  when: string;
  status: string;
  seating: SessionSeating;
  onPreview: () => void;
  onChange: () => void;
}) {
  const base = `/organizer/events/${eventId}`;
  const reserved = seating.kind === 'reserved';
  const { capacity, sold, held, available } = seating.counts;
  const percent = capacity > 0 ? Math.min(100, Math.round((sold / capacity) * 100)) : null;
  const headingId = `seating-${sessionId}`;
  const owner = seating.owner;

  const more: MenuItem[] = [{ kind: 'link', label: 'Edit ticket prices', href: `${base}/tickets` }];
  if (owner?.layoutsHref)
    more.push({
      kind: 'link',
      label: owner.kind === 'cinema' ? 'Open the screen layouts' : 'Open the space layouts',
      href: owner.layoutsHref,
    });
  if (reserved) {
    /*
      Holding or blocking single seats on ONE show exists only as cinema live operations. For
      any other space there is no screen for it, so the menu says so instead of linking to a
      page that cannot do it.
    */
    more.push(
      owner?.kind === 'cinema' && owner.cinemaId
        ? {
            kind: 'link',
            label: 'Block or release seats',
            href: `/organizer/cinemas/${owner.cinemaId}/live`,
          }
        : {
            kind: 'note',
            label: 'Block or release seats',
            reason:
              'Blocking single seats for one show is available for cinema screens only. Contact support to keep seats off sale here.',
          },
    );
  }

  return (
    <article
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-background-surface p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3
            id={headingId}
            className="break-words text-base font-semibold tabular-nums text-text-primary"
          >
            {when}
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={reserved ? 'info' : 'neutral'}>
              {reserved ? (
                <Armchair className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Users className="h-3.5 w-3.5" aria-hidden />
              )}
              {reserved ? 'Reserved seating' : 'General admission'}
            </Badge>
            {status !== 'SCHEDULED' ? <StatusBadge status={status} /> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {reserved && seating.layout ? (
            <Button variant="outline" size="sm" onClick={onPreview}>
              <Eye className="h-4 w-4" aria-hidden />
              Preview buyer seat map
            </Button>
          ) : null}
          <Menu items={more} ariaLabel={`More seating actions for ${when}`} />
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <dl className="min-w-0 space-y-2 text-sm">
          {reserved ? (
            <>
              <div className="min-w-0">
                <dt className="text-caption text-text-muted">Space</dt>
                <dd className="break-words text-text-primary">{seating.place}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-caption text-text-muted">Layout</dt>
                <dd className="break-words text-text-primary">
                  {seating.layout ? (
                    <>
                      {seating.layout.name && seating.layout.name !== 'Default'
                        ? `${seating.layout.name}, `
                        : ''}
                      <span className="font-medium">version {seating.layout.version}</span>
                      {seating.layout.status && seating.layout.status !== 'PUBLISHED' ? (
                        <span className="text-text-muted">
                          {' '}
                          ({seating.layout.status.toLowerCase()})
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-text-muted">Loading the layout version...</span>
                  )}
                  {seating.newer ? (
                    <span className="mt-0.5 block text-caption text-text-muted">
                      A newer layout, {layoutLabel(seating.newer)}, is published. This show keeps
                      version {seating.layout?.version}, because a show keeps the layout it was
                      scheduled with
                      {seating.change.allowed ? '. Change seating to move it.' : '.'}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-caption text-text-muted">Layout owned by</dt>
                <dd className="break-words text-text-primary">
                  {owner?.kind === 'cinema'
                    ? `${owner.name} (cinema). Its screen layouts are managed in the cinema's setup.`
                    : 'This space, in your organization. Its layouts are managed under Venues & seating.'}
                </dd>
              </div>
            </>
          ) : (
            <div className="min-w-0">
              <dt className="text-caption text-text-muted">Seating</dt>
              <dd className="text-text-primary">
                Buyers choose how many tickets they want; there is no seat map. Capacity is the
                quantity of each ticket type.
              </dd>
            </div>
          )}
        </dl>

        <div className="min-w-0">
          <dl className="grid grid-cols-3 gap-2 text-sm">
            {[
              ['Sold', sold],
              ['Held', held],
              ['Available', available],
            ].map(([label, value]) => (
              <div
                key={label}
                className="min-w-0 rounded-md border border-border bg-background-canvas px-2.5 py-2"
              >
                <dt className="text-caption text-text-muted">{label}</dt>
                <dd className="text-base font-semibold tabular-nums text-text-primary">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-caption text-text-muted">
            {capacity > 0 ? (
              <>
                <span className="tabular-nums">
                  {sold} of {capacity}
                </span>{' '}
                {reserved ? 'seats' : 'tickets'} sold{percent !== null ? ` (${percent}%)` : ''}.
                Held means in a buyer&rsquo;s checkout right now.
              </>
            ) : (
              'Nothing is on sale for this show yet.'
            )}
          </p>
          {percent !== null ? (
            <div
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-background-subtle"
              aria-hidden="true"
            >
              <div
                className="h-full rounded-full bg-action-primary"
                style={{ width: `${percent}%` }}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4">
        <h4 className="text-caption font-medium uppercase tracking-wide text-text-muted">
          Ticket categories and prices
        </h4>
        {seating.categories.length === 0 ? (
          <p className="mt-1.5 text-sm text-text-muted">
            No ticket types yet.{' '}
            <Link href={`${base}/tickets`} className="font-medium text-action-primary underline">
              Add tickets
            </Link>
          </p>
        ) : (
          <ul className="mt-1.5 divide-y divide-border rounded-md border border-border">
            {seating.categories.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm"
              >
                <span className="min-w-0 break-words font-medium text-text-primary">
                  {c.name}
                  {c.status !== 'ACTIVE' ? (
                    <span className="font-normal text-text-muted"> (off sale)</span>
                  ) : null}
                </span>
                <span className="flex flex-wrap items-baseline gap-x-3 text-text-secondary">
                  <span className="font-semibold tabular-nums text-text-primary">
                    {money(c.priceMinor, c.currency)}
                  </span>
                  <span className="tabular-nums">
                    {c.sold} / {c.total} sold
                  </span>
                  {c.priceLocked ? (
                    <span className="text-caption text-text-muted">
                      Price fixed after the first sale
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 border-t border-border pt-3">
        {seating.change.allowed ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-caption text-text-muted">
              Nothing is sold or held, so you can still move this show to another space or layout
              {reserved ? ', or make it general admission' : ''}.
            </p>
            <Button variant="outline" size="sm" onClick={onChange}>
              Change seating
            </Button>
          </div>
        ) : (
          <p className="flex items-start gap-2 text-sm text-text-secondary">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden />
            <span>
              <span className="sr-only">Seating locked. </span>
              {seating.change.reason}
            </span>
          </p>
        )}
      </div>
    </article>
  );
}
