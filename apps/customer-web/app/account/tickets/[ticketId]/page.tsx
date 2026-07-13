'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CalendarPlus,
  CloudSun,
  Heart,
  MapPin,
  Navigation,
  ParkingCircle,
  Share2,
} from 'lucide-react';
import {
  buildIcsDataUrl,
  googleMapsUrl,
  googleDirectionsUrl,
  gradientFor,
  useCountdown,
} from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { isSaved, toggleSaved } from '@/lib/saved';
import { Badge, Skeleton, StatusBadge } from '@/components/ui';

export default function TicketDetailPage() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const router = useRouter();
  const [shared, setShared] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!tokenStore.access) router.push(`/login?next=/account/tickets/${ticketId}`);
  }, [router, ticketId]);

  const ticketQ = useQuery({
    queryKey: ['ticket', ticketId],
    queryFn: () => api.getTicket(ticketId),
    enabled: typeof window !== 'undefined' && !!tokenStore.access,
  });
  const ticket = ticketQ.data;

  // Full event (venue, refund policy, organizer) for directions + context.
  const eventQ = useQuery({
    queryKey: ['event', ticket?.event.slug],
    queryFn: () => api.getEvent(ticket!.event.slug),
    enabled: !!ticket,
  });
  const event = eventQ.data;

  const countdown = useCountdown(ticket?.startsAt);

  useEffect(() => {
    if (event) setSaved(isSaved(event.id));
  }, [event]);

  const toggleSave = () => {
    if (!event) return;
    setSaved(
      toggleSaved({
        id: event.id,
        title: event.title,
        slug: event.slug,
        category: event.category,
        venue: {
          name: event.venue.name,
          city: event.venue.city,
          country: event.venue.country,
        },
        organizer: event.organizer.name,
        nextSessionAt: event.sessions[0]?.startsAt ?? null,
        fromPriceMinor: event.sessions[0]?.ticketTypes[0]?.priceMinor ?? null,
        currency: event.sessions[0]?.ticketTypes[0]?.currency ?? 'INR',
      }),
    );
  };

  const share = async () => {
    const url = typeof window !== 'undefined' ? window.location.href : '';
    if (navigator.share) {
      await navigator.share({ title: ticket?.event.title, url }).catch(() => undefined);
    } else {
      await navigator.clipboard.writeText(url).catch(() => undefined);
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    }
  };

  if (ticketQ.isLoading || !ticket) return <Skeleton className="h-96 w-full" />;

  const venueName = event?.venue.name ?? '';
  const venueLine = event
    ? `${event.venue.address ? `${event.venue.address}, ` : ''}${event.venue.city}, ${event.venue.country}`
    : '';
  const mapsQuery = event ? `${event.venue.name}, ${event.venue.city}` : ticket.event.title;

  const ics = buildIcsDataUrl({
    title: ticket.event.title,
    location: venueName ? `${venueName}, ${event?.venue.city}` : undefined,
    description: `Your ETicketsGo ticket ${ticket.serial}`,
    start: ticket.startsAt,
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <button
        onClick={() => router.push('/account/tickets')}
        className="flex items-center gap-1.5 text-[0.9375rem] text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeft className="h-4 w-4" /> All tickets
      </button>

      {/* Artwork + countdown */}
      <div className="overflow-hidden rounded-lg border border-border shadow-sm">
        <div
          className={`relative flex h-44 items-end bg-gradient-to-br p-6 ${gradientFor(ticket.id)}`}
        >
          <div>
            <Badge tone="info">{event?.category ?? 'Event'}</Badge>
            <h1 className="mt-2 text-h3 font-bold tracking-tight text-text-primary">
              {ticket.event.title}
            </h1>
            <p className="mt-1 flex items-center gap-1.5 text-[0.9375rem] text-text-secondary">
              <MapPin className="h-4 w-4" /> {venueName || 'Venue TBA'}
            </p>
          </div>
          <div className="absolute right-4 top-4 flex gap-2">
            <button
              onClick={toggleSave}
              aria-label={saved ? 'Remove favourite' : 'Favourite event'}
              aria-pressed={saved}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-background-surface/90 text-text-secondary shadow-sm backdrop-blur transition-colors hover:text-status-error"
            >
              <Heart className={`h-4 w-4 ${saved ? 'fill-status-error text-status-error' : ''}`} />
            </button>
            <button
              onClick={share}
              aria-label="Share"
              className="flex h-9 items-center gap-1.5 rounded-full bg-background-surface/90 px-3 text-caption font-medium text-text-secondary shadow-sm backdrop-blur transition-colors hover:text-text-primary"
            >
              <Share2 className="h-3.5 w-3.5" /> {shared ? 'Copied!' : 'Share'}
            </button>
          </div>
        </div>
        <div className="border-t border-border bg-background-surface px-6 py-4">
          {countdown.isPast ? (
            <p className="text-[0.9375rem] font-medium text-text-muted">
              This event has taken place.
            </p>
          ) : (
            <div className="flex items-center gap-4">
              <span className="text-caption uppercase tracking-wide text-text-muted">
                Starts in
              </span>
              <div className="flex gap-3 tabular-nums">
                {[
                  { v: countdown.days, l: 'days' },
                  { v: countdown.hours, l: 'hrs' },
                  { v: countdown.minutes, l: 'min' },
                  { v: countdown.seconds, l: 'sec' },
                ].map((u) => (
                  <div key={u.l} className="text-center">
                    <span className="block text-title font-bold text-text-primary">
                      {String(u.v).padStart(2, '0')}
                    </span>
                    <span className="text-caption text-text-muted">{u.l}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* QR pass */}
      <div className="rounded-lg border border-border bg-background-surface p-6 text-center shadow-sm">
        <div className="mx-auto flex w-fit items-center justify-center">
          <span className="relative">
            <span
              className="absolute inset-0 -m-2 animate-pulse rounded-2xl bg-action-primary/10"
              aria-hidden
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={ticket.qrDataUrl}
              alt={`QR code for ticket ${ticket.serial}`}
              className="relative h-52 w-52 rounded-2xl bg-white p-2"
            />
          </span>
        </div>
        <div className="mt-4 flex items-center justify-center gap-2">
          <StatusBadge status={ticket.status} />
          <span className="font-mono text-caption text-text-muted">{ticket.serial}</span>
        </div>
        <p className="mt-1 text-[0.9375rem] text-text-secondary">{dateTime(ticket.startsAt)}</p>
        {ticket.holderName && (
          <p className="text-caption text-text-muted">Holder: {ticket.holderName}</p>
        )}
      </div>

      {/* Actions */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <a
          href={ics}
          download={`${ticket.event.slug}.ics`}
          className="flex items-center justify-center gap-2 rounded-md border border-border bg-background-surface px-4 py-3 text-[0.9375rem] font-medium text-text-primary shadow-sm transition-colors hover:bg-background-subtle"
        >
          <CalendarPlus className="h-4 w-4" /> Add to calendar
        </a>
        <a
          href={googleDirectionsUrl(mapsQuery)}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-2 rounded-md border border-border bg-background-surface px-4 py-3 text-[0.9375rem] font-medium text-text-primary shadow-sm transition-colors hover:bg-background-subtle"
        >
          <Navigation className="h-4 w-4" /> Directions
        </a>
        <a
          href={googleMapsUrl(mapsQuery)}
          target="_blank"
          rel="noreferrer"
          className="col-span-2 flex items-center justify-center gap-2 rounded-md border border-border bg-background-surface px-4 py-3 text-[0.9375rem] font-medium text-text-primary shadow-sm transition-colors hover:bg-background-subtle sm:col-span-1"
        >
          <MapPin className="h-4 w-4" /> View venue
        </a>
      </div>

      {/* Venue + placeholders */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-background-surface p-4 shadow-sm sm:col-span-3">
          <p className="font-semibold text-text-primary">{venueName || 'Venue'}</p>
          <p className="mt-1 text-[0.9375rem] text-text-muted">
            {venueLine || 'Details to follow.'}
          </p>
        </div>
        <Placeholder icon={CloudSun} title="Weather" note="Forecast appears closer to the event." />
        <Placeholder
          icon={ParkingCircle}
          title="Parking"
          note="Check with the venue for parking."
        />
        <Placeholder icon={Navigation} title="Getting there" note="Directions available above." />
      </div>

      {/* Status timeline */}
      <div className="rounded-lg border border-border bg-background-surface p-5 shadow-sm">
        <h2 className="mb-4 text-title font-semibold text-text-primary">Ticket status</h2>
        <Timeline status={ticket.status} />
      </div>
    </div>
  );
}

function Placeholder({
  icon: Icon,
  title,
  note,
}: {
  icon: typeof CloudSun;
  title: string;
  note: string;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border p-4">
      <div className="flex items-center gap-2 text-text-secondary">
        <Icon className="h-4 w-4" />
        <p className="text-[0.9375rem] font-medium text-text-primary">{title}</p>
      </div>
      <p className="mt-1 text-caption text-text-muted">{note}</p>
    </div>
  );
}

function Timeline({ status }: { status: string }) {
  const refunded = status === 'REFUNDED' || status === 'CANCELLED' || status === 'VOID';
  const steps = [
    { key: 'ISSUED', label: 'Ticket issued', done: true },
    {
      key: 'ACTIVE',
      label: refunded ? 'Cancelled' : 'Ready to use',
      done: status === 'ACTIVE' || status === 'CHECKED_IN' || refunded,
      tone: refunded ? ('error' as const) : ('success' as const),
    },
    {
      key: 'CHECKED_IN',
      label: 'Checked in',
      done: status === 'CHECKED_IN',
      tone: 'info' as const,
    },
  ];
  return (
    <ol className="space-y-4">
      {steps.map((s, i) => (
        <li key={s.key} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-caption ${
                s.done
                  ? 'bg-action-primary text-action-primary-foreground'
                  : 'bg-background-subtle text-text-muted'
              }`}
            >
              {s.done ? '✓' : i + 1}
            </span>
            {i < steps.length - 1 && <span className="my-1 h-6 w-px bg-border" />}
          </div>
          <span
            className={`pt-0.5 text-[0.9375rem] ${s.done ? 'text-text-primary' : 'text-text-muted'}`}
          >
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
