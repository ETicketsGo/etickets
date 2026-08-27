'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Building2,
  CalendarDays,
  ChevronRight,
  MapPin,
  ShieldCheck,
  Ticket,
  Share2,
} from 'lucide-react';
import { RatingStars, useToast, errorMessage } from '@eticketsgo/web-kit';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { money, dateTime } from '@/lib/format';
import { pushRecent } from '@/lib/recent';
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton, Textarea } from '@/components/ui';
import { EventCard } from '@/components/event-card';
import { nextStepAfterBooking } from '@/lib/after-booking';

export default function EventDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const {
    data: event,
    isLoading,
    isError,
    error: eventError,
    refetch,
  } = useQuery({
    queryKey: ['event', slug],
    queryFn: () => api.getEvent(slug),
  });

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState(false);

  // Reviews
  const qc = useQueryClient();
  const toast = useToast();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const authed = typeof window !== 'undefined' && !!tokenStore.access;

  const reviews = useQuery({
    queryKey: ['reviews', event?.id],
    queryFn: () => api.reviewsForEvent(event!.id),
    enabled: !!event,
  });
  const mine = useQuery({
    queryKey: ['my-review', event?.id],
    queryFn: () => api.myReview(event!.id),
    enabled: !!event && authed,
  });

  // "You might also like" — read-only recommendations seeded by this event.
  const recommendations = useQuery({
    queryKey: ['recommendations', event?.id],
    queryFn: () => api.recommendations({ eventId: event!.id, limit: 4 }),
    enabled: !!event,
  });
  useEffect(() => {
    if (mine.data) {
      setRating(mine.data.rating);
      setComment(mine.data.comment ?? '');
    }
  }, [mine.data]);

  const submitReview = useMutation({
    mutationFn: () =>
      api.createReview({ eventId: event!.id, rating, comment: comment || undefined }),
    onSuccess: () => {
      toast.push('Thanks for your review!', 'success');
      qc.invalidateQueries({ queryKey: ['reviews', event?.id] });
      qc.invalidateQueries({ queryKey: ['my-review', event?.id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const session = useMemo(
    () => event?.sessions.find((s) => s.id === sessionId) ?? event?.sessions[0],
    [event, sessionId],
  );

  // Experience Commerce (v1.3): add-ons + bundles for this event.
  const [addOnQty, setAddOnQty] = useState<Record<string, number>>({});
  const [bundleQty, setBundleQty] = useState<Record<string, number>>({});
  const addOnsQ = useQuery({
    queryKey: ['public-addons', event?.id],
    queryFn: () => api.publicAddOns(event!.id),
    enabled: !!event,
  });
  const bundlesQ = useQuery({
    queryKey: ['public-bundles', event?.id],
    queryFn: () => api.publicBundles(event!.id),
    enabled: !!event,
  });
  const addOns = addOnsQ.data ?? [];
  const bundles = bundlesQ.data ?? [];

  const ticketSubtotal = useMemo(() => {
    if (!session) return 0;
    return session.ticketTypes.reduce((sum, t) => sum + (qty[t.id] ?? 0) * t.priceMinor, 0);
  }, [session, qty]);
  const addOnSubtotal = addOns.reduce((s, a) => s + (addOnQty[a.id] ?? 0) * a.priceMinor, 0);
  const bundleSubtotal = bundles.reduce((s, b) => s + (bundleQty[b.id] ?? 0) * b.priceFromMinor, 0);
  const subtotal = ticketSubtotal + addOnSubtotal + bundleSubtotal;

  const totalQty =
    Object.values(qty).reduce((a, b) => a + b, 0) +
    Object.values(addOnQty).reduce((a, b) => a + b, 0) +
    Object.values(bundleQty).reduce((a, b) => a + b, 0);

  // Track for "Recently viewed" and restore any saved ticket selection.
  useEffect(() => {
    if (!event) return;
    pushRecent({
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
    });
    try {
      const saved = JSON.parse(localStorage.getItem(`etg_sel_${slug}`) ?? 'null') as {
        sessionId: string;
        qty: Record<string, number>;
      } | null;
      if (saved && event.sessions.some((s) => s.id === saved.sessionId)) {
        setSessionId(saved.sessionId);
        setQty(saved.qty);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);

  // Auto-save the current selection so returning restores it.
  useEffect(() => {
    if (!session) return;
    try {
      localStorage.setItem(`etg_sel_${slug}`, JSON.stringify({ sessionId: session.id, qty }));
    } catch {
      /* ignore */
    }
  }, [session, qty, slug]);

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
        addOns: addOns
          .filter((a) => (addOnQty[a.id] ?? 0) > 0)
          .map((a) => ({ addOnId: a.id, quantity: addOnQty[a.id] })),
        bundles: bundles
          .filter((b) => (bundleQty[b.id] ?? 0) > 0)
          .map((b) => ({ bundleId: b.id, quantity: bundleQty[b.id] })),
        buyerName: me.fullName,
        buyerEmail: me.email,
      });
    },
    onSuccess: (booking) => router.push(nextStepAfterBooking(booking)),
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
  if (isError) {
    const notFound = eventError instanceof ApiRequestError && eventError.code === 'NOT_FOUND';
    return notFound ? (
      <EmptyState
        title="Event not found"
        hint="This event may have ended or been removed."
        icon={CalendarDays}
      />
    ) : (
      <ErrorState
        message="We couldn't load this event. Please try again."
        onRetry={() => refetch()}
      />
    );
  }
  if (!event)
    return (
      <EmptyState
        title="Event not found"
        hint="This event may have ended or been removed."
        icon={CalendarDays}
      />
    );

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
              {/* Map placeholder — an interactive map is not yet wired to a provider. */}
              <div
                aria-hidden
                className="mt-3 flex h-28 items-center justify-center rounded-lg border border-dashed border-border bg-background-subtle text-text-muted"
              >
                <MapPin className="mr-1.5 h-4 w-4" />
                <span className="text-caption">Map preview</span>
              </div>
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                  `${event.venue.name}, ${event.venue.address ?? ''} ${event.venue.city} ${event.venue.country}`,
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-caption font-medium text-action-primary hover:underline"
              >
                <MapPin className="h-3.5 w-3.5" /> Get directions
              </a>
            </Card>
            <Card title="Organizer">
              <Link
                href={`/organizers/${event.organizer.id}`}
                className="group flex items-center gap-3"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-action-primary/10 font-semibold text-action-primary">
                  {event.organizer.name.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-text-primary group-hover:text-action-primary">
                    {event.organizer.name}
                  </p>
                  <p className="text-caption text-text-muted">View profile</p>
                </div>
                <ChevronRight className="h-4 w-4 text-text-muted transition-transform group-hover:translate-x-0.5" />
              </Link>
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

          {/* Reviews */}
          <Card title="Ratings & reviews">
            {reviews.isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-40" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : reviews.data && reviews.data.count > 0 ? (
              <div className="space-y-5">
                <div className="flex items-center gap-4">
                  <div className="text-center">
                    <p className="text-h2 font-bold tracking-tight text-text-primary">
                      {reviews.data.average.toFixed(1)}
                    </p>
                    <RatingStars value={Math.round(reviews.data.average)} size="sm" />
                    <p className="mt-1 text-caption text-text-muted">
                      {reviews.data.count} review{reviews.data.count > 1 ? 's' : ''}
                    </p>
                  </div>
                  <div className="flex-1 space-y-1">
                    {[5, 4, 3, 2, 1].map((star) => {
                      const c = reviews.data!.distribution[String(star)] ?? 0;
                      const pct = reviews.data!.count
                        ? Math.round((c / reviews.data!.count) * 100)
                        : 0;
                      return (
                        <div key={star} className="flex items-center gap-2 text-caption">
                          <span className="w-3 text-text-muted">{star}</span>
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-background-subtle">
                            <div
                              className="h-full rounded-full bg-status-warning"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <ul className="divide-y divide-border">
                  {reviews.data.items.map((r) => (
                    <li key={r.id} className="py-3">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-text-primary">{r.author}</span>
                        <RatingStars value={r.rating} size="sm" />
                      </div>
                      {r.comment && (
                        <p className="mt-1 text-[0.9375rem] text-text-secondary">{r.comment}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-[0.9375rem] text-text-muted">
                No reviews yet — be the first to share your experience.
              </p>
            )}

            {/* Write a review */}
            {authed && (
              <div className="mt-5 rounded-lg border border-border bg-background-subtle/50 p-4">
                <p className="font-medium text-text-primary">
                  {mine.data ? 'Update your review' : 'Write a review'}
                </p>
                <div className="mt-2">
                  <RatingStars value={rating} onChange={setRating} size="lg" />
                </div>
                <Textarea
                  id="review-comment"
                  aria-label="Your review"
                  className="mt-3"
                  rows={3}
                  placeholder="Share how the event went…"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <Button
                  className="mt-3"
                  loading={submitReview.isPending}
                  disabled={rating < 1}
                  onClick={() => submitReview.mutate()}
                >
                  {mine.data ? 'Update review' : 'Submit review'}
                </Button>
                <p className="mt-2 text-caption text-text-muted">
                  Only attendees with a confirmed booking can review.
                </p>
              </div>
            )}
          </Card>

          {/* FAQ */}
          <Card title="Frequently asked questions">
            <div className="divide-y divide-border">
              {[
                {
                  q: 'How do I receive my ticket?',
                  a: 'Instantly after payment. Your QR ticket appears in “My tickets” and can be added to your calendar.',
                },
                {
                  q: 'Can I get a refund?',
                  a:
                    event.refundPolicy ??
                    'Refunds follow the organizer’s policy. Request one from your booking within the eligible window.',
                },
                {
                  q: 'Do I need to print my ticket?',
                  a: 'No — just show the QR code on your phone at the gate for check-in.',
                },
                {
                  q: 'Can I transfer my ticket?',
                  a: 'Ticket transfers are handled by the organizer. Contact them for details.',
                },
              ].map((f) => (
                <details key={f.q} className="group py-3">
                  <summary className="flex cursor-pointer list-none items-center justify-between font-medium text-text-primary">
                    {f.q}
                    <ChevronRight className="h-4 w-4 text-text-muted transition-transform group-open:rotate-90" />
                  </summary>
                  <p className="mt-2 text-[0.9375rem] text-text-secondary">{f.a}</p>
                </details>
              ))}
            </div>
          </Card>
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
                        {/*
                          "Free" rather than "₹0.00". A zero with a currency symbol reads as a
                          price that failed to load, and it is the one thing about this event a
                          buyer most wants confirmed before they commit to a seat.
                        */}
                        {event.isFree ? 'Free' : money(t.priceMinor, t.currency)} ·{' '}
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

            {/* Upsell: add-ons (v1.3) */}
            {addOns.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-text-muted">
                  Enhance your experience
                </p>
                <div className="space-y-2">
                  {addOns.map((a) => {
                    const max =
                      a.remaining === null ? a.maxPerOrder : Math.min(a.maxPerOrder, a.remaining);
                    return (
                      <div
                        key={a.id}
                        className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium text-text-primary">{a.name}</p>
                          <p className="text-caption text-text-muted">
                            {money(a.priceMinor, a.currency)}
                            {a.soldOut && <span className="text-status-error"> · Sold out</span>}
                          </p>
                        </div>
                        <select
                          aria-label={`Quantity of ${a.name}`}
                          disabled={a.soldOut}
                          value={addOnQty[a.id] ?? 0}
                          onChange={(e) =>
                            setAddOnQty((p) => ({ ...p, [a.id]: Number(e.target.value) }))
                          }
                          className="w-16 cursor-pointer rounded-md border border-border bg-background-surface px-2 py-1.5 text-center text-[0.9375rem] text-text-primary focus:border-ring focus:outline-none focus:ring-4 focus:ring-ring/15 disabled:opacity-50"
                        >
                          {Array.from({ length: Math.max(0, max) + 1 }).map((_, n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Cross-sell: bundles (v1.3) */}
            {bundles.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-text-muted">
                  Bundles &amp; deals
                </p>
                <div className="space-y-2">
                  {bundles.map((b) => (
                    <div key={b.id} className="rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-text-primary">{b.name}</p>
                          <p className="text-caption text-text-muted">
                            {money(b.priceFromMinor, b.currency)}
                            {b.savingsMinor > 0 && (
                              <span className="text-status-success">
                                {' '}
                                · save {money(b.savingsMinor, b.currency)}
                              </span>
                            )}
                          </p>
                        </div>
                        <select
                          aria-label={`Quantity of ${b.name}`}
                          value={bundleQty[b.id] ?? 0}
                          onChange={(e) =>
                            setBundleQty((p) => ({ ...p, [b.id]: Number(e.target.value) }))
                          }
                          className="w-16 cursor-pointer rounded-md border border-border bg-background-surface px-2 py-1.5 text-center text-[0.9375rem] text-text-primary focus:border-ring focus:outline-none focus:ring-4 focus:ring-ring/15"
                        >
                          {Array.from({ length: b.maxPerOrder + 1 }).map((_, n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </div>
                      {b.components.length > 0 && (
                        <p className="mt-1.5 text-caption text-text-muted">
                          Includes {b.components.map((c) => `${c.quantity}× ${c.label}`).join(', ')}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <span className="text-[0.9375rem] text-text-secondary">Subtotal</span>
                <span className="text-title font-bold text-text-primary">
                  {event.isFree ? 'Free' : money(subtotal)}
                </span>
              </div>
              <p className="mt-1 text-caption text-text-muted">
                {event.isFree
                  ? 'No payment needed — your tickets are issued as soon as you book.'
                  : 'Transparent fees shown on the next step.'}
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
              {book.isPending
                ? 'Holding tickets…'
                : event.isFree
                  ? 'Get my tickets'
                  : 'Continue to payment'}
            </Button>
          </Card>
        </div>
      </div>

      {/* You might also like — recommendations seeded by this event. */}
      {recommendations.isLoading ? (
        <section className="space-y-4">
          <h2 className="text-title font-semibold text-text-primary">You might also like</h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-64 w-full rounded-lg" />
            ))}
          </div>
        </section>
      ) : recommendations.data && recommendations.data.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-title font-semibold text-text-primary">You might also like</h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {recommendations.data.map((rec) => (
              <EventCard key={rec.id} event={rec} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
