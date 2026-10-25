/**
 * schema.org JSON-LD for the storefront, built only from facts we hold.
 *
 * -- THE RULE ---------------------------------------------------------------------------
 * Search engines show structured data to people as fact: a price, a date, "Sold out", a
 * star rating. So every field here comes from the public API's own answer or from the
 * company record in code, and a field we do not have is LEFT OUT, never filled with a guess.
 * No ratings, no reviews, no addresses we were not given, no availability the API did not
 * state. Pure functions, so the tests can pin exactly that.
 */

type JsonLd = Record<string, unknown>;

/** JSON-LD for a `<script>` tag. `<` is escaped so a `</script>` in an organizer's text cannot end the tag. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export function buildOrganizationJsonLd(input: {
  siteUrl: string;
  /** The company behind the brand, from the entity registry. */
  legalName?: string | null;
  /** A published support mailbox. */
  email?: string | null;
}): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${input.siteUrl}/#organization`,
    name: 'ETicketsGo',
    url: `${input.siteUrl}/`,
    logo: `${input.siteUrl}/icon-512.png`,
    ...(input.legalName ? { legalName: input.legalName } : {}),
    ...(input.email
      ? {
          email: input.email,
          contactPoint: [
            { '@type': 'ContactPoint', contactType: 'customer support', email: input.email },
          ],
        }
      : {}),
  };
}

/**
 * The site, with its search box. `/events?q=` is a real search: the events page reads `q`
 * from the URL and the API matches it against title, organizer, venue and city.
 */
export function buildWebSiteJsonLd(input: { siteUrl: string }): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${input.siteUrl}/#website`,
    name: 'ETicketsGo',
    url: `${input.siteUrl}/`,
    publisher: { '@id': `${input.siteUrl}/#organization` },
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${input.siteUrl}/events?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}

/** The parts of `GET /public/events/:slug` the Event markup reads. */
export interface EventForStructuredData {
  title: string;
  slug: string;
  description?: string | null;
  isFree?: boolean;
  imagePath?: string | null;
  imageVariants?: Partial<Record<string, string>> | null;
  venue?: {
    name?: string | null;
    city?: string | null;
    country?: string | null;
    region?: string | null;
    address?: string | null;
  } | null;
  timeZone?: string | null;
  organizer?: { name?: string | null; website?: string | null } | null;
  sessions?: {
    id: string;
    startsAt: string;
    endsAt?: string | null;
    status?: string | null;
    timeZone?: string | null;
    seatBased?: boolean;
    ticketTypes?: {
      priceMinor: number;
      currency: string;
      available?: number | null;
      saleState?: 'ON_SALE' | 'NOT_YET' | 'CLOSED';
    }[];
  }[];
}

/**
 * An instant written in the venue's own clock with its offset (`2026-11-02T19:30:00+05:30`),
 * which is how a reader expects to see the time. Falls back to UTC (`...Z`, itself a valid
 * offset) when the zone is missing or unknown.
 */
