'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { venueInputZone, wallClockToInstant, zoneLabel } from '@/lib/zoned-time';
import {
  api,
  Button,
  Card,
  DataTable,
  Select,
  StatusBadge,
  useToast,
  errorMessage,
  dateTime,
  type Column,
  type EventSession,
  DateTimeField,
} from '@eticketsgo/web-kit';
import {
  ChangeSeatingDialog,
  GENERAL_ADMISSION,
  SeatingHelp,
  roomOptionLabel,
} from '@/components/events/change-seating-dialog';
import { sessionSeating } from '@/components/events/seating-model';

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
  /*
    Options are LAYOUTS, not spaces. `seating-rooms` returns one row per layout, so a space with
    a basketball bowl and an end-stage concert appears twice - and keyed by the space's id, the
    two options had the same value and either one sent only the space, leaving the server to
    guess which configuration was meant. Keying by `layoutId` makes the choice the organizer's.
  */
  const roomByLayout = (layoutId: string) => rooms.data?.find((r) => r.layoutId === layoutId);
  const seatingFor = (layoutId: string) => {
    const room = roomByLayout(layoutId);
    return room ? { screenId: room.id, seatMapId: room.layoutId } : null;
  };

  const [form, setForm] = useState({ startsAt: '', endsAt: '', layoutId: GENERAL_ADMISSION });
  // Show times are typed and shown in the venue's zone, never the browser's. See lib/zoned-time.ts.
  const inputZone = venueInputZone(event?.venue);
  const venueTz = inputZone.known ? inputZone.zone : undefined;
  const timeZoneNote = inputZone.known
    ? `Venue time: ${zoneLabel(inputZone.zone)}`
    : `Your time zone (${inputZone.zone}) - set the venue's time zone to be sure`;

  const add = useMutation({
    mutationFn: () =>
      api.events.addSession(id, {
        startsAt: wallClockToInstant(form.startsAt, inputZone.zone).toISOString(),
        endsAt: wallClockToInstant(form.endsAt, inputZone.zone).toISOString(),
        // Omitted entirely when general admission — sending an empty string would be a room
        // id that does not exist, and the request would be refused rather than understood.
        ...(seatingFor(form.layoutId) ?? {}),
      }),
    onSuccess: (session) => {
      toast.push(
        session.screenId
          ? 'Session added. Ticket types were created from the space’s seat categories.'
          : 'Session added.',
        'success',
      );
      setForm({ startsAt: '', endsAt: '', layoutId: GENERAL_ADMISSION });
      qc.invalidateQueries({ queryKey: ['event', id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  // ── Changing an existing session's seating ──────────────────────────────────────
  const [editing, setEditing] = useState<EventSession | null>(null);
  // The same rule the Seating view states in full, said in two words here.
  const lockReason = (s: EventSession): string | null => {
    const seating = sessionSeating({ session: s, space: null, layout: null, now: Date.now() });
    if (seating.change.allowed) return null;
    const { sold, held } = seating.counts;
    if (sold > 0) return `${sold} sold`;
    if (held > 0) return `${held} held`;
    return s.status === 'CANCELLED' ? 'cancelled' : 'ended';
  };
  const columns: Column<EventSession>[] = [
    { key: 'start', header: 'Starts', render: (s) => dateTime(s.startsAt, undefined, venueTz) },
    { key: 'end', header: 'Ends', render: (s) => dateTime(s.endsAt, undefined, venueTz) },
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
                  {s.screen.venue?.name ?? s.screen.cinema?.name} · {s.screen.name}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-text-muted">General admission</span>
          )}
          {/*
            Offered only where the server would allow it. Past the first sale or hold the
            button would only fail, so the reason - and the way to the Seating view, which
            explains the layout version it is locked to - takes its place.
          */}
          {lockReason(s) ? (
            <Link
              href={`/organizer/events/${id}/seating`}
              className="block rounded text-caption text-text-muted underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Locked: {lockReason(s)}
            </Link>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(s);
              }}
              className="block rounded text-caption text-action-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Change
            </button>
          )}
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
    { key: 'tickets', header: 'Ticket types', render: (s) => s.ticketTypes?.length ?? 0 },
  ];

  const endBeforeStart =
    !!form.startsAt && !!form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt);
  const valid = !!form.startsAt && !!form.endsAt && !endBeforeStart;

  return (
    // `min-w-0` on the grid and its items: without it a grid item is as wide as its widest
    // content, and the table pushed the whole page sideways on a phone.
    <div className="grid min-w-0 gap-6 lg:grid-cols-3 [&>*]:min-w-0">
      <div className="min-w-0 lg:col-span-2">
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
            timeZoneLabel={timeZoneNote}
          />
          <DateTimeField
            id="e"
            label="Ends at"
            value={form.endsAt}
            relativeTo={form.startsAt}
            min={form.startsAt}
            onChange={(v) => setForm({ ...form, endsAt: v })}
            error={endBeforeStart ? 'End must be after start.' : undefined}
            timeZoneLabel={timeZoneNote}
          />

          <div>
            <Select
              id="room"
              label="Seating"
              value={form.layoutId}
              disabled={rooms.isLoading}
              onChange={(e) => setForm({ ...form, layoutId: e.target.value })}
            >
              <option value={GENERAL_ADMISSION}>General admission — no seat map</option>
              {(rooms.data ?? []).map((r) => (
                <option key={r.layoutId} value={r.layoutId}>
                  {roomOptionLabel(r)}
                </option>
              ))}
            </Select>
            <SeatingHelp
              rooms={rooms.data}
              chosen={roomByLayout(form.layoutId)}
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

      <ChangeSeatingDialog
        eventId={id}
        session={editing}
        rooms={rooms.data}
        roomsFailed={rooms.isError}
        roomsLoading={rooms.isLoading}
        whenLabel={editing ? dateTime(editing.startsAt, undefined, venueTz) : ''}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
