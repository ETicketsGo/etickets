'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api,
  Button,
  Dialog,
  Select,
  useToast,
  errorMessage,
  type EventSession,
  type SeatingRoom,
} from '@eticketsgo/web-kit';

/** The value of a room select meaning "no room". Empty string, so it is also falsy. */
export const GENERAL_ADMISSION = '';

/** Where an organizer goes to create a space and publish a seat map. */
export const ROOMS_HREF = '/organizer/cinemas';

/** "Demo Arena - Main Arena - Basketball (420 seats)": one option per LAYOUT, not per space. */
export function roomOptionLabel(r: SeatingRoom): string {
  return `${r.venueName} · ${r.name} · ${r.layoutName ?? 'Layout'} (${r.sellableSeats} seats)`;
}

/**
 * The helper line under a seating control.
 *
 * Shown in the add form and the change dialog, which must not drift, and "no rooms exist yet"
 * is a route to the fix rather than a description of the problem.
 */
export function SeatingHelp({
  rooms,
  chosen,
  failed,
}: {
  rooms: SeatingRoom[] | undefined;
  chosen: SeatingRoom | undefined;
  failed: boolean;
}) {
  if (failed) {
    return (
      <p className="mt-1.5 text-caption text-text-muted">
        We couldn&rsquo;t load your spaces, so only general admission is available here.
      </p>
    );
  }
  if (chosen) {
    return (
      <p className="mt-1.5 text-caption text-text-muted">
        Buyers pick a named seat from {chosen.layoutName ?? 'this space’s'} layout. A ticket type is
        created for each seat category and priced from it.
      </p>
    );
  }
  if (rooms && rooms.length === 0) {
    return (
      <p className="mt-1.5 text-caption text-text-muted">
        Buyers choose how many tickets they want. To sell numbered seats you need a space with a
        published seat map -{' '}
        <Link href={ROOMS_HREF} className="underline hover:text-text-primary">
          set one up
        </Link>
        .
      </p>
    );
  }
  return (
    <p className="mt-1.5 text-caption text-text-muted">
      Buyers choose how many tickets they want. Pick a space to sell numbered seats instead.
    </p>
  );
}

/**
 * Change one session's space and layout, through the one endpoint that may do it.
 *
 * Shared by the Sessions and Seating pages so the consequence warning and the server's refusal
 * read the same in both. The server refuses once anything is sold or held and says why; that
 * sentence is shown as it came, because it names the number the organizer can act on.
 */
export function ChangeSeatingDialog({
  eventId,
  session,
  rooms,
  roomsFailed,
  roomsLoading,
  whenLabel,
  onClose,
}: {
  eventId: string;
  session: EventSession | null;
  rooms: SeatingRoom[] | undefined;
  roomsFailed: boolean;
  roomsLoading: boolean;
  /** The session's start, already formatted in the venue's zone. */
  whenLabel: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const current = session?.screenId ? (session.seatMapId ?? GENERAL_ADMISSION) : GENERAL_ADMISSION;
  const [next, setNext] = useState(current);
  // Reopening shows the configuration in use, not the last one looked at.
  useEffect(() => setNext(current), [session?.id, current]);

  const roomByLayout = (layoutId: string) => rooms?.find((r) => r.layoutId === layoutId);

  const change = useMutation({
    mutationFn: () => {
      const room = roomByLayout(next);
      return api.events.updateSessionSeating(session!.id, room?.id ?? null, room?.layoutId ?? null);
    },
    onSuccess: (updated) => {
      toast.push(
        updated.screenId
          ? 'Seating updated. Ticket types now come from the space’s seat categories.'
          : 'This session is general admission again. Add ticket types to sell it.',
        'success',
      );
      qc.invalidateQueries({ queryKey: ['event', eventId] });
      onClose();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const ticketTypes = session?.ticketTypes?.length ?? 0;
  const unchanged = current === next;

  return (
    <Dialog
      open={!!session}
      onClose={onClose}
      title="Change seating"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={change.isPending} disabled={unchanged} onClick={() => change.mutate()}>
            {next ? 'Use this space' : 'Make it general admission'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[0.9375rem] text-text-secondary">{whenLabel}</p>

        <Select
          id="next-room"
          label="Seating"
          value={next}
          disabled={roomsLoading}
          onChange={(e) => setNext(e.target.value)}
        >
          <option value={GENERAL_ADMISSION}>General admission - no seat map</option>
          {(rooms ?? []).map((r) => (
            <option key={r.layoutId} value={r.layoutId}>
              {roomOptionLabel(r)}
            </option>
          ))}
        </Select>
        <SeatingHelp rooms={rooms} chosen={roomByLayout(next)} failed={roomsFailed} />

        {/*
          The consequence, before it happens. Changing seating REPLACES this session's ticket
          types - a seated session derives one per seat category - so the organizer confirms
          the loss of what they typed rather than discovering it.
        */}
        {!unchanged && ticketTypes > 0 && (
          <p className="rounded-md border border-status-warning/40 bg-tint-warning p-3 text-caption text-text-primary">
            This session&rsquo;s {ticketTypes} ticket type
            {ticketTypes === 1 ? '' : 's'} will be replaced
            {next
              ? ' by one for each of the space’s seat categories.'
              : '. Add new ones afterwards to sell this session.'}
          </p>
        )}

        <p className="text-caption text-text-muted">
          Seating can only be changed while nothing is sold or held. After the first sale the layout
          is fixed, because changing it would move seats people have already paid for.
        </p>
      </div>
    </Dialog>
  );
}
