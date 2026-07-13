import type { Prisma } from '@prisma/client';

/**
 * A single line of inventory demand: N units of one ticket type. For seat-based
 * inventory the line also carries the specific seats selected for that type
 * (seatIds.length must equal quantity); general admission ignores seatIds.
 */
export interface InventoryLine {
  ticketTypeId: string;
  quantity: number;
  seatIds?: string[];
}

/**
 * Everything a strategy needs to reserve/confirm/release stock for one booking,
 * inside the caller's transaction. `bookingId` lets seat-based inventory stamp
 * held seats; general admission only needs `lines`.
 */
export interface ReserveContext {
  eventSessionId: string;
  bookingId: string;
  holdExpiresAt: Date;
  lines: InventoryLine[];
}

/** One ticket to issue on confirmation (optionally bound to a specific seat). */
export interface TicketIssueSpec {
  ticketTypeId: string;
  seatId?: string;
  seatLabel?: string;
}

/** A refunded ticket to return to available stock (seatId set for seat-based). */
export interface RefundLine {
  ticketTypeId: string;
  seatId?: string | null;
}

/** Context for returning refunded/voided tickets to inventory. */
export interface RefundContext {
  eventSessionId: string;
  tickets: RefundLine[];
}

/**
 * The pluggable contract every experience type's inventory model implements.
 * The booking engine depends on THIS interface, never on a concrete strategy,
 * so new experience types (movies, museums, tours) add their own inventory
 * behaviour without the booking engine changing. See ADR-010, ADR-013.
 *
 * `reserve`, `confirm` and `release` run inside a caller-provided Prisma
 * transaction (`tx`) so they compose atomically with the surrounding booking /
 * payment writes.
 */
export interface InventoryStrategy {
  readonly kind: string;

  /** Atomically hold stock for the context. MUST be oversell-/double-book-proof. */
  reserve(tx: Prisma.TransactionClient, ctx: ReserveContext): Promise<void>;

  /**
   * Convert a held reservation into a confirmed sale and return the exact set of
   * tickets to issue (one spec per unit / per seat).
   */
  confirm(tx: Prisma.TransactionClient, ctx: ReserveContext): Promise<TicketIssueSpec[]>;

  /** Release a held reservation back to available stock. */
  release(tx: Prisma.TransactionClient, ctx: ReserveContext): Promise<void>;

  /** Return refunded/voided (sold) tickets to available stock. */
  refund(tx: Prisma.TransactionClient, ctx: RefundContext): Promise<void>;

  /** Available units per ticket type (ticket types with no stock report 0). */
  availability(
    client: Prisma.TransactionClient | PrismaLike,
    ticketTypeIds: string[],
  ): Promise<Map<string, number>>;
}

/** Minimal read surface so `availability` accepts the root PrismaService too. */
export interface PrismaLike {
  ticketInventory: {
    findMany(args: {
      where: { ticketTypeId: { in: string[] } };
      select: {
        ticketTypeId: true;
        quantityTotal: true;
        quantitySold: true;
        quantityHeld: true;
      };
    }): Promise<
      Array<{
        ticketTypeId: string;
        quantityTotal: number;
        quantitySold: number;
        quantityHeld: number;
      }>
    >;
  };
}

/** The single source of truth for "how many units are free". */
export function availableUnits(total: number, sold: number, held: number): number {
  return Math.max(0, total - sold - held);
}
