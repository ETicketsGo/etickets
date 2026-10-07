import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * How many places are left in a standing area, and who got the last one.
 *
 * -- WHY THE ARITHMETIC IS IN SQL AND NOT HERE --------------------------------------------
 * The obvious implementation reads the row, checks `capacity - sold - held >= n`, and writes
 * back. Two buyers doing that at the same moment both read 1 remaining, both decide yes, and
 * both write - and a 4,000-capacity floor sells 4,001 tickets. Nothing in the result looks
 * wrong afterwards; the numbers simply do not add up, and the person who finds out is a
 * steward at a door.
 *
 * So the check and the write are ONE statement, and the database decides:
 *
 *     UPDATE "ShowZone" SET held = held + n
 *      WHERE id = $1 AND capacity - sold - held >= n
 *
 * Postgres takes a row lock for the duration of the UPDATE, so the second writer evaluates
 * its WHERE against the first one's committed result. It either matches and updates, or
 * matches nothing - and "no rows updated" IS the refusal. There is no window between the
 * decision and the write because they are the same operation.
 *
 * This is the same guarantee `ShowSeat` gets from its unique `(eventSessionId, seatId)`: a
 * seat cannot be sold twice because the database will not store it twice. A zone has no such
 * natural key - that is what "general admission" means - so the constraint has to be the
 * predicate instead.
 *
 * -- WHY `held` AND `sold` ARE SEPARATE ----------------------------------------------------
 * A hold expires; a sale does not. Collapsing them into one "taken" column would make an
 * abandoned checkout indistinguishable from a refund, and releasing the one would silently
 * release the other.
 */
@Injectable()
export class ZoneInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hold `quantity` places, or refuse.
   *
   * Returns the number of rows the database changed: 1 when the hold was taken, 0 when there
   * was not enough room. The caller decides what a 0 means for them - a checkout refuses, a
   * reconciliation job logs - so this does not throw on its own.
   */
  async tryHold(showZoneId: string, quantity: number): Promise<boolean> {
    if (quantity <= 0) return false;
    const changed = await this.prisma.$executeRawUnsafe(
      `UPDATE "ShowZone"
          SET "held" = "held" + $2, "version" = "version" + 1, "updatedAt" = NOW()
        WHERE "id" = $1
          AND "capacity" - "sold" - "held" >= $2`,
      showZoneId,
      quantity,
    );
    return changed === 1;
  }

  /** Hold, or refuse with the error a buyer should see. */
  async hold(showZoneId: string, quantity: number): Promise<void> {
    if (!(await this.tryHold(showZoneId, quantity))) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'There are not that many places left in this area.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * Give places back - an abandoned checkout, an expired hold, a cancelled order.
   *
   * Floored at zero in SQL rather than trusted from the caller. A release that ran twice
   * would otherwise drive `held` negative, and a negative hold INVENTS capacity: the zone
   * would then sell more than it holds, which is the exact failure this file exists to stop.
   */
  async release(showZoneId: string, quantity: number): Promise<void> {
    if (quantity <= 0) return;
    await this.prisma.$executeRawUnsafe(
      `UPDATE "ShowZone"
          SET "held" = GREATEST("held" - $2, 0), "version" = "version" + 1, "updatedAt" = NOW()
        WHERE "id" = $1`,
      showZoneId,
      quantity,
    );
  }

  /**
   * Turn a hold into a sale.
   *
   * Moves the places rather than adding them, and only when the hold is actually there -
   * `held >= n`. Confirming a payment for a hold that already expired must not conjure a sale
   * out of a zone that has since filled up, so this can return false and the caller has to
   * deal with it.
   */
  async tryConfirm(showZoneId: string, quantity: number): Promise<boolean> {
    if (quantity <= 0) return false;
    const changed = await this.prisma.$executeRawUnsafe(
      `UPDATE "ShowZone"
          SET "held" = "held" - $2,
              "sold" = "sold" + $2,
              "version" = "version" + 1,
              "updatedAt" = NOW()
        WHERE "id" = $1
          AND "held" >= $2`,
      showZoneId,
      quantity,
    );
    return changed === 1;
  }

  /**
   * What is left in each zone of a session.
   *
   * `remaining` is computed here and never stored. A stored remainder is a fourth number that
   * can disagree with the other three, and the one that disagrees is always the one a buyer
   * is shown.
   */
  async availability(eventSessionId: string) {
    const rows = await this.prisma.showZone.findMany({
      where: { eventSessionId },
      orderBy: { zone: { sortOrder: 'asc' } },
      select: {
        id: true,
        capacity: true,
        sold: true,
        held: true,
        zone: {
          select: {
            id: true,
            name: true,
            category: { select: { id: true, name: true, basePriceMinor: true } },
          },
        },
      },
    });

    return rows.map((r) => ({
      showZoneId: r.id,
      zoneId: r.zone.id,
      name: r.zone.name,
      capacity: r.capacity,
      sold: r.sold,
      held: r.held,
      remaining: Math.max(r.capacity - r.sold - r.held, 0),
      categoryName: r.zone.category?.name ?? null,
      priceMinor: r.zone.category?.basePriceMinor ?? null,
    }));
  }

  /**
   * Create this session's zone inventory from its layout.
   *
   * Called when a session is given a layout, beside the `ShowSeat` rows for its seats. The
   * per-session `capacity` starts at the zone's physical figure; lowering it for one event is
   * event configuration and belongs on this row, never on the shared layout.
   */
  async materializeForSession(eventSessionId: string, seatMapId: string): Promise<number> {
    const zones = await this.prisma.seatZone.findMany({
      where: { seatMapId },
      select: { id: true, capacity: true },
    });
    if (!zones.length) return 0;

    const created = await this.prisma.showZone.createMany({
      data: zones.map((z) => ({ eventSessionId, zoneId: z.id, capacity: z.capacity })),
      // A session materialised twice must not double its own capacity.
      skipDuplicates: true,
    });
    return created.count;
  }
}
