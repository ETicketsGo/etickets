import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { InventoryStrategyKind } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';
import {
  availableUnits,
  type InventoryLine,
  type InventoryStrategy,
  type PrismaLike,
} from './inventory-strategy.interface';

/**
 * Quantity-based inventory: a per-ticket-type counter of total / sold / held.
 * This is the platform's original (and only, pre-Experience) inventory model.
 * The SQL below is the exact oversell-proof logic that previously lived inline in
 * BookingsService (reserve/release) and PaymentsService (confirm) — moved here
 * unchanged so behaviour is identical. See ADR-010.
 */
@Injectable()
export class GeneralAdmissionInventoryStrategy implements InventoryStrategy {
  readonly kind = InventoryStrategyKind.GENERAL_ADMISSION;

  /**
   * Atomic conditional hold: `quantityHeld += qty` only succeeds while enough
   * stock is free, so concurrent buyers can never oversell. Throws otherwise.
   */
  async reserve(tx: Prisma.TransactionClient, lines: InventoryLine[]): Promise<void> {
    for (const line of lines) {
      const affected = await tx.$executeRaw`
        UPDATE "TicketInventory"
        SET "quantityHeld" = "quantityHeld" + ${line.quantity},
            "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE "ticketTypeId" = ${line.ticketTypeId}
          AND ("quantityTotal" - "quantitySold" - "quantityHeld") >= ${line.quantity}
      `;
      if (affected !== 1) {
        throw new AppException(
          ErrorCodes.BOOKING_INVENTORY_UNAVAILABLE,
          'The requested ticket quantity is no longer available.',
          HttpStatus.CONFLICT,
          { ticketTypeId: line.ticketTypeId },
        );
      }
    }
  }

  /** Settle a paid booking: held → sold. */
  async confirm(tx: Prisma.TransactionClient, lines: InventoryLine[]): Promise<void> {
    for (const line of lines) {
      await tx.$executeRaw`
        UPDATE "TicketInventory"
        SET "quantityHeld" = GREATEST(0, "quantityHeld" - ${line.quantity}),
            "quantitySold" = "quantitySold" + ${line.quantity},
            "updatedAt" = NOW()
        WHERE "ticketTypeId" = ${line.ticketTypeId}
      `;
    }
  }

  /** Expire / cancel a hold: held → available. */
  async release(tx: Prisma.TransactionClient, lines: InventoryLine[]): Promise<void> {
    for (const line of lines) {
      await tx.$executeRaw`
        UPDATE "TicketInventory"
        SET "quantityHeld" = GREATEST(0, "quantityHeld" - ${line.quantity}), "updatedAt" = NOW()
        WHERE "ticketTypeId" = ${line.ticketTypeId}
      `;
    }
  }

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
