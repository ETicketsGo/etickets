'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Link, useRouter } from '@/i18n/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Images, MapPin, Share2 } from 'lucide-react';
import { ImageLightbox } from '@/components/image-lightbox';
import { heroState } from '@/lib/event-hero';
import { eventIsSoldOut, showIsSoldOut } from '@/lib/event-availability';
import { CONTINUE_ANCHOR_ID, StickyContinue } from '@/components/sticky-continue';
import {
  BRAND_FOCUS,
  BUSINESS_DETAILS,
  BrandButton,
  BrandStatusPill,
  RatingStars,
  apiAssetUrl,
  brandButtonClasses,
  brandChipClasses,
  eventImageSource,
  publishedDetail,
  showDurationMinutes,
  useToast,
  errorMessage,
  venueAddressLine,
  venueMapQuery,
} from '@eticketsgo/web-kit';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { pushRecent } from '@/lib/recent';
import { EmptyState, ErrorState, Skeleton, Textarea } from '@/components/ui';
import { EventCard } from '@/components/event-card';
import { ContentLabelBadge } from '@/components/content-label-badge';
import { PriceBreakdown } from '@/components/price-breakdown';
import { nextStepAfterBooking } from '@/lib/after-booking';
import { GuestBuyerFields, useGuestBuyer } from '@/components/guest-buyer';
import { startGuestBooking } from '@/lib/guest-session';
import { useTranslations } from 'next-intl';
import { BuyerRegionField, moneyFractionDigits, useAuthUser } from '@eticketsgo/web-kit';
import { currentPageUrl } from '@/lib/site-url';
import {
  ArtistsCard,
  EventFacts,
  OrganizerCard,
  TermsAgreeNote,
  TermsRow,
  useTermsDialog,
} from '@/components/event-details';
import {
  BRAND_EYEBROW,
  BRAND_LINK,
  BRAND_PANEL,
  QuantityStepper,
  TicketAvailability,
  useVenueWhen,
} from '@/components/booking-brand';

