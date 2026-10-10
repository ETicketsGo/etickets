'use client';

import Link from 'next/link';
import { MoreMenu, type MoreMenuItem } from './more-menu';

/**
 * What can be done to one event from the list: one prominent "Manage", and a labelled "More"
 * menu for the rest.
 *
 * This replaced Open plus four unlabelled icon buttons. The icons were named for screen
 * readers, but a sighted organizer had to hover each 36px square to learn what it did, and
 * "Delete" sat one pixel-gap from "View bookings". Words in a menu say what each does, and the
 * primary job - managing the event - is the one thing that looks like a button.
 *
 * Every control is named for the event ("Manage Jazz Night", "More actions for Jazz Night"),
 * so a list of twenty identical buttons is unambiguous to a screen reader.
 */
export function EventActions({
  event,
  duplicating,
  onDuplicate,
  onDelete,
  fill = false,
  inTable = false,
}: {
  event: { id: string; title: string; _count: { bookings: number } };
  duplicating: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Stretch Manage to the row's width (a card); a table keeps it compact. */
  fill?: boolean;
  /**
   * In the table, Manage shows from `xl` only. Below that the row's first cell already opens
   * the event (and is the keyboard's way in), and at 1024 the two buttons pushed "More" out of
   * the visible table.
   */
  inTable?: boolean;
}) {
  const base = `/organizer/events/${event.id}`;
  const booked = event._count.bookings > 0;
  const items: MoreMenuItem[] = [
    { kind: 'link', label: 'Edit details', href: `${base}/edit` },
    { kind: 'link', label: 'Seating', href: `${base}/seating` },
    { kind: 'link', label: 'Tickets and prices', href: `${base}/tickets` },
    { kind: 'link', label: 'Bookings', href: `${base}/orders` },
    { kind: 'link', label: 'Check-in', href: `${base}/checkin` },
    {
      kind: 'button',
      label: duplicating ? 'Duplicating...' : 'Duplicate as a new draft',
      onSelect: onDuplicate,
    },
    /*
      Only while nobody has booked. Shown with its reason rather than hidden, so an organizer
      looking for it learns why it is not there.
    */
    booked
      ? {
          kind: 'note',
          label: 'Delete',
          reason: 'This event has bookings, so it cannot be deleted. Pause it to stop sales.',
        }
      : { kind: 'button', label: 'Delete event', onSelect: onDelete, danger: true },
  ];
  return (
    <div
      className={`flex items-center gap-2 ${fill ? 'w-full' : ''}`}
      onClick={(ev) => ev.stopPropagation()}
    >
      <Link
        href={base}
        aria-label={`Manage ${event.title}`}
        className={`inline-flex h-9 items-center justify-center rounded-md bg-action-primary px-4 text-sm font-semibold text-action-primary-foreground transition-colors duration-150 hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas active:translate-y-px motion-reduce:transition-none ${
          fill ? 'flex-1' : ''
        } ${inTable ? 'hidden xl:inline-flex' : ''}`}
      >
        Manage
      </Link>
      <MoreMenu items={items} ariaLabel={`More actions for ${event.title}`} />
    </div>
  );
}
