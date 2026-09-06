import { HttpStatus } from '@nestjs/common';
import { AppException, ErrorCodes } from '../../common/errors';

/**
 * Cinema-shaped capabilities a REMOTE inventory source may additionally offer.
 *
 * ── WHY THESE ARE NOT ON `InventoryProvider` ───────────────────────────────────────
 * `InventoryProvider` (ADR-037) is the *inventory authority* contract: who owns the
 * stock, and how it is checked, held, confirmed, cancelled, refunded, synced. Every
 * source answers all of that — a general-admission conference, a stadium, a cinema.
 *
 * A remote cinema POS additionally publishes a CATALOGUE (its cinemas, its films, its
 * showtimes) and a SEAT MAP. Most inventory sources have neither: a manual portal-entered
 * event has no upstream catalogue to read, and a general-admission provider has no seats.
 * Putting `getShows()` on the base interface would force every provider to implement a
 * method it can only throw from, which is how a uniform surface degrades into a list of
 * operations you have to know not to call.
 *
 * So they are separate, optional interfaces. A provider that has them implements them; a
 * caller asks with the type guards below rather than assuming. `InventoryProvider` stays
 * the single authority contract and this stays an extension of it — not a competing
 * hierarchy with its own registry, resolver and health model.
 *
 * ── WHAT THESE ARE NOT ─────────────────────────────────────────────────────────────
 * They are not a second seat-layout model. ETicketsGo already owns seat maps, layout
 * versioning and seat kinds; these types describe what a REMOTE system said, in that remote
 * system's own identifiers, so the sync layer can map it onto ours. Nothing here is
 * rendered to a customer or used to price anything.
 */

/** A film as an external system describes it. External ids are the identity, never the title. */
export interface ExternalMovie {
  /** Stable, provider-scoped. The only thing safe to key a mapping on. */
  externalId: string;
  title: string;
  /** ISO 639-1 where the provider gives one; free text otherwise. */
  language?: string;
  runtimeMinutes?: number;
  certificate?: string;
  releaseDate?: string;
  posterUrl?: string;
  /**
   * Whatever else the provider sent, kept verbatim for debugging a mapping that went wrong.
   * NEVER rendered to a customer, and never a place for credentials — see the sync layer's
   * raw-event storage, which has the same rule.
   */
  raw?: Record<string, unknown>;
}

export interface ExternalCinema {
  externalId: string;
  name: string;
  city?: string;
  /**
   * IANA zone. Required in practice for anything with showtimes: a wall-clock time with no
   * zone is not a time, and the venue's zone is authoritative — never the server's.
   */
  timezone?: string;
  raw?: Record<string, unknown>;
}

export interface ExternalScreen {
  externalId: string;
  cinemaExternalId: string;
  name: string;
  raw?: Record<string, unknown>;
}

export interface ExternalShow {
  externalId: string;
  cinemaExternalId: string;
  screenExternalId: string;
  movieExternalId: string;
  /** An absolute instant. The provider's local wall-clock time resolved through its zone. */
  startsAt: Date;
  endsAt?: Date;
  /** ISO-4217. A provider that prices in one currency still has to say which. */
  currency?: string;
  raw?: Record<string, unknown>;
}

/** How a remote system reports one seat right now. */
export type ExternalSeatState = 'AVAILABLE' | 'HELD' | 'SOLD' | 'BLOCKED';

export interface ExternalSeat {
  externalId: string;
  /** What is printed on the seat, e.g. "F10". Display only — never an identity key. */
  label: string;
  row: string;
  /** 1-based position within the row, as the venue numbers it. */
  number: number;
  /** The provider's own category name, e.g. "Recliner". Mapped, never assumed. */
  categoryExternalId: string;
  state: ExternalSeatState;
  /** A gap, an aisle or a wheelchair space — a position that is not an ordinary seat. */
  kind?: 'SEAT' | 'GAP' | 'WHEELCHAIR' | 'COMPANION';
}

export interface ExternalSeatCategory {
  externalId: string;
  name: string;
  /**
   * What the provider says this seat costs, in minor units.
   *
   * Advisory. ETicketsGo prices its own sales through the existing pricing, fee and tax
   * engine; this is here so an operator can see what the remote system believes and
   * reconcile a disagreement, NOT so it can be charged to anybody directly.
   */
  priceMinor?: number;
  currency?: string;
}

