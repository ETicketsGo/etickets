import type { Prisma } from '@prisma/client';

/**
 * A single line of inventory demand: N units of one ticket type.
 * (Seat-based strategies in PR-3 will extend this with a seat selection.)
 */
export interface InventoryLine {
  ticketTypeId: string;
  quantity: number;
}

/**
 * The pluggable contract every experience type's inventory model implements.
 * The booking engine depends on THIS interface, never on a concrete strategy,
 * so new experience types (movies, museums, tours) can add their own inventory
 * behaviour without the booking engine changing. See ADR-010.
 *
 * `reserve`, `confirm` and `release` run inside a caller-provided Prisma
 * transaction (`tx`) so they compose atomically with the surrounding booking /
 * payment writes exactly as the original inline logic did.
 */
export interface InventoryStrategy {
  readonly kind: string;

  /**
   * Atomically hold stock for the given lines. MUST be oversell-proof under
   * concurrency and MUST throw if any line cannot be satisfied.
   */
  reserve(tx: Prisma.TransactionClient, lines: InventoryLine[]): Promise<void>;

  /** Convert a held reservation into a confirmed sale (held → sold). */
  confirm(tx: Prisma.TransactionClient, lines: InventoryLine[]): Promise<void>;

  /** Release a held reservation back to free stock (held → available). */
  release(tx: Prisma.TransactionClient, lines: InventoryLine[]): Promise<void>;

  /**
   * Report currently-available units per ticket type. Returns a map keyed by
   * ticketTypeId; ticket types with no inventory row report 0.
   */
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
