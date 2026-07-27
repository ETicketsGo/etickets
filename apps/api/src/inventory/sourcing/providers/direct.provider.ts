import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { InventoryService } from '../../inventory.service';
import { LocalInventoryProvider } from './local-inventory.provider';
import type { InventorySourceKind } from '../inventory-provider.interface';

/**
 * Inventory for a theatre / organizer integrated DIRECTLY with ETicketsGo — stock
 * created through our own APIs and held in our database. This is the source behind
 * every booking the platform serves today; the seam simply names it explicitly so
 * external sources can sit alongside it behind the same interface. See ADR-037.
 */
@Injectable()
export class DirectInventoryProvider extends LocalInventoryProvider {
  readonly name = 'direct';
  readonly sourceKind: InventorySourceKind = 'DIRECT';

  constructor(inventory: InventoryService, prisma: PrismaService) {
    super(inventory, prisma);
  }
}