export default function EventDetailPage() {
  // `tx` is the shared vocabulary (Free, Sold out); `sf` is storefront copy.
  const tx = useTranslations('common');
  const sf = useTranslations('storefront');
  const b = useTranslations('storefront.booking');
  const { money, dateOnly } = useFormat();
  // The venue's clock, in parts, for the hero, the booking panel and the date chips.
  const venueWhen = useVenueWhen();
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
  /* Images that failed to load, by their full-size URL. See `lib/event-hero.ts`. */
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const markImageFailed = (full: string) =>
    setFailedImages((failed) => (failed.includes(full) ? failed : [...failed, full]));
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
  /*
    Buying without an account.

    `asGuest` is false for a signed-in customer, so nothing below changes for them. For
    everybody else it is what replaces the old silent redirect to /login.
  */
  const guest = useGuestBuyer(user);
  const [error, setError] = useState<string | null>(null);
  /*
    Which button was pressed, read by the mutation. Kept out of the request body until
    then so a stale value can never turn an online purchase into a reservation.
  */
  const [payWithCash, setPayWithCash] = useState(false);
  const [shared, setShared] = useState(false);
  // Before the early returns below, as a hook must be; it renders nothing until the event loads.
  const terms = useTermsDialog(event);

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
  const zoneTicketTypes = (session?.ticketTypes ?? []).filter(
    (ticketType) => ticketType.inventoryKind === 'ZONE',
  );
  const hasReservedTickets = (session?.ticketTypes ?? []).some(
    (ticketType) => ticketType.inventoryKind !== 'ZONE',
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
      (!session?.seatBased ||
        quoteItems.every((item) =>
          zoneTicketTypes.some((ticketType) => ticketType.id === item.ticketTypeId),
        )) &&
      !event?.isFree &&
      quoteItems.length + quoteAddOns.length + quoteBundles.length > 0,
    // A stale price is worse than a brief spinner: this is the number they are agreeing to.
    staleTime: 0,
  });

  /*
    One decision about decimals for the whole booking card.

    The ticket rows and the breakdown under them each decided for themselves, so the card printed
    "General / Rs 120" directly above "Tickets / Rs 120.00" - one figure, twice, in two shapes. The
    same defect was reported on the confirmation screen ("subtotal 499 ... its good to show
    499.00"); this is the screen it starts on.

    Every amount the card shows goes into the decision, priced items and quoted totals alike, and
    both halves are handed the answer. `moneyFractionDigits` only has anything to decide for INR,
    where a whole-rupee price stays whole until something in the same card carries paise - which a
    percentage fee usually does.
  */
  const cardFractionDigits = useMemo(() => {
    const fees = quoteQ.data?.fees;
    return moneyFractionDigits(
      [
        ...(session?.ticketTypes ?? []).map((t) => t.priceMinor),
        ...addOns.map((a) => a.priceMinor),
        ...bundles.flatMap((b) => [b.priceFromMinor, b.savingsMinor]),
        subtotal,
        ...(fees
          ? [
              fees.subtotalMinor,
              fees.discountMinor,
              fees.bookingFeeMinor,
              fees.paymentFeeMinor,
              fees.customerFeeMinor,
              fees.feeTaxMinor,
              fees.maintenanceMinor,
              ...(fees.taxLines ?? []).map((l) => l.amountMinor),
              fees.totalMinor,
            ]
          : []),
      ],
      session?.ticketTypes[0]?.currency ?? quoteQ.data?.fees?.currency,
    );
  }, [session, addOns, bundles, subtotal, quoteQ.data]);

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
      imageVariants: event.imageVariants ?? null,
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
      const order = {
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
        ...(buyerRegion ? { buyerRegion } : {}),
      };
      /*
        A guest buys through the guest route, with the name and email they just typed.

        `startBooking` has already validated them, so this cannot be the first place the
        buyer learns the form was incomplete -- and it re-reads the same values rather than
        trusting a copy, so what is sent is what is on screen.
      */
      if (guest.asGuest) {
        const buyer = guest.validate();
        if (!buyer) throw new Error('details');
        return startGuestBooking({
          ...order,
          buyerName: buyer.name,
          buyerEmail: buyer.email,
        });
      }
      const me = await api.me();
      /*
        A signed-in account with no email address (a phone sign-in) buys with the name and
        email it just gave. The name is saved to the profile, as the profile page would; the
        email is used for these tickets and this receipt only - it is not written to the account
        as if it had been verified. The server refuses a placeholder address either way.
      */
      if (guest.needsContact || !me.email || !me.fullName?.trim()) {
        const buyer = guest.validate();
        if (!buyer) throw new Error('details');
        if (!me.fullName?.trim()) await api.updateProfile(buyer.name).catch(() => undefined);
        return api.createBooking({ ...order, buyerName: buyer.name, buyerEmail: buyer.email });
      }
      return api.createBooking({ ...order, buyerName: me.fullName, buyerEmail: me.email });
    },
    onSuccess: (booking) => router.push(nextStepAfterBooking(booking)),
    onError: (e) => {
      const message = (e as Error).message;
      if (e instanceof ApiRequestError) setError(e.message);
      // 'details' is the form talking to itself: the fields already say what is missing.
      else if (message !== 'login' && message !== 'details') setError(sf('event.couldNotBook'));
    },
  });

  /**
   * Press the button.
   *
   * Nothing is sent until the guest form is satisfied, which is the point: a request that can
   * only be refused for a missing name is a slower way of saying what the form can say now.
   */
  const startBooking = (cash: boolean) => {
    setError(null);
    setPayWithCash(cash);
    if ((guest.asGuest || guest.needsContact) && !guest.validate()) return;
    book.mutate();
  };

  const share = async () => {
    // On the site's own address, never the host this visitor happened to arrive on.
    const url = currentPageUrl();
    if (navigator.share) {
      await navigator.share({ title: event?.title, url }).catch(() => undefined);
    } else {
      await navigator.clipboard.writeText(url).catch(() => undefined);
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    }
  };

  /*
    Tall enough to fill a phone, so the footer starts below the fold.

    At h-96 the footer sat in the first screen while the event loaded and was then thrown to the
    bottom of a 6000px page when it arrived - the largest layout shift on the page (CLS 0.33 on a
    throttled phone). Only what is on screen counts as a shift, so keeping the footer off it
    until the page is there removes the shift without changing what loads.
  */
  if (isLoading)
    return <div className="min-h-[100svh] animate-pulse rounded-lg bg-background-subtle" />;
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

  const continueLabel =
    book.isPending && !payWithCash
      ? sf('event.holdingTickets')
      : event.isFree
        ? sf('event.getMyTickets')
        : sf('event.continueToPayment');
  /*
    Nothing left to buy, said at the top of the booking card as well as in each ticket row.
    A sold-out date of an event with other dates still on sale says so for the date, because
    "this event is sold out" would be untrue and would stop somebody looking at the others.
  */
  const dateSoldOut = !session?.seatBased && showIsSoldOut(session);
  const eventSoldOut = eventIsSoldOut(event.sessions);

  /*
    The venue's clock. A session is at the time printed at the venue, and a buyer planning a
    trip from another zone must see that time, named — not their phone's conversion of it.
  */
  const zone = event.venue.timezone ?? undefined;

  /*
    Every image the organizer gave, cover first — or just the cover from an API that predates
    galleries. The hero shows the chosen one; the strip below it chooses.

    Each in the copy cut for where it is shown: the banner in the hero, a small banner in the
    strip, the whole picture in the full-screen viewer. An API from before the copies gives
    the original for all three, which still works, only heavier.
  */
  const allImages = (
    event.images?.length
      ? event.images
      : event.imagePath
        ? [{ path: event.imagePath, variants: event.imageVariants ?? undefined }]
        : []
  ).flatMap((image) => {
    const banner = eventImageSource(image, 'banner');
    const full = eventImageSource(image, 'full');
    if (!banner || !full) return [];
    const focal = 'focalPoint' in image ? image.focalPoint : undefined;
    return [
      {
        banner,
        full: full.src,
        // The strip's buttons are 16:9 too, so the small banner fills them.
        strip: apiAssetUrl(image.variants?.['banner-sm']) ?? banner.src,
        // Where the hero centres a further crop on a wide screen; see the hero below.
        position: focal ? `${focal.x * 100}% ${focal.y * 100}%` : '50% 50%',
      },
    ];
  });
  /*
    Only the images that loaded are offered anywhere on the page. If none did, the hero keeps
    a stage band with the title on it, so nothing below it moves and no broken image shows.
  */
  const hero = heroState(allImages, failedImages, activeImage);
  const gallery = hero.usable;
  const shownImage = hero.index;
  const heroImage = hero.image;
  const hasArt = hero.mode !== 'none';

  /*
    ── THE FIRST SCREEN ANSWERS "WHAT, WHEN, WHERE, HOW MUCH" ────────────────────────────
    Audit C4: on a phone the first screen had the photo, the title and the organizer, and no
    date, no price and no way to buy. The hero now carries the date in the venue's clock with
    its zone named, the venue, the organizer, the lowest price still on sale and one action
    that goes to the tickets.

    "From" is the cheapest ticket of the shown date that can still be bought - one ticket's own
    price, in its own currency, never a sum. When nothing is on sale it falls back to the
    cheapest listed, so the figure still describes the event rather than vanishing.
  */
  const shownWhen = session ? venueWhen(session.startsAt, zone) : null;
  const onSaleTypes = (session?.ticketTypes ?? []).filter(
    (t) => t.available > 0 && t.saleState !== 'CLOSED' && t.saleState !== 'NOT_YET',
  );
  const priced = onSaleTypes.length ? onSaleTypes : (session?.ticketTypes ?? []);
  const cheapest = priced.reduce<(typeof priced)[number] | null>(
    (low, t) => (low === null || t.priceMinor < low.priceMinor ? t : low),
    null,
  );
  const fromText = event.isFree
    ? tx('state.free')
    : cheapest
      ? money(cheapest.priceMinor, cheapest.currency)
      : null;
  const futureSessions = event.sessions.filter((s) => new Date(s.startsAt).getTime() > Date.now());
  const supportEmail = publishedDetail(BUSINESS_DETAILS.supportEmail);
  const minutes = session ? showDurationMinutes(session.startsAt, session.endsAt) : null;

  /** A quantity row: name, availability, price and a stepper. Shared by tickets, add-ons, bundles. */
  const ticketRow = ({
    id,
    name,
    meta,
    price,
    value,
    max,
    disabled,
    onChange,
    extra,
  }: {
    id: string;
    name: string;
    meta: ReactNode;
    price: string;
    value: number;
    max: number;
    disabled: boolean;
    onChange: (next: number) => void;
    extra?: ReactNode;
  }) => (
    /*
      Name, then price and availability on one line, with the stepper beside them: on a 390px
      phone the row stays one row, and the price sits under the name it belongs to.
    */
    <li key={id} className="flex items-center gap-4 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="text-brand-body font-semibold text-brand-ink">{name}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-brand-ui font-semibold tabular-nums text-brand-ink">{price}</span>
          {meta}
        </div>
        {extra}
      </div>
      <div className="shrink-0">
        <QuantityStepper
          label={tx('a11y.quantityOf', { name })}
          name={name}
          value={value}
          max={max}
          disabled={disabled}
          onChange={onChange}
        />
      </div>
    </li>
  );

  const heroTitle = (
    <div className="max-w-2xl">
      {/*
        No picture at all: the band carries the brand's no-image mark (EventArtwork's marigold
        rule) above the words, so it reads as designed rather than as a photo that failed.
      */}
      {!hasArt ? (
        <span aria-hidden className="mb-6 block h-1 w-16 rounded-full bg-brand-marigold" />
      ) : null}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-brand-eyebrow uppercase text-brand-ink-2">
        {[event.category, event.venue.city].filter(Boolean).join(' / ')}
        <ContentLabelBadge label={event.contentLabel} />
      </p>
      <h1
        id="event-title"
        className="mt-3 text-balance font-brand-display text-brand-d1 text-brand-ink"
      >
        {event.title}
      </h1>
      <div className="mt-4 space-y-1 text-brand-body text-brand-ink-2">
        {shownWhen ? (
          <p>
            <time dateTime={session!.startsAt}>
              <span className="font-semibold text-brand-ink">{shownWhen.day},</span>{' '}
              <span className="text-brand-ink">{shownWhen.time}</span>
              {shownWhen.zone ? <span> {shownWhen.zone}</span> : null}
            </time>
            {futureSessions.length > 1 ? (
              <span>
                {' '}
                -{' '}
                {sf('event.dateRange', {
                  from: dateOnly(futureSessions[0].startsAt, undefined, zone),
                  to: dateOnly(futureSessions[futureSessions.length - 1].startsAt, undefined, zone),
                })}
              </span>
            ) : null}
          </p>
        ) : null}
        <p>
          {/* "Name, City", as Review & pay and the confirmation write the place. */}
          <span className="font-semibold text-brand-ink">{event.venue.name},</span>{' '}
          {event.venue.city}
        </p>
        <p>{sf('event.byOrganizer', { name: event.organizer.name })}</p>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
        {eventSoldOut ? (
          <BrandStatusPill status="neutral">{sf('event.soldOutEventTitle')}</BrandStatusPill>
        ) : (
          <a href="#tickets" className={brandButtonClasses('primary', 'lg')}>
            {sf('event.bookTickets')}
          </a>
        )}
        {fromText && !eventSoldOut ? (
          <p className="text-brand-ui text-brand-ink-2">
            {event.isFree ? (
              <span className="text-brand-figure-sm text-brand-ink">{fromText}</span>
            ) : (
              sf.rich('event.fromPrice', {
                price: fromText,
                strong: (chunks) => (
                  <span className="text-brand-figure-sm tabular-nums text-brand-ink">{chunks}</span>
                ),
              })
            )}
          </p>
        ) : null}
      </div>
    </div>
  );

  const quietOnPhoto = `flex min-h-11 items-center gap-1.5 rounded-full bg-brand-scrim/70 px-4 text-brand-meta font-semibold text-brand-ink transition-colors hover:bg-brand-scrim/90 ${BRAND_FOCUS}`;

  return (
    <div
      data-brand="customer"
      // Out to the edges of the page column: the hero is a band, not a card.
      className="-mx-4 -mt-6 bg-brand-canvas pb-16 font-brand-text text-brand-ink sm:-mx-6 sm:-mt-10 lg:-mx-8 lg:pb-24"
    >
      {/*
        ── THE HERO IS A STAGE BAND ─────────────────────────────────────────────────────
        DESIGN-SYSTEM.md section 6: text sits on a photo only on a stage band, over a scrim from
        the text side, never over the focal point. On a phone the picture comes first and the
        words sit under it on the same dark band (a 16:9 photo on a 390px screen is 220px, and
        words laid over it covered it); from `lg` the picture fills the band and the words sit in
        its left third over the scrim.

        The banner copy is cut by the API to 16:9 around the organizer's focal point; a wider box
        crops further around the same point. The whole picture is one tap away in the viewer.
      */}
      <section
        data-brand-tone="stage"
        aria-labelledby="event-title"
        className="relative isolate overflow-hidden bg-brand-canvas"
      >
        {heroImage ? (
          <div className="relative aspect-video w-full lg:absolute lg:inset-0 lg:aspect-auto">
            <button
              type="button"
              onClick={() => setLightbox(shownImage)}
              aria-label={
                gallery.length > 1
                  ? sf('event.galleryOpen', { total: gallery.length })
                  : sf('event.galleryOpenOne')
              }
              className="absolute inset-0 cursor-zoom-in focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-brand-focus"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={heroImage.banner.src}
                src={heroImage.banner.src}
                srcSet={heroImage.banner.srcSet}
                sizes="(min-width: 1440px) 1440px, 100vw"
                alt=""
                width={1280}
                height={720}
                // The largest thing on the page. Lower case: see the note on EventCard.
                {...{ fetchpriority: 'high' }}
                onError={() => markImageFailed(heroImage.full)}
                style={{ objectPosition: heroImage.position }}
                className="h-full w-full animate-fade-in object-cover"
              />
            </button>
            {/* The scrim: from the text side (left) on a wide screen, from below on a phone. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-brand-canvas to-transparent lg:hidden"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 hidden bg-gradient-to-r from-brand-scrim/90 via-brand-scrim/40 to-transparent lg:block"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-1/2 bg-gradient-to-t from-brand-scrim/80 to-transparent lg:block"
            />
          </div>
        ) : hasArt ? (
          /*
            Every image failed. The band keeps a picture-shaped box so nothing below it moves,
            filled with the stage colour and a marigold rule - the brand's no-image artwork, with
            the title left to the heading beside it rather than printed twice.
          */
          <div
            aria-hidden
            data-testid="event-hero-placeholder"
            className="relative flex aspect-video w-full items-end bg-brand-sunken p-6 lg:absolute lg:inset-0 lg:aspect-auto lg:justify-end lg:p-10"
          >
            <span className="h-1 w-16 rounded-full bg-brand-marigold" />
          </div>
        ) : null}

        {/* Photo controls, top right; Share always (it is about the event, not the photo). */}
        <div className="absolute right-4 top-4 z-10 flex gap-2 sm:right-6 lg:right-10 lg:top-6">
          {heroImage && (
            <button type="button" onClick={() => setLightbox(shownImage)} className={quietOnPhoto}>
              <Images className="h-4 w-4" aria-hidden />
              {gallery.length > 1
                ? sf('event.galleryOpen', { total: gallery.length })
                : sf('event.galleryOpenOne')}
            </button>
          )}
          <button type="button" onClick={share} className={quietOnPhoto}>
            <Share2 className="h-4 w-4" aria-hidden />
            {shared ? sf('common.copied') : tx('action.share')}
          </button>
        </div>
        {heroImage && gallery.length > 1 && (
          <div className="absolute inset-x-4 top-1/2 z-10 hidden -translate-y-1/2 justify-between sm:flex lg:hidden">
            <button
              type="button"
              onClick={() => setActiveImage((shownImage - 1 + gallery.length) % gallery.length)}
              aria-label={sf('event.galleryPrevious')}
              className={`${quietOnPhoto} w-11 justify-center px-0`}
            >
              <ChevronLeft className="h-5 w-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setActiveImage((shownImage + 1) % gallery.length)}
              aria-label={sf('event.galleryNext')}
              className={`${quietOnPhoto} w-11 justify-center px-0`}
            >
              <ChevronRight className="h-5 w-5" aria-hidden />
            </button>
          </div>
        )}

        <div
          className={`relative px-4 pb-10 sm:px-6 lg:flex lg:items-end lg:px-10 lg:pb-14 ${
            hasArt ? 'pt-2 lg:min-h-[600px] lg:pt-32' : 'pt-12 lg:min-h-[360px] lg:pt-20'
          }`}
        >
          {heroTitle}
        </div>
      </section>

      {/*
        The rest of the organizer's images, as buttons that put one in the hero. Buttons with a
        pressed state rather than a carousel: every image is one tab-stop away, a screen reader
        hears which is showing, and nothing moves by itself.
      */}
      {gallery.length > 1 && (
        <ul
          className="flex gap-2 overflow-x-auto px-4 pt-4 sm:px-6 lg:px-10"
          aria-label={sf('event.galleryLabel')}
        >
          {gallery.map((image, index) => (
            <li key={image.full} className="shrink-0">
              <button
                type="button"
                onClick={() => setActiveImage(index)}
                aria-pressed={index === shownImage}
                aria-label={sf('event.galleryShow', { index: index + 1, total: gallery.length })}
                className={`block overflow-hidden rounded-brand-control border-2 transition-opacity ${BRAND_FOCUS} ${
                  index === shownImage
                    ? 'border-brand-ink'
                    : 'border-transparent opacity-75 hover:opacity-100'
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.strip}
                  alt=""
                  width={114}
                  height={64}
                  loading="lazy"
                  // A thumbnail that cannot load takes its image out of the gallery with it.
                  onError={() => markImageFailed(image.full)}
                  className="aspect-video h-16 object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
      <ImageLightbox
        images={gallery.map((image) => image.full)}
        index={lightbox}
        title={event.title}
        onIndexChange={(index) => {
          setLightbox(index);
          // Closing leaves the hero on the image the buyer was looking at.
          setActiveImage(index);
        }}
        onClose={() => setLightbox(null)}
      />

      {/*
        ── TICKETS FIRST ON A PHONE, BESIDE THE STORY ON A DESK ─────────────────────────
        The booking panel is first in the document, so on one column it follows the hero
        directly: "which date, which tickets, how much" is the next thing a buyer meets, not
        the last (it used to come after the description, the artists and the sessions - "I need
        to scroll a lot to reach select no of tickets"). From `lg` it moves to the right
        column and stays in view while the story scrolls past.
      */}
      <div className="mt-8 grid grid-cols-1 gap-8 px-4 sm:px-6 lg:mt-12 lg:grid-cols-3 lg:gap-12 lg:px-10">
        <div className="lg:sticky lg:top-24 lg:col-start-3 lg:row-start-1 lg:h-fit">
          <section
            id="tickets"
            aria-labelledby="tickets-heading"
            className={`${BRAND_PANEL} scroll-mt-24 p-4 sm:p-6`}
          >
            <h2 id="tickets-heading" className="font-brand-display text-brand-d3 text-brand-ink">
              {session?.seatBased && hasReservedTickets
                ? sf('event.seatedHeading')
                : sf('event.selectTickets')}
            </h2>
            {shownWhen ? (
              <p className="mt-1 text-brand-meta text-brand-ink-2">
                {shownWhen.day}, {shownWhen.time}
                {shownWhen.zone ? ` ${shownWhen.zone}` : ''} - {event.venue.name}
              </p>
            ) : null}

            {/*
              Dates, as chips, inside the booking panel: the date and the tickets are one
              decision. Only when there is more than one to choose from.
            */}
            {event.sessions.length > 1 ? (
              <div className="mt-5">
                <p className={BRAND_EYEBROW}>{sf('event.chooseDate')}</p>
                <div
                  role="group"
                  aria-label={sf('event.sessionsHeading')}
                  className="-mx-1 mt-2 flex gap-2 overflow-x-auto px-1 pb-1"
                >
                  {event.sessions.map((s) => {
                    const active = session?.id === s.id;
                    // Only from a page left open past the start: the API no longer sends these.
                    const started = new Date(s.startsAt).getTime() <= Date.now();
                    const when = venueWhen(s.startsAt, zone);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        disabled={started}
                        aria-pressed={active}
                        onClick={() => {
                          setSessionId(s.id);
                          setQty({});
                        }}
                        className={`${brandChipClasses(active)} h-11 shrink-0 disabled:opacity-40`}
                      >
                        {when.day.replace(/\s\d{4}$/, '')}, {when.time}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {futureSessions.length === 0 ? (
              <p className="mt-4 text-brand-ui text-brand-ink-2">
                {sf('event.noUpcomingSessions')}
              </p>
            ) : null}

            {dateSoldOut && (
              <div
                role="status"
                data-testid="event-sold-out"
                className="mt-5 rounded-brand-control bg-brand-sunken px-4 py-3"
              >
                <p className="text-brand-ui font-semibold text-brand-ink">
                  {eventSoldOut ? sf('event.soldOutEventTitle') : sf('event.soldOutDateTitle')}
                </p>
                <p className="mt-1 text-brand-meta text-brand-ink-2">
                  {eventSoldOut ? sf('event.soldOutEventHint') : sf('event.soldOutDateHint')}
                </p>
              </div>
            )}

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
                <div className="mt-5 space-y-5">
                  {hasReservedTickets && (
                    <>
                      <p className="text-brand-ui text-brand-ink-2">{sf('event.seatedLead')}</p>
                      <Link
                        href={`/shows/${session.id}`}
                        className={`${brandButtonClasses('primary', 'lg')} w-full`}
                      >
                        {sf('event.chooseSeats')}
                      </Link>
                    </>
                  )}
                  {zoneTicketTypes.length > 0 && (
                    <ul className="divide-y divide-brand-line">
                      {zoneTicketTypes.map((ticketType) => {
                        const unavailable =
                          ticketType.available <= 0 ||
                          ticketType.saleState === 'CLOSED' ||
                          ticketType.saleState === 'NOT_YET';
                        return ticketRow({
                          id: ticketType.id,
                          name: ticketType.name,
                          meta: (
                            <TicketAvailability
                              available={ticketType.available}
                              saleState={ticketType.saleState}
                              salesStartAt={ticketType.salesStartAt}
                              zone={zone}
                            />
                          ),
                          price: money(
                            ticketType.priceMinor,
                            ticketType.currency,
                            undefined,
                            cardFractionDigits,
                          ),
                          value: qty[ticketType.id] ?? 0,
                          max: unavailable
                            ? 0
                            : Math.min(ticketType.maxPerOrder, ticketType.available),
                          disabled: unavailable,
                          onChange: (n) =>
                            setQty((previous) => ({ ...previous, [ticketType.id]: n })),
                        });
                      })}
                    </ul>
                  )}
                  {zoneTicketTypes.length > 0 && (
                    <>
                      <PriceBreakdown
                        brand
                        free={event.isFree}
                        quote={quoteQ.data?.fees}
                        loading={quoteQ.isFetching}
                        fallbackTotalMinor={ticketSubtotal}
                        fallbackCurrency={zoneTicketTypes[0]?.currency}
                        fractionDigits={cardFractionDigits}
                      />
                      {(guest.asGuest || guest.needsContact) && (
                        <GuestBuyerFields
                          state={guest}
                          variant={guest.asGuest ? 'guest' : 'account'}
                        />
                      )}
                      {error && (
                        <p role="alert" className="text-brand-meta text-brand-critical">
                          {error}
                        </p>
                      )}
                      <BrandButton
                        size="lg"
                        className="w-full"
                        disabled={
                          zoneTicketTypes.every((ticketType) => (qty[ticketType.id] ?? 0) === 0) ||
                          book.isPending
                        }
                        aria-busy={book.isPending || undefined}
                        onClick={() => startBooking(false)}
                      >
                        {book.isPending
                          ? sf('event.holdingTickets')
                          : sf('event.continueToPayment')}
                      </BrandButton>
                    </>
                  )}
                </div>
              )
            ) : (
              <>
                {(session?.ticketTypes.length ?? 0) > 0 && (
                  <ul className="mt-5 divide-y divide-brand-line" data-testid="ticket-selection">
                    {session!.ticketTypes.map((t) => {
                      const unavailable =
                        t.available <= 0 || t.saleState === 'CLOSED' || t.saleState === 'NOT_YET';
                      return ticketRow({
                        id: t.id,
                        name: t.name,
                        meta: (
                          <TicketAvailability
                            available={t.available}
                            saleState={t.saleState}
                            salesStartAt={t.salesStartAt}
                            zone={zone}
                          />
                        ),
                        /*
                          "Free" rather than "Rs 0.00". A zero with a currency symbol reads as a
                          price that failed to load, and it is the one thing about this event a
                          buyer most wants confirmed before they commit to a seat.
                        */
                        price: event.isFree
                          ? tx('state.free')
                          : money(t.priceMinor, t.currency, undefined, cardFractionDigits),
                        value: qty[t.id] ?? 0,
                        max: unavailable ? 0 : Math.min(t.maxPerOrder, t.available),
                        disabled: unavailable,
                        onChange: (n) => setQty((p) => ({ ...p, [t.id]: n })),
                      });
                    })}
                  </ul>
                )}

                {/* Upsell: add-ons (v1.3) */}
                {addOns.length > 0 && !dateSoldOut && (
                  <div className="mt-6">
                    <p className={BRAND_EYEBROW}>{sf('event.enhance')}</p>
                    <ul className="mt-3 divide-y divide-brand-line">
                      {addOns.map((a) =>
                        ticketRow({
                          id: a.id,
                          name: a.name,
                          meta: a.soldOut ? (
                            <BrandStatusPill status="neutral">
                              {tx('state.soldOut')}
                            </BrandStatusPill>
                          ) : null,
                          price: money(a.priceMinor, a.currency, undefined, cardFractionDigits),
                          value: addOnQty[a.id] ?? 0,
                          max: Math.max(
                            0,
                            a.remaining === null
                              ? a.maxPerOrder
                              : Math.min(a.maxPerOrder, a.remaining),
                          ),
                          disabled: a.soldOut,
                          onChange: (n) => setAddOnQty((p) => ({ ...p, [a.id]: n })),
                        }),
                      )}
                    </ul>
                  </div>
                )}

                {/* Cross-sell: bundles (v1.3) */}
                {bundles.length > 0 && !dateSoldOut && (
                  <div className="mt-6">
                    <p className={BRAND_EYEBROW}>{sf('event.bundlesHeading')}</p>
                    <ul className="mt-3 divide-y divide-brand-line">
                      {bundles.map((bundle) =>
                        ticketRow({
                          id: bundle.id,
                          name: bundle.name,
                          meta:
                            bundle.savingsMinor > 0 ? (
                              <BrandStatusPill status="positive">
                                {sf('event.bundleSave', {
                                  amount: money(
                                    bundle.savingsMinor,
                                    bundle.currency,
                                    undefined,
                                    cardFractionDigits,
                                  ),
                                })}
                              </BrandStatusPill>
                            ) : null,
                          extra:
                            bundle.components.length > 0 ? (
                              <p className="mt-1 text-brand-meta text-brand-ink-3">
                                {sf('event.bundleIncludes', {
                                  items: bundle.components
                                    .map((c) => `${c.quantity}x ${c.label}`)
                                    .join(', '),
                                })}
                              </p>
                            ) : null,
                          price: money(
                            bundle.priceFromMinor,
                            bundle.currency,
                            undefined,
                            cardFractionDigits,
                          ),
                          value: bundleQty[bundle.id] ?? 0,
                          max: bundle.maxPerOrder,
                          disabled: false,
                          onChange: (n) => setBundleQty((p) => ({ ...p, [bundle.id]: n })),
                        }),
                      )}
                    </ul>
                  </div>
                )}

                {/* Above the breakdown, because it can change what the breakdown says. */}
                {!event.isFree && !dateSoldOut && (
                  <div className="mt-6">
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

                {!dateSoldOut && (
                  <div className="mt-6">
                    <PriceBreakdown
                      brand
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
                      // Decided above, from everything on this card - see `cardFractionDigits`.
                      fractionDigits={cardFractionDigits}
                    />
                  </div>
                )}

                {/*
                  Name and email, for somebody with no account. Below the price and above the
                  button, which is the order the buyer reads: what it costs, who it is for,
                  then pay.
                */}
                {!dateSoldOut && (guest.asGuest || guest.needsContact) && (
                  <div className="mt-6">
                    <GuestBuyerFields state={guest} variant={guest.asGuest ? 'guest' : 'account'} />
                  </div>
                )}

                {error && (
                  <p role="alert" className="mt-4 text-brand-meta text-brand-critical">
                    {error}
                  </p>
                )}
                {/* Nothing to continue to when nothing is left; the notice above says so. */}
                {!dateSoldOut && (
                  <div id={CONTINUE_ANCHOR_ID} className="mt-6">
                    <BrandButton
                      size="lg"
                      className="w-full"
                      aria-busy={(book.isPending && !payWithCash) || undefined}
                      disabled={totalQty === 0 || book.isPending || sessionStarted}
                      onClick={() => startBooking(false)}
                    >
                      {continueLabel}
                    </BrandButton>
                  </div>
                )}

                {/*
                  Offered only when the organizer takes cash, and never for a free event
                  where there is nothing to collect. A second BUTTON rather than a radio
                  group: the choice is the action, and making somebody pick an option and
                  then press Continue is a step that earns nothing.
                */}
                {event.cashAccepted && !event.isFree && !dateSoldOut && (
                  <>
                    <BrandButton
                      variant="secondary"
                      size="lg"
                      className="mt-3 w-full"
                      aria-busy={(book.isPending && payWithCash) || undefined}
                      disabled={totalQty === 0 || book.isPending || sessionStarted}
                      onClick={() => startBooking(true)}
                    >
                      {b('payAtVenue')}
                    </BrandButton>
                    <p className="mt-2 text-brand-meta text-brand-ink-3">{b('payAtVenueHint')}</p>
                  </>
                )}
              </>
            )}
            {terms.hasTerms && !sessionStarted && <TermsAgreeNote onOpen={terms.open} />}
          </section>
        </div>

        {/* The story: what it is, who is on, where, who runs it, and what others thought. */}
        <div className="space-y-12 lg:col-span-2 lg:row-start-1">
          <EventFacts
            event={event}
            when={shownWhen}
            minutes={minutes}
            note={sf('event.venueTimeNote')}
          />

          {event.description && (
            <section aria-labelledby="about-heading" className="max-w-prose">
              <h2 id="about-heading" className="font-brand-display text-brand-d2 text-brand-ink">
                {sf('event.about')}
              </h2>
              <p className="mt-4 whitespace-pre-line text-brand-body text-brand-ink-2">
                {event.description}
              </p>
            </section>
          )}

          <ArtistsCard artists={event.artists} />

          <div className="grid gap-6 sm:grid-cols-2">
            <section aria-labelledby="venue-heading" className={`${BRAND_PANEL} p-6`}>
              <h2 id="venue-heading" className={BRAND_EYEBROW}>
                {sf('event.venueHeading')}
              </h2>
              <p className="mt-3 font-brand-display text-brand-card text-brand-ink">
                {event.venue.name}
              </p>
              {/*
                Composed, not concatenated. The city, state and country are their own columns
                and `address` is one free-text box, so an organizer who types the whole address
                into it - which is what the word invites - used to get it printed twice:
                "Worli, Mumbai, MH, Mumbai, India". See `venueAddressLine`.
              */}
              <p className="mt-1 text-brand-ui text-brand-ink-2">{venueAddressLine(event.venue)}</p>
              {/*
                Directions open the map app the buyer already has. Venues store an address and
                no coordinates, so there is nothing to draw here, and an empty "map preview" box
                is a promise rendered as a grey rectangle.
              */}
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                  venueMapQuery(event.venue),
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                className={`${brandButtonClasses('secondary', 'md')} mt-4`}
              >
                <MapPin className="h-4 w-4" aria-hidden />
                {sf('event.getDirections')}
                <span className="sr-only">{sf('event.opensInNewTab')}</span>
              </a>
            </section>
            <OrganizerCard organizer={event.organizer} />
          </div>

          {/*
            Who to ask. The organizer runs the event; the platform holds the booking and the
            money. A buyer about to pay should see both, and how to reach us, before they pay.
            The address is the published one (BUSINESS_DETAILS); while none is published the
            contact page stands in, which always reaches a person.
          */}
          <section aria-labelledby="support-heading" className={`${BRAND_PANEL} p-6`}>
            <h2 id="support-heading" className="font-brand-display text-brand-d3 text-brand-ink">
              {sf('event.supportHeading')}
            </h2>
            <p className="mt-2 max-w-prose text-brand-ui text-brand-ink-2">
              {sf('event.supportBody', { organizer: event.organizer.name })}
            </p>
            {event.refundPolicy ? (
              <div className="mt-4 border-t border-brand-line pt-4">
                <h3 className="text-brand-ui font-semibold text-brand-ink">
                  {sf('event.refundPolicy')}
                </h3>
                <p className="mt-1 text-brand-ui text-brand-ink-2">{event.refundPolicy}</p>
              </div>
            ) : null}
            <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-brand-ui">
              {supportEmail ? (
                <li>
                  <a href={`mailto:${supportEmail}`} className={BRAND_LINK}>
                    {sf('event.supportEmail', { email: supportEmail })}
                  </a>
                </li>
              ) : null}
              <li>
                <Link href="/help" className={BRAND_LINK}>
                  {sf('event.supportHelp')}
                </Link>
              </li>
              <li>
                <Link href="/help/contact" className={BRAND_LINK}>
                  {sf('event.supportContact')}
                </Link>
              </li>
              {terms.hasTerms ? (
                <li>
                  <TermsRow onOpen={terms.open} />
                </li>
              ) : null}
            </ul>
          </section>
          {terms.dialog}

          {/* Reviews */}
          <section aria-labelledby="reviews-heading">
            <h2 id="reviews-heading" className="font-brand-display text-brand-d2 text-brand-ink">
              {sf('event.reviews')}
            </h2>
            <div className="mt-4">
              {reviews.isLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-16 w-40" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : reviews.data && reviews.data.count > 0 ? (
                <div className="space-y-5">
                  <div className="flex items-center gap-6">
                    <div>
                      <p className="text-brand-figure tabular-nums text-brand-ink">
                        {reviews.data.average.toFixed(1)}
                      </p>
                      <RatingStars value={Math.round(reviews.data.average)} size="sm" />
                      <p className="mt-1 text-brand-meta text-brand-ink-3">
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
                          <div key={star} className="flex items-center gap-2 text-brand-meta">
                            <span className="w-3 tabular-nums text-brand-ink-3">{star}</span>
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-brand-sunken">
                              <div
                                className="h-full rounded-full bg-brand-ink"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <ul className="divide-y divide-brand-line">
                    {reviews.data.items.map((r) => (
                      <li key={r.id} className="py-4">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-brand-ui font-semibold text-brand-ink">
                            {r.author}
                          </span>
                          <RatingStars value={r.rating} size="sm" />
                        </div>
                        {r.comment && (
                          <p className="mt-1 text-brand-ui text-brand-ink-2">{r.comment}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-brand-ui text-brand-ink-2">{sf('event.noReviews')}</p>
              )}

              {/* Write a review */}
              {authed && (
                <div className={`${BRAND_PANEL} mt-6 p-4`}>
                  <p className="text-brand-ui font-semibold text-brand-ink">
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
                  <BrandButton
                    variant="secondary"
                    className="mt-3"
                    aria-busy={submitReview.isPending || undefined}
                    disabled={rating < 1 || submitReview.isPending}
                    onClick={() => submitReview.mutate()}
                  >
                    {mine.data ? sf('event.updateReview') : sf('event.submitReview')}
                  </BrandButton>
                  <p className="mt-2 text-brand-meta text-brand-ink-3">
                    {sf('event.reviewEligibility')}
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* FAQ */}
          <section aria-labelledby="faq-heading">
            <h2 id="faq-heading" className="font-brand-display text-brand-d2 text-brand-ink">
              {sf('event.faq')}
            </h2>
            <div className="mt-4 divide-y divide-brand-line border-y border-brand-line">
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
                <details key={f.q} className="group">
                  <summary
                    className={`flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 rounded-sm py-3 text-brand-body font-semibold text-brand-ink ${BRAND_FOCUS}`}
                  >
                    {f.q}
                    <ChevronRight
                      className="h-4 w-4 shrink-0 text-brand-ink-3 transition-transform group-open:rotate-90"
                      aria-hidden
                    />
                  </summary>
                  <p className="pb-4 text-brand-ui text-brand-ink-2">{f.a}</p>
                </details>
              ))}
            </div>
          </section>
        </div>
      </div>

      <StickyContinue
        visible={!session?.seatBased && !sessionStarted && !dateSoldOut && totalQty > 0}
        count={totalQty}
        total={
          !event.isFree && quoteQ.data?.fees && !quoteQ.isFetching
            ? money(
                quoteQ.data.fees.totalMinor,
                quoteQ.data.fees.currency,
                undefined,
                cardFractionDigits,
              )
            : null
        }
        label={continueLabel}
        pending={book.isPending && !payWithCash}
        disabled={book.isPending}
        onContinue={() => startBooking(false)}
      />

      {/* You might also like — recommendations seeded by this event. */}
      {recommendations.isLoading ? (
        <section className="mt-16 space-y-4 px-4 sm:px-6 lg:px-10">
          <h2 className="font-brand-display text-brand-d2 text-brand-ink">
            {sf('event.recommendations')}
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-64 w-full rounded-lg" />
            ))}
          </div>
        </section>
      ) : recommendations.data && recommendations.data.length > 0 ? (
        <section className="mt-16 space-y-6 px-4 sm:px-6 lg:px-10">
          <h2 className="font-brand-display text-brand-d2 text-brand-ink">
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
