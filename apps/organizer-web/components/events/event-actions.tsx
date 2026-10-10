'use client';

import { Armchair, Copy, Pencil, ScanLine, Ticket, Trash2, Users } from 'lucide-react';
import { ButtonLink, Menu, type MenuItem } from '@eticketsgo/web-kit';

/**
 * What can be done to one event from the list: one tinted "Manage", and a square "..." menu
 * with real menu semantics for the rest.
 *
 * Every control is named for the event ("Manage Jazz Night", "More actions for Jazz Night"),
 * so a list of twenty identical buttons is unambiguous to a screen reader.
 */
export function eventMenuItems(input: {
  event: { id: string; _count: { bookings: number } };
  duplicating: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
}): MenuItem[] {
  const base = `/organizer/events/${input.event.id}`;
  const booked = input.event._count.bookings > 0;
  return [
    { kind: 'link', label: 'Edit details', href: `${base}/edit`, icon: Pencil },
    { kind: 'link', label: 'Seating', href: `${base}/seating`, icon: Armchair },
    { kind: 'link', label: 'Tickets and prices', href: `${base}/tickets`, icon: Ticket },
    { kind: 'link', label: 'Bookings', href: `${base}/orders`, icon: Users },
    { kind: 'link', label: 'Check-in', href: `${base}/checkin`, icon: ScanLine },
    { kind: 'separator' },
    {
      label: input.duplicating ? 'Duplicating...' : 'Duplicate as a new draft',
      onSelect: input.onDuplicate,
      icon: Copy,
      disabled: input.duplicating,
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
      : { label: 'Delete event', onSelect: input.onDelete, danger: true, icon: Trash2 },
  ];
}

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
   * In the table there is no Manage: the row's first cell already opens the event (and is the
   * keyboard's way in), and a second button per row pushed the "..." menu out of the visible
   * table at 1024 and 1440.
   */
  inTable?: boolean;
}) {
  const items = eventMenuItems({ event, duplicating, onDuplicate, onDelete });
  return (
    <div
      className={`flex items-center gap-2 ${fill ? 'w-full' : 'justify-end'}`}
      onClick={(ev) => ev.stopPropagation()}
    >
      {/*
        The visible word is "Manage"; the name says which event. A label that differs from the
        visible text must START with it (WCAG 2.5.3), and "Manage <title>" does.
      */}
      {inTable ? null : (
        <span className={fill ? 'min-w-0 flex-1' : ''}>
          {/* `relative` keeps the hidden half of the name inside a sideways-scrolling box. */}
          <ButtonLink
            href={`/organizer/events/${event.id}`}
            variant="tinted"
            size="sm"
            className={`relative ${fill ? 'w-full' : ''} [&>span]:sr-only`}
          >
            Manage
            <span> {event.title}</span>
          </ButtonLink>
        </span>
      )}
      <Menu trigger="icon" label={`More actions for ${event.title}`} items={items} size="md" />
    </div>
  );
}