export function isoWithOffset(instant: string, timeZone?: string | null): string | null {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  if (!timeZone) return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(date)
        .map((p) => [p.type, p.value]),
    );
    const wall = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const offsetMin = Math.round((wall - Math.floor(date.getTime() / 1000) * 1000) / 60000);
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hh}:${mm}`;
  } catch {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

/** Minor units to a decimal string in the currency's own precision (INR 45000 -> "450.00"). */
export function majorUnits(priceMinor: number, currency: string): string | null {
  if (!Number.isFinite(priceMinor) || priceMinor < 0) return null;
  let digits = 2;
  try {
    digits =
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    return null;
  }
  return (priceMinor / 10 ** digits).toFixed(digits);
}

type Session = NonNullable<EventForStructuredData['sessions']>[number];

/**
 * Availability, only where the API said it plainly: a general-admission session whose ticket
 * types all report their sale window and a count. Seat-map sessions count seats elsewhere, a
 * paused session is not "in stock", and an answer we would have to infer is omitted.
 */
function availabilityOf(session: Session): string | null {
  const types = session.ticketTypes ?? [];
  if (types.length === 0 || session.seatBased || session.status !== 'SCHEDULED') return null;
  if (types.some((t) => t.saleState === undefined || typeof t.available !== 'number')) return null;
  const onSale = types.filter((t) => t.saleState === 'ON_SALE');
  if (onSale.some((t) => (t.available ?? 0) > 0)) return 'https://schema.org/InStock';
  if (onSale.length === types.length && onSale.every((t) => t.available === 0)) {
    return 'https://schema.org/SoldOut';
  }
  return null;
}

function offersFor(session: Session, url: string): JsonLd | null {
  const types = session.ticketTypes ?? [];
  if (types.length === 0) return null;
  const currency = types[0].currency;
  // Prices in two currencies cannot be one offer; say nothing rather than mix them.
  if (!currency || types.some((t) => t.currency !== currency)) return null;
  const minors = types.map((t) => t.priceMinor);
  const low = majorUnits(Math.min(...minors), currency);
  const high = majorUnits(Math.max(...minors), currency);
  if (low === null || high === null) return null;
  const availability = availabilityOf(session);
  const common = { priceCurrency: currency, url, ...(availability ? { availability } : {}) };
  return types.length === 1
    ? { '@type': 'Offer', price: low, ...common }
    : {
        '@type': 'AggregateOffer',
        lowPrice: low,
        highPrice: high,
        offerCount: types.length,
        ...common,
      };
}

function absolute(base: string, path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Event markup for an event page: one Event per upcoming date (Google's guidance for an
 * event that runs on several dates), capped. An event with no upcoming date gets none,
 * because an Event without a start date is not valid and we will not make one up.
 */
export function buildEventJsonLd(
  event: EventForStructuredData,
  ctx: { pageUrl: string; apiUrl: string; maxSessions?: number },
): JsonLd[] {
  const sessions = (event.sessions ?? []).slice(0, ctx.maxSessions ?? 10);
  if (!event.title || sessions.length === 0) return [];

  const images = [
    ...new Set(
      [event.imageVariants?.full, event.imageVariants?.banner, event.imagePath]
        .map((p) => absolute(ctx.apiUrl, p))
        .filter((u): u is string => Boolean(u)),
    ),
  ];
  const venue = event.venue;
  const address =
    venue && (venue.address || venue.city || venue.country)
      ? {
          '@type': 'PostalAddress',
          ...(venue.address ? { streetAddress: venue.address } : {}),
          ...(venue.city ? { addressLocality: venue.city } : {}),
          ...(venue.region ? { addressRegion: venue.region } : {}),
          ...(venue.country ? { addressCountry: venue.country } : {}),
        }
      : null;
  const location = venue?.name
    ? { '@type': 'Place', name: venue.name, ...(address ? { address } : {}) }
    : null;
  const description = event.description?.trim();
  const organizerName = event.organizer?.name?.trim();
  const organizerUrl =
    event.organizer?.website && /^https?:\/\//i.test(event.organizer.website)
      ? event.organizer.website
      : null;

  return sessions.flatMap((s) => {
    const zone = s.timeZone ?? event.timeZone ?? null;
    const startDate = isoWithOffset(s.startsAt, zone);
    if (!startDate) return [];
    const endDate = s.endsAt ? isoWithOffset(s.endsAt, zone) : null;
    const offers = offersFor(s, ctx.pageUrl);
    const scheduled = s.status === 'SCHEDULED' || s.status === 'PAUSED';
    return [
      {
        '@context': 'https://schema.org',
        '@type': 'Event',
        name: event.title,
        url: ctx.pageUrl,
        startDate,
        ...(endDate ? { endDate } : {}),
        ...(scheduled ? { eventStatus: 'https://schema.org/EventScheduled' } : {}),
        ...(location
          ? { eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode', location }
          : {}),
        ...(images.length ? { image: images } : {}),
        ...(description ? { description } : {}),
        ...(organizerName
          ? {
              organizer: {
                '@type': 'Organization',
                name: organizerName,
                ...(organizerUrl ? { url: organizerUrl } : {}),
              },
            }
          : {}),
        ...(offers ? { offers } : {}),
      },
    ];
  });
}
