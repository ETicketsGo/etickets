'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import {
  api,
  Button,
  Card,
  DataTable,
  Dialog,
  Select,
  StatusBadge,
  useToast,
  errorMessage,
  dateTime,
  type Column,
  type EventSession,
  type SeatingRoom,
  DateTimeField,
} from '@eticketsgo/web-kit';

/** The value of a room select meaning "no room". Empty string, so it is also falsy. */
const GENERAL_ADMISSION = '';

/** Where an organizer goes to create a room and publish a seat map. */
const ROOMS_HREF = '/organizer/cinemas';

/**
 * The helper line under a seating control.
 *
 * Extracted because it is shown in two places that must not drift — the add form and the
 * change dialog — and because "no rooms exist yet" has to be a route to the fix rather than
 * a description of the problem. An organizer told that they need a published seat map, with
 * nowhere to click, has been given the same non-answer twice.
 */
function SeatingHelp({
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
        We couldn&rsquo;t load your rooms, so only general admission is available here.
      </p>
    );
  }
  if (chosen) {
    return (
      <p className="mt-1.5 text-caption text-text-muted">
        Buyers pick a named seat from {chosen.layoutName ?? 'this room’s'} layout. A ticket type is
        created for each seat category and priced from it.
      </p>
    );
  }
  if (rooms && rooms.length === 0) {
    return (
      <p className="mt-1.5 text-caption text-text-muted">
        Buyers choose how many tickets they want. To sell numbered seats you need a room with a
        published seat map —{' '}
        <Link href={ROOMS_HREF} className="underline hover:text-text-primary">
          set one up
        </Link>
        .
      </p>
    );
  }
  return (
    <p className="mt-1.5 text-caption text-text-muted">
      Buyers choose how many tickets they want. Pick a room to sell numbered seats instead.
    </p>
  );
}

