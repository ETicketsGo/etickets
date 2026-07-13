import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InventoryStrategyKind } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';
import {
  availableUnits,
  type InventoryStrategy,
  type PrismaLike,
  type ReserveContext,
  type TicketIssueSpec,
} from './inventory-strategy.interface';

/**
 * Seat-based inventory for movies (and any reserved-seating experience). The
 * authoritative per-show seat state lives in `ShowSeat` (one row per
 * session×seat). Availability counters on `TicketInventory` are kept in lock-step
 * purely so existing reporting keeps working; the seat rows are the real guard.
 *
 * Atomicity / double-booking safety: a single conditional UPDATE flips the exact
 * selected seats AVAILABLE→HELD; if the affected row count is less than the
 * number of seats requested, some seat was already taken and the whole booking
 * transaction rolls back. See ADR-013.
 */
@Injectable()
export class SeatBasedInventoryStrategy implements InventoryStrategy {
  readonly kind = InventoryStrategyKind.SEAT_BASED;

  private seatIdsOf(ctx: ReserveContext): string[] {
    return ctx.lines.flatMap((l) => l.seatIds ?? []);
  }

  async reserve(tx: Prisma.TransactionClient, ctx: ReserveContext): Promise<void> {
    const seatIds = this.seatIdsOf(ctx);
    if (seatIds.length === 0) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Select at least one seat.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Atomic, double-book-proof hold: only AVAILABLE seats flip to HELD.
    const affected = await tx.$executeRaw`
      UPDATE "ShowSeat"
      SET "status" = 'HELD',
          "holdBookingId" = ${ctx.bookingId},
          "holdExpiresAt" = ${ctx.holdExpiresAt},
          "version" = "version" + 1,
          "updatedAt" = NOW()
      WHERE "eventSessionId" = ${ctx.eventSessionId}
        AND "seatId" IN (${Prisma.join(seatIds)})
        AND "status" = 'AVAILABLE'
    `;
    if (affected !== seatIds.length) {
      throw new AppException(
        ErrorCodes.BOOKING_INVENTORY_UNAVAILABLE,
        'One or more of the selected seats are no longer available.',
        HttpStatus.CONFLICT,
        { eventSessionId: ctx.eventSessionId },
      );
    }

    // Keep the per-category counters in step (reporting parity).
    for (const line of ctx.lines) {
      await tx.$executeRaw`
        UPDATE "TicketInventory"
        SET "quantityHeld" = "quantityHeld" + ${line.quantity},
            "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE "ticketTypeId" = ${line.ticketTypeId}
      `;
    }
  }

  /**
   * Self-sufficient from persisted seat state: reads the seats this booking holds
   * (booking items don't store seats), marks them sold, and issues one ticket per
   * seat priced by its category's ticket type for the session.
   */
  async confirm(
    tx: Prisma.TransactionClient,
    ctx: ReserveContext,
  ): Promise<TicketIssueSpec[]> {
    const held = await tx.showSeat.findMany({
      where: { holdBookingId: ctx.bookingId, status: 'HELD' },
      select: {
        seatId: true,
        seat: {
          select: { label: true, seatCategoryId: true, row: { select: { label: true } } },
        },
      },
    });
    if (held.length === 0) return [];

    await tx.$executeRaw`
      UPDATE "ShowSeat"
      SET "status" = 'SOLD', "updatedAt" = NOW()
      WHERE "holdBookingId" = ${ctx.bookingId} AND "status" = 'HELD'
    `;

    // Map each seat category to the session's ticket type (its price tier).
    const ticketTypes = await tx.ticketType.findMany({
      where: { eventSessionId: ctx.eventSessionId, seatCategoryId: { not: null } },
      select: { id: true, seatCategoryId: true },
    });
    const ticketTypeByCategory = new Map(
      ticketTypes.map((t) => [t.seatCategoryId as string, t.id]),
    );

    const countByTicketType = new Map<string, number>();
    const specs: TicketIssueSpec[] = [];
    for (const s of held) {
      const ticketTypeId = ticketTypeByCategory.get(s.seat.seatCategoryId);
      if (!ticketTypeId) continue;
      countByTicketType.set(ticketTypeId, (countByTicketType.get(ticketTypeId) ?? 0) + 1);
      specs.push({
        ticketTypeId,
        seatId: s.seatId,
        seatLabel: `${s.seat.row.label}${s.seat.label}`,
      });
    }

    for (const [ticketTypeId, count] of countByTicketType) {
      await tx.$executeRaw`
        UPDATE "TicketInventory"
        SET "quantityHeld" = GREATEST(0, "quantityHeld" - ${count}),
            "quantitySold" = "quantitySold" + ${count},
            "updatedAt" = NOW()
        WHERE "ticketTypeId" = ${ticketTypeId}
      `;
    }
    return specs;
  }

  async release(tx: Prisma.TransactionClient, ctx: ReserveContext): Promise<void> {
    await tx.$executeRaw`
      UPDATE "ShowSeat"
      SET "status" = 'AVAILABLE', "holdBookingId" = NULL, "holdExpiresAt" = NULL, "updatedAt" = NOW()
      WHERE "holdBookingId" = ${ctx.bookingId} AND "status" = 'HELD'
    `;
    for (const line of ctx.lines) {
      await tx.$executeRaw`
        UPDATE "TicketInventory"
        SET "quantityHeld" = GREATEST(0, "quantityHeld" - ${line.quantity}), "updatedAt" = NOW()
        WHERE "ticketTypeId" = ${line.ticketTypeId}
      `;
    }
  }

  /** Reuses the maintained TicketInventory counters (kept in step by this strategy). */
  async availability(
    client: Prisma.TransactionClient | PrismaLike,
    ticketTypeIds: string[],
  ): Promise<Map<string, number>> {
    const rows = await client.ticketInventory.findMany({
      where: { ticketTypeId: { in: ticketTypeIds } },
      select: {
        ticketTypeId: true,
        quantityTotal: true,
        quantitySold: true,
        quantityHeld: true,
      },
    });
    const map = new Map<string, number>();
    for (const id of ticketTypeIds) map.set(id, 0);
    for (const r of rows) {
      map.set(r.ticketTypeId, availableUnits(r.quantityTotal, r.quantitySold, r.quantityHeld));
    }
    return map;
  }
}
