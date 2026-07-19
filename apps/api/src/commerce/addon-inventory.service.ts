import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppException, ErrorCodes } from '../common/errors';

export interface AddOnLine {
  addOnId: string;
  quantity: number;
}

/**
 * Stock control for add-ons — the exact oversell-proof pattern used for tickets
 * (atomic conditional `quantityHeld += qty`), but aware of unlimited stock: when
 * `AddOnInventory.quantityTotal IS NULL` (donations, digital goods) the hold is
 * unconditional. All mutations take a transaction client so they compose with the
 * booking/payment `$transaction`.
 */
@Injectable()
export class AddOnInventoryService {
  /** Hold stock for each line. Throws if a limited add-on lacks free stock. */
  async reserve(tx: Prisma.TransactionClient, lines: AddOnLine[]): Promise<void> {
    for (const line of lines) {
      const affected = await tx.$executeRaw`
        UPDATE "AddOnInventory"
        SET "quantityHeld" = "quantityHeld" + ${line.quantity},
            "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE "addOnId" = ${line.addOnId}
          AND ("quantityTotal" IS NULL
               OR ("quantityTotal" - "quantitySold" - "quantityHeld") >= ${line.quantity})
      `;
      if (affected !== 1) {
        throw new AppException(
          ErrorCodes.BOOKING_INVENTORY_UNAVAILABLE,
          'This add-on is no longer available in the requested quantity.',
          HttpStatus.CONFLICT,
          { addOnId: line.addOnId },
        );
      }
    }
  }

  /** Settle a paid booking's add-on lines: held → sold. */
  async confirm(tx: Prisma.TransactionClient, lines: AddOnLine[]): Promise<void> {
    for (const line of lines) {
      await tx.$executeRaw`
        UPDATE "AddOnInventory"
        SET "quantityHeld" = GREATEST(0, "quantityHeld" - ${line.quantity}),
            "quantitySold" = "quantitySold" + ${line.quantity},
            "updatedAt" = NOW()
        WHERE "addOnId" = ${line.addOnId}
      `;
    }
  }

  /** Expire / cancel a hold: held → available. */
  async release(tx: Prisma.TransactionClient, lines: AddOnLine[]): Promise<void> {
    for (const line of lines) {
      await tx.$executeRaw`
        UPDATE "AddOnInventory"
        SET "quantityHeld" = GREATEST(0, "quantityHeld" - ${line.quantity}), "updatedAt" = NOW()
        WHERE "addOnId" = ${line.addOnId}
      `;
    }
  }

  /** Refund: return sold add-on units to available stock. */
  async refund(tx: Prisma.TransactionClient, lines: AddOnLine[]): Promise<void> {
    for (const line of lines) {
      await tx.$executeRaw`
        UPDATE "AddOnInventory"
        SET "quantitySold" = GREATEST(0, "quantitySold" - ${line.quantity}), "updatedAt" = NOW()
        WHERE "addOnId" = ${line.addOnId}
      `;
    }
  }
}
