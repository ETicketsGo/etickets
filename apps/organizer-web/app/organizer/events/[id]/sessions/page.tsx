'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
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

/** The value of the room <select> meaning "no room". Empty string, so it is also falsy. */
const GENERAL_ADMISSION = '';

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
    rule the create call enforces, and two copies of it drift. An empty list is a real answer
    and is shown as one: the organizer has no room with a seat map yet, and the fix is to
    draw one, not to keep looking for a dropdown.
  */
  const rooms = useQuery({
    queryKey: ['seating-rooms', event?.organizationId],
    queryFn: () => api.events.seatingRooms(event!.organizationId),
    enabled: !!event?.organizationId,
  });

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
      render: (s) =>
        s.screenId ? (
          <span className="text-text-primary">
            Reserved seating
            {s.screen ? (
              <span className="block text-caption text-text-muted">
                {s.screen.cinema.name} · {s.screen.name}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-text-muted">General admission</span>
        ),
    },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
    { key: 'tickets', header: 'Ticket types', render: (s) => s.ticketTypes?.length ?? 0 },
  ];

  const endBeforeStart =
    !!form.startsAt && !!form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt);
  const valid = !!form.startsAt && !!form.endsAt && !endBeforeStart;
  const chosen = rooms.data?.find((r) => r.id === form.screenId);

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
            <p className="mt-1.5 text-caption text-text-muted">
              {rooms.isError
                ? "We couldn't load your rooms, so only general admission is available here."
                : chosen
                  ? `Buyers pick a named seat from ${chosen.layoutName ?? 'this room’s'} layout. A ticket type is created for each seat category, priced from it.`
                  : rooms.data?.length === 0
                    ? 'Buyers choose how many tickets they want. To sell numbered seats, draw and publish a seat map for a room first.'
                    : 'Buyers choose how many tickets they want. Pick a room to sell numbered seats instead.'}
            </p>
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
    </div>
  );
}
