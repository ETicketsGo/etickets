'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Building2, CalendarDays, MapPin, ShieldCheck, Ticket, Share2 } from 'lucide-react';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { money, dateTime } from '@/lib/format';
import { Badge, Button, Card } from '@/components/ui';

export default function EventDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const { data: event, isLoading } = useQuery({
    queryKey: ['event', slug],
    queryFn: () => api.getEvent(slug),
  });

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState(false);

  const session = useMemo(
    () => event?.sessions.find((s) => s.id === sessionId) ?? event?.sessions[0],
    [event, sessionId],
  );

  const subtotal = useMemo(() => {
    if (!session) return 0;
    return session.ticketTypes.reduce((sum, t) => sum + (qty[t.id] ?? 0) * t.priceMinor, 0);
  }, [session, qty]);

  const totalQty = Object.values(qty).reduce((a, b) => a + b, 0);

  const book = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error('No session selected');
      if (!tokenStore.access) {
        router.push('/login?next=/events/' + slug);
        throw new Error('login');
      }
      const me = await api.me();
      return api.createBooking({
        eventSessionId: session.id,
        items: session.ticketTypes
          .filter((t) => (qty[t.id] ?? 0) > 0)
          .map((t) => ({ ticketTypeId: t.id, quantity: qty[t.id] })),
        buyerName: me.fullName,
        buyerEmail: me.email,
      });
    },
    onSuccess: (booking) => router.push(`/booking/${booking.id}/payment`),
    onError: (e) => {
      if (e instanceof ApiRequestError) setError(e.message);
      else if ((e as Error).message !== 'login') setError('Could not create booking.');
    },
  });

  const share = async () => {
    const url = typeof window !== 'undefined' ? window.location.href : '';
    if (navigator.share) {
      await navigator.share({ title: event?.title, url }).catch(() => undefined);
    } else {
      await navigator.clipboard.writeText(url).catch(() => undefined);
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    }
  };

  if (isLoading) return <div className="h-96 animate-pulse rounded-lg bg-background-subtle" />;
  if (!event) return <p>Event not found.</p>;

  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-lg border border-border shadow-sm">
        <div className="flex h-52 items-end bg-gradient-to-br from-action-primary/25 via-action-primary/10 to-background-subtle p-6 sm:h-64">
          <div className="relative z-10">
            <Badge tone="info">{event.category}</Badge>
            <h1 className="mt-3 text-h2 font-bold tracking-tight text-text-primary sm:text-h1">
              {event.title}
            </h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.9375rem] text-text-secondary">
              <span className="flex items-center gap-1.5">
                <MapPin className="h-4 w-4" />
                {event.venue.name}, {event.venue.city}
              </span>
              <span className="flex items-center gap-1.5">
                <Building2 className="h-4 w-4" />
                {event.organizer.name}
              </span>
            </p>
          </div>
          <button
            onClick={share}
            className="absolute right-4 top-4 flex items-center gap-1.5 rounded-full bg-background-surface/90 px-3 py-1.5 text-caption font-medium text-text-secondary shadow-sm backdrop-blur transition-colors hover:text-text-primary"
          >
            <Share2 className="h-3.5 w-3.5" />
            {shared ? 'Copied!' : 'Share'}
          </button>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-6 lg:col-span-2">
          {event.description && (
            <Card title="About this event">
              <p className="whitespace-pre-line leading-relaxed text-text-secondary">
                {event.description}
              </p>
            </Card>
          )}

          <Card title="Sessions">
            <div className="space-y-2">
              {event.sessions.map((s) => {
                const active = session?.id === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => {
                      setSessionId(s.id);
                      setQty({});
                    }}
                    className={`flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-all ${
                      active
                        ? 'border-action-primary bg-action-primary/5 ring-1 ring-action-primary/30'
                        : 'border-border hover:border-border-strong hover:bg-background-subtle'
                    }`}
                  >
                    <CalendarDays
                      className={`h-5 w-5 ${active ? 'text-action-primary' : 'text-text-muted'}`}
                    />
                    <span
                      className={`text-[0.9375rem] font-medium ${active ? 'text-action-primary' : 'text-text-primary'}`}
                    >
                      {dateTime(s.startsAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          <div className="grid gap-6 sm:grid-cols-2">
            <Card title="Venue">
              <p className="font-medium text-text-primary">{event.venue.name}</p>
              <p className="mt-1 text-[0.9375rem] text-text-muted">
                {event.venue.address ? `${event.venue.address}, ` : ''}
                {event.venue.city}, {event.venue.country}
              </p>
            </Card>
            <Card title="Organizer">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-action-primary/10 font-semibold text-action-primary">
                  {event.organizer.name.charAt(0)}
                </div>
                <p className="font-medium text-text-primary">{event.organizer.name}</p>
              </div>
            </Card>
          </div>

          {event.refundPolicy && (
            <Card>
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-status-success" />
                <div>
                  <h3 className="font-semibold text-text-primary">Refund policy</h3>
                  <p className="mt-1 text-[0.9375rem] text-text-muted">{event.refundPolicy}</p>
                </div>
              </div>
            </Card>
          )}
        </div>

        {/* Sticky booking card */}
        <div className="lg:sticky lg:top-24 lg:h-fit">
          <Card>
            <div className="mb-4 flex items-center gap-2">
              <Ticket className="h-5 w-5 text-action-primary" />
              <h2 className="text-title font-semibold text-text-primary">Select tickets</h2>
            </div>
            <div className="space-y-3">
              {session?.ticketTypes.map((t) => {
                const soldOut = t.available <= 0;
                return (
                  <div
                    key={t.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
                  >
                    <div>
                      <p className="font-medium text-text-primary">{t.name}</p>
                      <p className="text-caption text-text-muted">
                        {money(t.priceMinor, t.currency)} ·{' '}
                        {soldOut ? (
                          <span className="text-status-error">Sold out</span>
                        ) : (
                          `${t.available} left`
                        )}
                      </p>
                    </div>
                    <select
                      aria-label={`Quantity of ${t.name}`}
                      disabled={soldOut}
                      value={qty[t.id] ?? 0}
                      onChange={(e) => setQty((p) => ({ ...p, [t.id]: Number(e.target.value) }))}
                      className="w-16 cursor-pointer rounded-md border border-border bg-background-surface px-2 py-1.5 text-center text-[0.9375rem] text-text-primary focus:border-ring focus:outline-none focus:ring-4 focus:ring-ring/15 disabled:opacity-50"
                    >
                      {Array.from({ length: Math.min(t.maxPerOrder, t.available) + 1 }).map(
                        (_, n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <span className="text-[0.9375rem] text-text-secondary">Subtotal</span>
                <span className="text-title font-bold text-text-primary">{money(subtotal)}</span>
              </div>
              <p className="mt-1 text-caption text-text-muted">
                Transparent fees shown on the next step.
              </p>
            </div>

            {error && (
              <p role="alert" className="mt-3 text-caption text-status-error">
                {error}
              </p>
            )}
            <Button
              className="mt-4 w-full"
              loading={book.isPending}
              disabled={totalQty === 0 || book.isPending}
              onClick={() => {
                setError(null);
                book.mutate();
              }}
            >
              {book.isPending ? 'Holding tickets…' : 'Continue to payment'}
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
}