export default function SessionsTab() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const {
    data: event,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.events.get(id),
  });

  /*
    The rooms this event can be seated in.

    Asked of the server rather than assembled here from venues and screens, because the rule
    for which rooms qualify — this organization's, with a published seat map — is the same
    rule the create and change calls enforce, and two copies of it drift.
  */
  const rooms = useQuery({
    queryKey: ['seating-rooms', event?.organizationId],
    queryFn: () => api.events.seatingRooms(event!.organizationId),
    enabled: !!event?.organizationId,
  });
  const roomById = (screenId: string) => rooms.data?.find((r) => r.id === screenId);

  const [form, setForm] = useState({ startsAt: '', endsAt: '', screenId: GENERAL_ADMISSION });

  const add = useMutation({
    mutationFn: () =>
      api.events.addSession(id, {
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        // Omitted entirely when general admission — sending an empty string would be a room
        // id that does not exist, and the request would be refused rather than understood.
        ...(form.screenId ? { screenId: form.screenId } : {}),
      }),
    onSuccess: (session) => {
      toast.push(
        session.screenId
          ? 'Session added. Ticket types were created from the room’s seat categories.'
          : 'Session added.',
        'success',
      );
      setForm({ startsAt: '', endsAt: '', screenId: GENERAL_ADMISSION });
      qc.invalidateQueries({ queryKey: ['event', id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  // ── Changing an existing session's seating ──────────────────────────────────────
  const [editing, setEditing] = useState<EventSession | null>(null);
  const [nextRoom, setNextRoom] = useState(GENERAL_ADMISSION);

  const openChange = (s: EventSession) => {
    setEditing(s);
    setNextRoom(s.screenId ?? GENERAL_ADMISSION);
  };

  const changeSeating = useMutation({
    mutationFn: () => api.events.updateSessionSeating(editing!.id, nextRoom || null),
    onSuccess: (session) => {
      toast.push(
        session.screenId
          ? 'Seating updated. Ticket types now come from the room’s seat categories.'
          : 'This session is general admission again. Add ticket types to sell it.',
        'success',
      );
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['event', id] });
    },
    // The server's message names the reason — how many are sold, how many held. Replacing it
    // with "could not update" would throw away the only part the organizer can act on.
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const columns: Column<EventSession>[] = [
    { key: 'start', header: 'Starts', render: (s) => dateTime(s.startsAt) },
    { key: 'end', header: 'Ends', render: (s) => dateTime(s.endsAt) },
    {
      key: 'seating',
      header: 'Seating',
      /*
        Named, not just flagged. "Reserved seating" alone tells the organizer something they
        could already infer; which room it is in is the fact they came to the schedule for,
        and the one that catches a session booked into the wrong auditorium.
      */
      render: (s) => (
        <div className="space-y-0.5">
          {s.screenId ? (
            <>
              <span className="text-text-primary">Reserved seating</span>
              {s.screen ? (
                <span className="block text-caption text-text-muted">
                  {s.screen.cinema.name} · {s.screen.name}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-text-muted">General admission</span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openChange(s);
            }}
            className="block rounded text-caption text-action-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Change
          </button>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
    { key: 'tickets', header: 'Ticket types', render: (s) => s.ticketTypes?.length ?? 0 },
  ];

  const endBeforeStart =
    !!form.startsAt && !!form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt);
  const valid = !!form.startsAt && !!form.endsAt && !endBeforeStart;

  const editingTicketTypes = editing?.ticketTypes?.length ?? 0;
  const unchanged = (editing?.screenId ?? GENERAL_ADMISSION) === nextRoom;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <DataTable
          columns={columns}
          rows={event?.sessions}
          loading={isLoading}
          rowKey={(s) => s.id}
          error={isError ? "We couldn't load this. Please try again." : undefined}
          onRetry={() => refetch()}
        />
      </div>
      <Card title="Add session">
        <div className="space-y-3">
          <DateTimeField
            id="s"
            label="Starts at"
            value={form.startsAt}
            onChange={(v) => setForm({ ...form, startsAt: v })}
          />
          <DateTimeField
            id="e"
            label="Ends at"
            value={form.endsAt}
            relativeTo={form.startsAt}
            min={form.startsAt}
            onChange={(v) => setForm({ ...form, endsAt: v })}
            error={endBeforeStart ? 'End must be after start.' : undefined}
          />

          <div>
            <Select
              id="room"
              label="Seating"
              value={form.screenId}
              disabled={rooms.isLoading}
              onChange={(e) => setForm({ ...form, screenId: e.target.value })}
            >
              <option value={GENERAL_ADMISSION}>General admission — no seat map</option>
              {(rooms.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.venueName} · {r.name} ({r.sellableSeats} seats)
                </option>
              ))}
            </Select>
            <SeatingHelp
              rooms={rooms.data}
              chosen={roomById(form.screenId)}
              failed={rooms.isError}
            />
          </div>

          <Button
            className="w-full"
            loading={add.isPending}
            disabled={!valid}
            onClick={() => add.mutate()}
          >
            Add session
          </Button>
        </div>
      </Card>

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Change seating"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              loading={changeSeating.isPending}
              disabled={unchanged}
              onClick={() => changeSeating.mutate()}
            >
              {nextRoom ? 'Use this room' : 'Make it general admission'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-[0.9375rem] text-text-secondary">
            {editing ? dateTime(editing.startsAt) : ''}
          </p>

          <Select
            id="next-room"
            label="Seating"
            value={nextRoom}
            disabled={rooms.isLoading}
            onChange={(e) => setNextRoom(e.target.value)}
          >
            <option value={GENERAL_ADMISSION}>General admission — no seat map</option>
            {(rooms.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.venueName} · {r.name} ({r.sellableSeats} seats)
              </option>
            ))}
          </Select>
          <SeatingHelp rooms={rooms.data} chosen={roomById(nextRoom)} failed={rooms.isError} />

          {/*
            The consequence, before it happens rather than after.

            Changing seating REPLACES this session's ticket types — a seated session derives
            one per seat category and a general-admission one carries whatever was typed, so
            keeping both would leave two competing prices on the same night. Nothing is sold
            (the server refuses otherwise), so what is lost is draft configuration — but it is
            still the organizer's work, and discovering it afterwards is how somebody stops
            trusting the console.
          */}
          {!unchanged && editingTicketTypes > 0 && (
            <p className="rounded-md border border-status-warning/40 bg-tint-warning p-3 text-caption text-text-primary">
              This session&rsquo;s {editingTicketTypes} ticket type
              {editingTicketTypes === 1 ? '' : 's'} will be replaced
              {nextRoom
                ? ' by one for each of the room’s seat categories.'
                : '. Add new ones afterwards to sell this session.'}
            </p>
          )}

          <p className="text-caption text-text-muted">
            Seating can only be changed while nothing is sold or held. After the first sale the room
            is fixed, because changing it would move seats people have already paid for.
          </p>
        </div>
      </Dialog>
    </div>
  );
}