export interface ExternalSeatMap {
  showExternalId: string;
  categories: ExternalSeatCategory[];
  seats: ExternalSeat[];
  /** When the provider produced this view. Remote seat state is always a moment ago. */
  asOf: Date;
}

/** A provider that publishes its own cinemas, films and showtimes. */
export interface CinemaCatalogueCapability {
  getCinemas(): Promise<ExternalCinema[]>;
  getScreens(cinemaExternalId?: string): Promise<ExternalScreen[]>;
  getMovies(cinemaExternalId?: string): Promise<ExternalMovie[]>;
  getShows(params: {
    cinemaExternalId?: string;
    movieExternalId?: string;
    /** A calendar date in the CINEMA's zone, `YYYY-MM-DD`. Never the server's day. */
    date?: string;
  }): Promise<ExternalShow[]>;
}

/** A provider that publishes a per-show seat layout and live seat state. */
export interface SeatMapCapability {
  getSeatMap(showExternalId: string): Promise<ExternalSeatMap>;
}

/*
  Type guards rather than a capability flag, so "can I call this?" and "does this method
  exist?" cannot drift apart. A boolean saying `supportsSeatMap: true` on a provider with no
  `getSeatMap` compiles perfectly and fails at runtime.
*/
export function hasCinemaCatalogue(p: unknown): p is CinemaCatalogueCapability {
  const c = p as Partial<CinemaCatalogueCapability>;
  return typeof c?.getCinemas === 'function' && typeof c?.getShows === 'function';
}

export function hasSeatMap(p: unknown): p is SeatMapCapability {
  return typeof (p as Partial<SeatMapCapability>)?.getSeatMap === 'function';
}

/**
 * Refuse a reserved-seat sale through a provider that cannot describe seats.
 *
 * ── THE DEGRADATION THIS PREVENTS ──────────────────────────────────────────────────
 * `availability()` answers in UNITS per ticket type, which is the right answer for general
 * admission and an incomplete one for reserved seating. For a seated show the customer is not
 * buying "one of 120" — they are buying F10, and only a provider that can enumerate seats can
 * say whether F10 specifically is free.
 *
 * Without this guard a REMOTE provider with no seat map does not fail. It answers "120
 * available", the seat picker has nothing to draw, and either the sale proceeds against a
 * count — selling a seat the venue may have already sold — or the customer meets an empty
 * room with no explanation. Both are silent, and both are discovered at the door.
 *
 * ── WHY A GUARD RATHER THAN A METHOD ON THE BASE CONTRACT ──────────────────────────
 * Putting `getSeatMap()` on `InventoryProvider` would force a general-admission provider to
 * implement a method it can only throw from, and would make every GA source look seat-capable
 * to the type system. The requirement is not "every provider has seats" — it is "a SEATED
 * SHOW needs a seat-capable provider", which is a property of the pairing, not of either half.
 *
 * Called at the point a seated show is about to be served by a provider, so the failure is at
 * resolution rather than three steps later with a confusing symptom.
 */
export function requireSeatMapCapability(
  provider: { name: string; capabilities: { authority: string } },
  context: { eventSessionId?: string } = {},
): asserts provider is typeof provider & SeatMapCapability {
  if (hasSeatMap(provider)) return;
  throw new AppException(
    ErrorCodes.INVENTORY_SOURCE_UNSUPPORTED,
    `This showing has reserved seating, and inventory provider '${provider.name}' cannot report ` +
      'individual seats. A seated show cannot be sold against a unit count — it would be ' +
      'impossible to tell whether the chosen seat is free.',
    HttpStatus.NOT_IMPLEMENTED,
    { provider: provider.name, ...context, requiredCapability: 'SeatMapCapability' },
  );
}

/**
 * Does this show need seat-level inventory?
 *
 * Reserved seating is a property of the ROOM the session is in, not of the experience type —
 * the same decision the rest of the platform already makes. A movie in a general-admission
 * hall is not seated; a conference in a seat-mapped auditorium is.
 */
export function needsSeatLevelInventory(session: { seatBased?: boolean | null }): boolean {
  return session.seatBased === true;
}
