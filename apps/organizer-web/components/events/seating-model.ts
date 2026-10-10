import type { EventSession, VenueSpace } from '@eticketsgo/web-kit';

/**
 * One session's seating, as data: what kind it is, where, which layout VERSION, what it has
 * sold, and whether - and why not - its seating can still change.
 *
 * ── NOTHING HERE DECIDES ANYTHING ─────────────────────────────────────────────────
 * The server is the only judge of whether seating may change (`updateSessionSeating` refuses
 * once anything is sold or held, inside its transaction). This reads the same inventory the
 * server counts so the page can say the reason BEFORE somebody presses a button that can only
 * fail - and if the two ever disagree, the server's refusal is shown word for word.
 */

export interface LayoutVersion {
  id: string;
  name: string | null;
  version: number;
  status?: string;
}

export interface SeatingCategory {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
  total: number;
  sold: number;
  held: number;
  status: string;
  /** The server refuses a price change once a ticket of this type has sold. */
  priceLocked: boolean;
}

export type SeatingOwner =
  | { kind: 'cinema'; name: string; cinemaId: string | null; layoutsHref: string | null }
  | { kind: 'space'; layoutsHref: string };

export interface SessionSeating {
  kind: 'reserved' | 'ga';
  /** "Demo Arena, Main Arena". Null for general admission. */
  place: string | null;
  layout: LayoutVersion | null;
  /** A newer published version of the same named layout, when one exists. */
  newer: LayoutVersion | null;
  owner: SeatingOwner | null;
  categories: SeatingCategory[];
  counts: { capacity: number; sold: number; held: number; available: number };
  /** Whether the organizer may try to change this session's seating, and if not, why not. */
  change: { allowed: true } | { allowed: false; reason: string };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Basketball, version 3" - or "version 3" when the layout has no name. */
export function layoutLabel(layout: LayoutVersion | null): string {
  if (!layout) return 'its current layout';
  return layout.name && layout.name !== 'Default'
    ? `${layout.name}, version ${layout.version}`
    : `version ${layout.version}`;
}

/**
 * Find the session's space in the organization's space list, and with it the cinema that owns
 * it (if any) and the CURRENT version of each named layout.
 */
export function spaceFor(
  session: Pick<EventSession, 'screenId'>,
  spaces: VenueSpace[] | undefined,
): VenueSpace | null {
  if (!session.screenId || !spaces) return null;
  return spaces.find((s) => s.id === session.screenId) ?? null;
}

/** A space's layout versions as `GET /screens/:id/seat-layouts` lists them. */
export interface LayoutRow {
  id: string;
  name: string | null;
  version: number;
  status: string;
  clonedFromId: string | null;
}

/**
 * The version a session is pinned to, and a newer published one that supersedes it.
 *
 * "Newer" means descended from it - a clone of it, or of a clone of it - or carrying the same
 * name, at a higher version and PUBLISHED. Cloning names the copy ("Concert v2"), so matching
 * by name alone missed the ordinary case; lineage is what the layout list records.
 *
 * `fallback` is the layout's own preview read, for when the list could not be loaded.
 */
export function resolveLayout(
  seatMapId: string | null | undefined,
  layouts: LayoutRow[] | undefined,
  fallback?: LayoutVersion,
): { layout: LayoutVersion | null; newer: LayoutVersion | null } {
  if (!seatMapId) return { layout: null, newer: null };
  const pinned = layouts?.find((l) => l.id === seatMapId);
  if (!pinned) return { layout: fallback ?? null, newer: null };
  const byId = new Map(layouts!.map((l) => [l.id, l]));
  const descends = (l: LayoutRow) => {
    const seen = new Set<string>();
    let at: LayoutRow | undefined = l;
    while (at?.clonedFromId && !seen.has(at.id)) {
      seen.add(at.id);
      if (at.clonedFromId === pinned.id) return true;
      at = byId.get(at.clonedFromId);
    }
    return false;
  };
  const newer = layouts!
    .filter(
      (l) =>
        l.status === 'PUBLISHED' &&
        l.version > pinned.version &&
        (descends(l) || (l.name ?? null) === (pinned.name ?? null)),
    )
    .sort((a, b) => b.version - a.version)[0];
  const view = (l: LayoutRow): LayoutVersion => ({
    id: l.id,
    name: l.name,
    version: l.version,
    status: l.status,
  });
  return { layout: view(pinned), newer: newer ? view(newer) : null };
}

export function sessionSeating(input: {
  session: EventSession;
  space: VenueSpace | null;
  layout: LayoutVersion | null;
  newer?: LayoutVersion | null;
  now: number;
}): SessionSeating {
  const { session, space, layout, now } = input;
  const newer = input.newer ?? null;
  const reserved = !!session.screenId;

  const categories: SeatingCategory[] = (session.ticketTypes ?? []).map((t) => {
    const sold = t.inventory?.quantitySold ?? 0;
    return {
      id: t.id,
      name: t.name,
      priceMinor: t.priceMinor,
      currency: t.currency,
      total: t.inventory?.quantityTotal ?? t.quantityTotal,
      sold,
      held: t.inventory?.quantityHeld ?? 0,
      status: t.status,
      priceLocked: sold > 0,
    };
  });
  const capacity = categories.reduce((n, c) => n + c.total, 0);
  const sold = categories.reduce((n, c) => n + c.sold, 0);
  const held = categories.reduce((n, c) => n + c.held, 0);
  const counts = { capacity, sold, held, available: Math.max(0, capacity - sold - held) };

  const place = reserved
    ? [session.screen?.venue?.name ?? session.screen?.cinema?.name, session.screen?.name]
        .filter(Boolean)
        .join(', ') || 'A space in your organization'
    : null;

  let owner: SeatingOwner | null = null;
  if (reserved) {
    const cinemaName = space?.cinemaName ?? session.screen?.cinema?.name ?? null;
    const cinemaId = space?.cinemaId ?? null;
    owner = cinemaName
      ? {
          kind: 'cinema',
          name: cinemaName,
          cinemaId,
          layoutsHref: cinemaId
            ? `/organizer/cinemas/${cinemaId}/screens/${session.screenId}/layouts`
            : null,
        }
      : { kind: 'space', layoutsHref: `/organizer/spaces/${session.screenId}/layouts` };
  }

  return {
    kind: reserved ? 'reserved' : 'ga',
    place,
    layout,
    newer,
    owner,
    categories,
    counts,
    change: changeRule({ session, reserved, layout, sold, held, now }),
  };
}

function changeRule(input: {
  session: Pick<EventSession, 'status' | 'endsAt'>;
  reserved: boolean;
  layout: LayoutVersion | null;
  sold: number;
  held: number;
  now: number;
}): SessionSeating['change'] {
  const { session, reserved, layout, sold, held } = input;
  if (session.status === 'CANCELLED')
    return { allowed: false, reason: 'This show is cancelled, so its seating stays as it was.' };
  if (new Date(session.endsAt).getTime() <= input.now)
    return { allowed: false, reason: 'This show has ended, so its seating stays as it was.' };
  if (sold > 0) {
    const what = reserved
      ? plural(sold, 'seat has', 'seats have')
      : plural(sold, 'ticket has', 'tickets have');
    return {
      allowed: false,
      reason: reserved
        ? `${what} been sold for this show, so its layout is locked to ${layoutLabel(layout)}. Create a new show to use a different layout.`
        : `${what} been sold for this show, so it stays general admission. Create a new show to sell numbered seats.`,
    };
  }
  if (held > 0)
    return {
      allowed: false,
      reason: `${plural(held, reserved ? 'seat is' : 'ticket is', reserved ? 'seats are' : 'tickets are')} held in a checkout right now. Seating can change only while nothing is sold or held, so try again when that checkout ends.`,
    };
  return { allowed: true };
}

export type SessionFilter = 'upcoming' | 'past' | 'all';

/** Sessions for the Seating page: upcoming soonest first, past most recent first. */
export function filterSessions(
  sessions: EventSession[],
  filter: SessionFilter,
  now: number,
): EventSession[] {
  const ended = (s: EventSession) => new Date(s.endsAt).getTime() <= now;
  if (filter === 'upcoming')
    return sessions
      .filter((s) => !ended(s) && s.status !== 'CANCELLED')
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  if (filter === 'past')
    return sessions
      .filter((s) => ended(s) || s.status === 'CANCELLED')
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  return [...sessions].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** "2 reserved seating, 1 general admission" - how the event is seated, in one line. */
export function seatingMix(sessions: Pick<EventSession, 'screenId' | 'status'>[]): string {
  const live = sessions.filter((s) => s.status !== 'CANCELLED');
  const reserved = live.filter((s) => s.screenId).length;
  const ga = live.length - reserved;
  if (live.length === 0) return 'No sessions yet';
  const parts = [];
  if (reserved) parts.push(`${reserved} reserved seating`);
  if (ga) parts.push(`${ga} general admission`);
  return parts.join(', ');
}
