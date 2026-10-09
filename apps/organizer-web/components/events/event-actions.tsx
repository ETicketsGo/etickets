'use client';

import Link from 'next/link';
import { Copy, Pencil, Trash2, Users } from 'lucide-react';
import { Spinner } from '@eticketsgo/web-kit';

const control =
  'inline-flex h-9 items-center justify-center rounded-md border border-border-input bg-background-surface text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas disabled:pointer-events-none disabled:opacity-50';
const iconButton = `${control} w-9`;

/**
 * What can be done to one event from the list: open it, edit it, copy it, see its bookings,
 * delete it.
 *
 * Open is the one worded button; the other four are icons NAMED for the event ("Edit Jazz
 * Night"), with the same words as a tooltip. Five worded buttons did not fit a card at 320px
 * without wrapping into a second row taller than the card's text, and in a table they made
 * the actions column the widest one. The names keep each control unambiguous to a screen
 * reader in a list of twenty identical "Edit" buttons.
 */
export function EventActions({
  event,
  duplicating,
  onDuplicate,
  onDelete,
}: {
  event: { id: string; title: string; _count: { bookings: number } };
  duplicating: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const base = `/organizer/events/${event.id}`;
  const booked = event._count.bookings > 0;
  return (
    /*
      A table row opens the event on click, so clicks on these controls stop here - otherwise a
      Delete would also navigate away from the dialog it just opened.
    */
    <div className="flex flex-wrap items-center gap-1.5" onClick={(ev) => ev.stopPropagation()}>
      {/*
        Named for the event with aria-label, not a hidden span: a hidden copy of the title is
        still text on the page, and "find the title" would then find it twice.
      */}
      <Link
        href={base}
        aria-label={`Open ${event.title}`}
        className={`${control} px-3.5 text-button font-semibold text-text-primary`}
      >
        Open
      </Link>
      <Link
        href={`${base}/edit`}
        className={iconButton}
        aria-label={`Edit ${event.title}`}
        title="Edit details"
      >
        <Pencil className="h-4 w-4" aria-hidden />
      </Link>
      <button
        type="button"
        className={iconButton}
        aria-label={`Duplicate ${event.title}`}
        title="Duplicate as a new draft"
        disabled={duplicating}
        onClick={onDuplicate}
      >
        {duplicating ? <Spinner className="h-4 w-4" /> : <Copy className="h-4 w-4" aria-hidden />}
      </button>
      <Link
        href={`${base}/orders`}
        className={iconButton}
        aria-label={`View bookings for ${event.title}`}
        title="View bookings"
      >
        <Users className="h-4 w-4" aria-hidden />
      </Link>
      {/*
        Only while nobody has booked. Disabled with the reason rather than hidden, so an
        organizer looking for the button learns why it is not available.
      */}
      <button
        type="button"
        className={`${iconButton} text-status-error hover:text-status-error`}
        aria-label={`Delete ${event.title}`}
        title={
          booked
            ? 'This event has bookings, so it cannot be deleted. Pause it instead.'
            : 'Delete event'
        }
        disabled={booked}
        onClick={onDelete}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
