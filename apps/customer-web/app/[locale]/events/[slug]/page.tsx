'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  Building2,
  CalendarDays,
  MapPin,
  ShieldCheck,
  Ticket,
  Share2,
  ChevronLeft,
  ChevronRight,
  Images,
} from 'lucide-react';
import { ImageLightbox } from '@/components/image-lightbox';
import { RatingStars, apiAssetUrl, useToast, errorMessage } from '@eticketsgo/web-kit';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { money, dateTime, zoneAbbrev } from '@/lib/format';
import { pushRecent } from '@/lib/recent';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { EventCard } from '@/components/event-card';
import { PriceBreakdown } from '@/components/price-breakdown';
import { nextStepAfterBooking } from '@/lib/after-booking';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { BuyerRegionField, useAuthUser } from '@eticketsgo/web-kit';

export default function EventDetailPage() {
  // `tx` is the shared vocabulary (Free, Sold out); `sf` is storefront copy.
  const tx = useTranslations('common');
  const sf = useTranslations('storefront');
  const b = useTranslations('storefront.booking');
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
  /* Which of the event's images the hero shows. The cover (0) until the buyer picks another. */
  const [activeImage, setActiveImage] = useState(0);
  /* Which image is open full screen, or null. */
  const [lightbox, setLightbox] = useState<number | null>(null);
  /*
    Optional, only rendered for Indian venues, and PREFILLED from the last answer.

    It used to start empty every time, so a returning customer was asked the same optional
    question on every purchase — a form that is not paying attention. `lastBuyerRegion` comes
    back with the profile; `touched` stops a late-arriving profile overwriting a choice the
    customer has already made on this screen. See BuyerRegionField.
  */
  const { user } = useAuthUser();
  const [buyerRegion, setBuyerRegion] = useState('');
  const [regionTouched, setRegionTouched] = useState(false);
  useEffect(() => {
    if (!regionTouched && !buyerRegion && user?.lastBuyerRegion) {
      setBuyerRegion(user.lastBuyerRegion);
    }
  }, [user?.lastBuyerRegion, regionTouched, buyerRegion]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  /*
    Which button was pressed, read by the mutation. Kept out of the request body until
    then so a stale value can never turn an online purchase into a reservation.
  */
  const [payWithCash, setPayWithCash] = useState(false);
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
      toast.push(sf('event.reviewThanks'), 'success');
      qc.invalidateQueries({ queryKey: ['reviews', event?.id] });
      qc.invalidateQueries({ queryKey: ['my-review', event?.id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  /*
    The chosen session, or else the first one still to come.

    This fell back to `sessions[0]` while the API sent every session the event ever had, so on
    QA the page opened on a date already past, priced it, and let the buyer press "Continue to
    payment" into a 409. The API now sends only dates that are still on; this also skips any
    that have started since, for a page left open or served from cache.
  */
  const session = useMemo(
    () =>
      event?.sessions.find((s) => s.id === sessionId) ??
      event?.sessions.find((s) => new Date(s.startsAt).getTime() > Date.now()),
    [event, sessionId],
  );
  // Whichever way a session came to be selected, one that has started is not for sale.
  const sessionStarted = session ? new Date(session.startsAt).getTime() <= Date.now() : false;

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
  /*
    Stable identities, so the memos below them are worth having.

    `addOnsQ.data ?? []` produces a fresh array on every render, which propagated into the
    quote's dependencies and made them recompute each time. React Query hashes its key
    structurally so this never became a refetch loop — but a memo whose dependencies always
    change is a memo that does nothing, and the next person to add a real identity-sensitive
    dependency here would get the loop for free.
  */
  const addOns = useMemo(() => addOnsQ.data ?? [], [addOnsQ.data]);
  const bundles = useMemo(() => bundlesQ.data ?? [], [bundlesQ.data]);

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

  /*
    The real price of this cart, from the server.

    This card used to show the ticket subtotal and the line "Transparent fees shown on the
    next step" — an apology for advertising a number that is not what the buyer pays. On QA
    the gap was ₹998 shown against ₹1,033.26 charged: a booking fee and a payment fee that
    only appeared after they had committed.

    Quoted rather than computed here. Fee tiers and tax are per-order and live on the
    server; a second implementation on the client would be right until the day it was not,
    and the customer would be the one to find out. `/bookings/quote` prices the cart with
    the same code the booking uses, holds nothing and redeems nothing.
  */
  const quoteItems = useMemo(
    () =>
      (session?.ticketTypes ?? [])
        .filter((t) => (qty[t.id] ?? 0) > 0)
        .map((t) => ({ ticketTypeId: t.id, quantity: qty[t.id] })),
    [session, qty],
  );
  const quoteAddOns = useMemo(
    () =>
      addOns
        .filter((a) => (addOnQty[a.id] ?? 0) > 0)
        .map((a) => ({ addOnId: a.id, quantity: addOnQty[a.id] })),
    [addOns, addOnQty],
  );
  const quoteBundles = useMemo(
    () =>
      bundles
        .filter((b) => (bundleQty[b.id] ?? 0) > 0)
        .map((b) => ({ bundleId: b.id, quantity: bundleQty[b.id] })),
    [bundles, bundleQty],
  );
  const quoteQ = useQuery({
    // buyerRegion is part of the key: it can change the tax SPLIT on the fee, so a quote
    // taken before the buyer chose their state is a different quote.
    queryKey: ['quote', session?.id, quoteItems, quoteAddOns, quoteBundles, buyerRegion],
    queryFn: () =>
      api.quoteBooking({
        eventSessionId: session!.id,
        items: quoteItems,
        ...(quoteAddOns.length ? { addOns: quoteAddOns } : {}),
        ...(quoteBundles.length ? { bundles: quoteBundles } : {}),
        ...(buyerRegion ? { buyerRegion } : {}),
      }),
    // A free event has no fees to quote, and a seated one is priced on the seat map.
    enabled:
      Boolean(session) &&
      !sessionStarted &&
      !session?.seatBased &&
      !event?.isFree &&
      quoteItems.length + quoteAddOns.length + quoteBundles.length > 0,
    // A stale price is worse than a brief spinner: this is the number they are agreeing to.
    staleTime: 0,
  });

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
        // So the "Recently viewed" card shows the date at the venue, like every other card.
        timezone: event.venue.timezone ?? null,
      },
      organizer: event.organizer.name,
      nextSessionAt: event.sessions[0]?.startsAt ?? null,
      fromPriceMinor: event.sessions[0]?.ticketTypes[0]?.priceMinor ?? null,
      currency: event.sessions[0]?.ticketTypes[0]?.currency ?? 'INR',
      imagePath: event.imagePath ?? null,
    });
    try {
      const saved = JSON.parse(localStorage.getItem(`etg_sel_${slug}`) ?? 'null') as {
        sessionId: string;
        qty: Record<string, number>;
      } | null;
      // Never restores a selection whose session has started since it was saved.
      if (
        saved &&
        event.sessions.some(
          (s) => s.id === saved.sessionId && new Date(s.startsAt).getTime() > Date.now(),
        )
      ) {
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
      if (!session || sessionStarted) throw new Error('No session selected');
      if (!tokenStore.access) {
        router.push('/login?next=/events/' + slug);
        throw new Error('login');
      }
      const me = await api.me();
      return api.createBooking({
        eventSessionId: session.id,
        // Only sent when the buyer chose it. The server refuses CASH unless the organizer
        // enabled it, so this is a request rather than a decision.
        ...(payWithCash ? { paymentMethod: 'CASH' as const } : {}),
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
        ...(buyerRegion ? { buyerRegion } : {}),
      });
    },
    onSuccess: (booking) => router.push(nextStepAfterBooking(booking)),
    onError: (e) => {
      if (e instanceof ApiRequestError) setError(e.message);
      else if ((e as Error).message !== 'login') setError(sf('event.couldNotBook'));
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
    /*
      ── WHY TWO CODES AND NOT ONE ──────────────────────────────────────────────────
      Only NOT_FOUND was treated as "this event isn't available", so an event that exists but
      is not published — draft, ended, unlisted — fell through to the generic error and was
      shown as "We couldn't load this event. Please try again." with a Try again button.
      Retrying a permanent condition can only fail, and the customer is left believing the
      site is broken rather than that the event is gone. Observed on QA against a real link.
    */
    const gone =
      eventError instanceof ApiRequestError &&
      (eventError.code === 'NOT_FOUND' || eventError.code === 'EVENT_NOT_PUBLISHED');
    return gone ? (
      <EmptyState
        title={sf('event.notFoundTitle')}
        hint={sf('event.notFoundHint')}
        icon={CalendarDays}
      />
    ) : (
      <ErrorState message={sf('event.loadError')} onRetry={() => refetch()} />
    );
  }
  if (!event)
    return (
      <EmptyState
        title={sf('event.notFoundTitle')}
        hint={sf('event.notFoundHint')}
        icon={CalendarDays}
      />
    );

  /*
    The venue's clock. A session is at the time printed at the venue, and a buyer planning a
    trip from another zone must see that time, named — not their phone's conversion of it.
  */
  const zone = event.venue.timezone ?? undefined;

  /*
    Every image the organizer gave, cover first — or just the cover from an API that predates
    galleries. The hero shows the chosen one; the strip below it chooses.
  */
  const gallery = (
    event.images?.length
      ? event.images.map((image) => image.path)
      : event.imagePath
        ? [event.imagePath]
        : []
  )
    .map((path) => apiAssetUrl(path))
    .filter((url): url is string => Boolean(url));
  const shownImage = Math.min(activeImage, Math.max(gallery.length - 1, 0));
  const heroImage = gallery[shownImage] ?? null;

  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-lg border border-border shadow-sm">
        <div
          className={`relative flex items-end p-6 ${
            heroImage
              ? 'h-64 bg-black sm:h-96'
              : 'h-52 bg-gradient-to-br from-action-primary/25 via-action-primary/10 to-background-subtle sm:h-64'
          }`}
        >
          {/*
            ── THE WHOLE IMAGE, NOT A CROP OF IT ─────────────────────────────────────────
            The image was stretched across the strip with `object-cover`, which cut the edges
            off anything that was not already a wide landscape — the organizer's logo lost its
            ends on QA. It is now shown whole (`object-contain`) over a blurred copy of itself,
            so a portrait poster, a square logo and a wide photo all read properly and the
            strip never shows empty bars. The picture opens full screen; the title below it is
            what says what the event is, so the images carry no alt text of their own here.
          */}
          {heroImage && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                aria-hidden
                src={heroImage}
                alt=""
                className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl"
              />
              <button
                type="button"
                onClick={() => setLightbox(shownImage)}
                aria-label={
                  gallery.length > 1
                    ? sf('event.galleryOpen', { total: gallery.length })
                    : sf('event.galleryOpenOne')
                }
                className="absolute inset-0 cursor-zoom-in focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-white/70"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={heroImage}
                  src={heroImage}
                  alt=""
                  className="h-full w-full animate-fade-in object-contain"
                />
              </button>
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/85 via-black/40 to-transparent"
              />
              {gallery.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setActiveImage((shownImage - 1 + gallery.length) % gallery.length)
                    }
                    aria-label={sf('event.galleryPrevious')}
                    className="absolute left-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur transition-colors hover:bg-black/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  >
                    <ChevronLeft className="h-5 w-5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveImage((shownImage + 1) % gallery.length)}
                    aria-label={sf('event.galleryNext')}
                    className="absolute right-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur transition-colors hover:bg-black/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  >
                    <ChevronRight className="h-5 w-5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => setLightbox(shownImage)}
                    className="absolute left-4 top-4 z-10 flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-caption font-medium text-white backdrop-blur transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  >
                    <Images className="h-3.5 w-3.5" aria-hidden />
                    {sf('event.galleryOpen', { total: gallery.length })}
                  </button>
                </>
              )}
            </>
          )}
          <div className="pointer-events-none relative z-10">
            <Badge tone="info">{event.category}</Badge>
            <h1
              className={`mt-3 text-h2 font-bold tracking-tight sm:text-h1 ${
                heroImage ? 'text-white' : 'text-text-primary'
              }`}
            >
              {event.title}
            </h1>
            <p
              className={`mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.9375rem] ${
                heroImage ? 'text-white/90' : 'text-text-secondary'
              }`}
            >
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
            className="absolute right-4 top-4 z-10 flex items-center gap-1.5 rounded-full bg-background-surface/90 px-3 py-1.5 text-caption font-medium text-text-secondary shadow-sm backdrop-blur transition-colors hover:text-text-primary"
          >
            <Share2 className="h-3.5 w-3.5" />
            {shared ? sf('common.copied') : tx('action.share')}
          </button>
        </div>
      </div>

      {/*
        The rest of the organizer's images, as buttons that put one in the hero. Buttons with a
        pressed state rather than a carousel: every image is one tab-stop away, a screen reader
        hears which is showing, and nothing moves by itself.
      */}
      {gallery.length > 1 && (
        <ul className="-mt-4 flex gap-2 overflow-x-auto pb-1" aria-label={sf('event.galleryLabel')}>
          {gallery.map((url, index) => (
            <li key={url} className="shrink-0">
              <button
                type="button"
                onClick={() => setActiveImage(index)}
                aria-pressed={index === shownImage}
                aria-label={sf('event.galleryShow', { index: index + 1, total: gallery.length })}
                className={`block overflow-hidden rounded-md border-2 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                  index === shownImage
                    ? 'border-action-primary'
                    : 'border-transparent opacity-75 hover:opacity-100'
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" loading="lazy" className="h-16 w-28 object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <ImageLightbox
        images={gallery}
        index={lightbox}
        title={event.title}
        onIndexChange={(index) => {
          setLightbox(index);
          // Closing leaves the hero on the image the buyer was looking at.
          setActiveImage(index);
        }}
        onClose={() => setLightbox(null)}
      />

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-6 lg:col-span-2">
          {event.description && (
            <Card title={sf('event.about')}>
              <p className="whitespace-pre-line leading-relaxed text-text-secondary">
                {event.description}
              </p>
            </Card>
          )}

          <Card title={sf('event.sessionsHeading')}>
            <div className="space-y-2">
              {!event.sessions.some((s) => new Date(s.startsAt).getTime() > Date.now()) && (
                <p className="text-[0.9375rem] text-text-muted">{sf('event.noUpcomingSessions')}</p>
              )}
              {event.sessions.map((s) => {
                const active = session?.id === s.id;
                // Only from a page left open past the start: the API no longer sends these.
                const started = new Date(s.startsAt).getTime() <= Date.now();
                return (
                  <button
                    key={s.id}
                    disabled={started}
                    onClick={() => {
                      setSessionId(s.id);
                      setQty({});
                    }}
                    className={`flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
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
                      {dateTime(s.startsAt, undefined, zone)}
                      {zone ? (
                        <span className="font-normal text-text-muted">
                          {' '}
                          ({zoneAbbrev(s.startsAt, zone)})
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          <div className="grid gap-6 sm:grid-cols-2">
            <Card title={sf('event.venueHeading')}>
              <p className="font-medium text-text-primary">{event.venue.name}</p>
              <p className="mt-1 text-[0.9375rem] text-text-muted">
                {event.venue.address ? `${event.venue.address}, ` : ''}
                {event.venue.city}, {event.venue.country}
              </p>
              {/*
                A real link where an empty box used to be.

                There was a dashed placeholder here reading "Map preview". Venues store an
                address and no coordinates, so there was nothing to draw and never had been
                — it was a promise of a feature, rendered as a grey rectangle, on the page
                where somebody is deciding whether to spend money. An unfulfilled promise
                takes up more space than no promise and reads worse.

                Directions is the thing people actually want from a venue card, so it is now
                the affordance rather than a caption underneath a hole. It opens the map app
                they already have, which also renders better than anything embedded here.
              */}
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                  `${event.venue.name}, ${event.venue.address ?? ''} ${event.venue.city} ${event.venue.country}`,
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-[0.9375rem] font-medium text-text-primary transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <MapPin className="h-4 w-4" />
                {sf('event.getDirections')}
                <span className="sr-only">{sf('event.opensInNewTab')}</span>
              </a>
            </Card>
            <Card title={sf('event.organizerHeading')}>
              <Link
                href={`/organizers/${event.organizer.id}`}
                className="group flex items-center gap-3"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-tint-primary font-semibold text-action-primary">
                  {event.organizer.name.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-text-primary group-hover:text-action-primary">
                    {event.organizer.name}
                  </p>
                  <p className="text-caption text-text-muted">{sf('event.viewProfile')}</p>
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
                  <h3 className="font-semibold text-text-primary">{sf('event.refundPolicy')}</h3>
                  <p className="mt-1 text-[0.9375rem] text-text-muted">{event.refundPolicy}</p>
                </div>
              </div>
            </Card>
          )}

          {/* Reviews */}
          <Card title={sf('event.reviews')}>
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
                      {sf('event.reviewCount', { count: reviews.data.count })}
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
              <p className="text-[0.9375rem] text-text-muted">{sf('event.noReviews')}</p>
            )}

            {/* Write a review */}
            {authed && (
              <div className="mt-5 rounded-lg border border-border bg-background-subtle/50 p-4">
                <p className="font-medium text-text-primary">
                  {mine.data ? sf('event.updateYourReview') : sf('event.writeReview')}
                </p>
                <div className="mt-2">
                  <RatingStars value={rating} onChange={setRating} size="lg" />
                </div>
                <Textarea
                  id="review-comment"
                  aria-label={sf('event.yourReview')}
                  className="mt-3"
                  rows={3}
                  placeholder={sf('event.reviewPlaceholder')}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <Button
                  className="mt-3"
                  loading={submitReview.isPending}
                  disabled={rating < 1}
                  onClick={() => submitReview.mutate()}
                >
                  {mine.data ? sf('event.updateReview') : sf('event.submitReview')}
                </Button>
                <p className="mt-2 text-caption text-text-muted">{sf('event.reviewEligibility')}</p>
              </div>
            )}
          </Card>

          {/* FAQ */}
          <Card title={sf('event.faq')}>
            <div className="divide-y divide-border">
              {[
                { q: sf('event.faqReceiveQ'), a: sf('event.faqReceiveA') },
                {
                  q: sf('event.faqRefundQ'),
                  // The organizer's own policy is their words, shown as written.
                  a: event.refundPolicy ?? sf('event.faqRefundA'),
                },
                { q: sf('event.faqPrintQ'), a: sf('event.faqPrintA') },
                { q: sf('event.faqTransferQ'), a: sf('event.faqTransferA') },
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
              <h2 className="text-title font-semibold text-text-primary">
                {session?.seatBased ? sf('event.seatedHeading') : sf('event.selectTickets')}
              </h2>
            </div>

            {/*
              A seated show is chosen on the seat map, not here.

              Reserved seating used to exist only for cinemas, so this card only ever needed
              to offer quantities. Now that a session can be in a room, offering a quantity
              box for one would let somebody ask for "two of Stalls" without saying WHICH two
              — and the booking would be refused at the last step with "please select a seat
              for each ticket", after they had committed to the price.

              Read from the session rather than from the event: two dates of the same tour
              can differ, one in a seated theatre and one in a standing room.
            */}
            {session?.seatBased ? (
              sessionStarted ? null : (
                <div className="space-y-4">
                  <p className="text-[0.9375rem] text-text-secondary">{sf('event.seatedLead')}</p>
                  <ButtonLink href={`/shows/${session.id}`} className="w-full">
                    {sf('event.chooseSeats')}
                  </ButtonLink>
                </div>
              )
            ) : (
              <>
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
                            {event.isFree ? tx('state.free') : money(t.priceMinor, t.currency)} ·{' '}
                            {soldOut ? (
                              <span className="text-status-error">{tx('state.soldOut')}</span>
                            ) : (
                              sf('event.left', { count: t.available })
                            )}
                          </p>
                        </div>
                        <select
                          aria-label={tx('a11y.quantityOf', { name: t.name })}
                          disabled={soldOut}
                          value={qty[t.id] ?? 0}
                          onChange={(e) =>
                            setQty((p) => ({ ...p, [t.id]: Number(e.target.value) }))
                          }
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
                      {sf('event.enhance')}
                    </p>
                    <div className="space-y-2">
                      {addOns.map((a) => {
                        const max =
                          a.remaining === null
                            ? a.maxPerOrder
                            : Math.min(a.maxPerOrder, a.remaining);
                        return (
                          <div
                            key={a.id}
                            className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
                          >
                            <div className="min-w-0">
                              <p className="truncate font-medium text-text-primary">{a.name}</p>
                              <p className="text-caption text-text-muted">
                                {money(a.priceMinor, a.currency)}
                                {a.soldOut && (
                                  <span className="text-status-error">
                                    {' '}
                                    · {tx('state.soldOut')}
                                  </span>
                                )}
                              </p>
                            </div>
                            <select
                              aria-label={tx('a11y.quantityOf', { name: a.name })}
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
                      {sf('event.bundlesHeading')}
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
                                    ·{' '}
                                    {sf('event.bundleSave', {
                                      amount: money(b.savingsMinor, b.currency),
                                    })}
                                  </span>
                                )}
                              </p>
                            </div>
                            <select
                              aria-label={tx('a11y.quantityOf', { name: b.name })}
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
                              {sf('event.bundleIncludes', {
                                items: b.components
                                  .map((c) => `${c.quantity}× ${c.label}`)
                                  .join(', '),
                              })}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Above the breakdown, because it can change what the breakdown says. */}
                {!event.isFree && (
                  <div className="mt-4">
                    <BuyerRegionField
                      value={buyerRegion}
                      onChange={(v) => {
                        setRegionTouched(true);
                        setBuyerRegion(v);
                      }}
                      prefilled={Boolean(user?.lastBuyerRegion) && !regionTouched}
                      country={event.venue?.country}
                      // Translated: the field's English defaults showed on French Indian pages (QA).
                      label={sf('checkout.buyerRegionLabel')}
                      hint={sf('checkout.buyerRegionHint')}
                      noneLabel={sf('checkout.buyerRegionNone')}
                      prefilledNote={sf('checkout.buyerRegionPrefilled')}
                    />
                  </div>
                )}

                <div className="mt-4">
                  <PriceBreakdown
                    free={event.isFree}
                    quote={quoteQ.data?.fees}
                    loading={quoteQ.isFetching}
                    fallbackTotalMinor={subtotal}
                    /*
                      What the tickets on this page are priced in, so the total before any
                      quote matches the prices above it. Without this the breakdown had no
                      currency until a ticket was chosen, and `money()` falls back to INR --
                      so a dollar-priced event opened on a rupee total.
                    */
                    fallbackCurrency={
                      event.sessions.flatMap((s) => s.ticketTypes)[0]?.currency ?? undefined
                    }
                  />
                </div>

                {error && (
                  <p role="alert" className="mt-3 text-caption text-status-error">
                    {error}
                  </p>
                )}
                <Button
                  className="mt-4 w-full"
                  loading={book.isPending && !payWithCash}
                  disabled={totalQty === 0 || book.isPending || sessionStarted}
                  onClick={() => {
                    setError(null);
                    setPayWithCash(false);
                    book.mutate();
                  }}
                >
                  {book.isPending && !payWithCash
                    ? sf('event.holdingTickets')
                    : event.isFree
                      ? sf('event.getMyTickets')
                      : sf('event.continueToPayment')}
                </Button>

                {/*
                  Offered only when the organizer takes cash, and never for a free event
                  where there is nothing to collect. A second BUTTON rather than a radio
                  group: the choice is the action, and making somebody pick an option and
                  then press Continue is a step that earns nothing.
                */}
                {event.cashAccepted && !event.isFree && (
                  <>
                    <Button
                      variant="outline"
                      className="mt-2 w-full"
                      loading={book.isPending && payWithCash}
                      disabled={totalQty === 0 || book.isPending || sessionStarted}
                      onClick={() => {
                        setError(null);
                        setPayWithCash(true);
                        book.mutate();
                      }}
                    >
                      {b('payAtVenue')}
                    </Button>
                    <p className="mt-1.5 text-caption text-text-muted">{b('payAtVenueHint')}</p>
                  </>
                )}
              </>
            )}
          </Card>
        </div>
      </div>

      {/* You might also like — recommendations seeded by this event. */}
      {recommendations.isLoading ? (
        <section className="space-y-4">
          <h2 className="text-title font-semibold text-text-primary">
            {sf('event.recommendations')}
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-64 w-full rounded-lg" />
            ))}
          </div>
        </section>
      ) : recommendations.data && recommendations.data.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-title font-semibold text-text-primary">
            {sf('event.recommendations')}
          </h2>
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
