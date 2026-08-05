import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { InventoryService } from '../../inventory.service';
import { LocalInventoryProvider } from './local-inventory.provider';
import type { InventorySourceKind } from '../inventory-provider.interface';

/**
 * Inventory entered MANUALLY through the ETicketsGo Theatre Portal (an operator
 * keying in schedules / seat blocks). It is still LOCAL and authoritative — it uses
 * the same database and inventory strategy as Direct — so it inherits all behaviour
 * and differs only in provenance (`sourceKind = 'MANUAL'`), which ops/analytics can
 * distinguish while end users never can. See ADR-037.
 */
@Injectable()
export class ManualInventoryProvider extends LocalInventoryProvider {
  readonly name = 'manual';
  readonly sourceKind: InventorySourceKind = 'MANUAL';

  constructor(inventory: InventoryService, prisma: PrismaService) {
    super(inventory, prisma);
  }
}
