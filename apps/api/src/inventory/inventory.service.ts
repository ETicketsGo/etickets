import { HttpStatus, Injectable } from '@nestjs/common';
import { ExperienceType, InventoryStrategyKind } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';
import { ExperienceTypeRegistry } from '../experience/experience-type.registry';
import { GeneralAdmissionInventoryStrategy } from './general-admission.strategy';
import type { InventoryStrategy } from './inventory-strategy.interface';

/**
 * Resolves the correct {@link InventoryStrategy} for an experience type. Callers
 * (BookingsService, PaymentsService) depend only on this service and the
 * InventoryStrategy interface — never on a concrete strategy — so the set of
 * strategies can grow without any caller changing. See ADR-010.
 */
@Injectable()
export class InventoryService {
  private readonly byKind: Record<string, InventoryStrategy>;

  constructor(
    private readonly registry: ExperienceTypeRegistry,
    generalAdmission: GeneralAdmissionInventoryStrategy,
  ) {
    // Register every implemented strategy by its kind. New strategies (seat-based,
    // capacity, time-slot) are added to this map in later PRs.
    this.byKind = {
      [InventoryStrategyKind.GENERAL_ADMISSION]: generalAdmission,
    };
  }

  /** The strategy for a given experience type (via the registry mapping). */
  forExperienceType(type: ExperienceType): InventoryStrategy {
    return this.forKind(this.registry.inventoryKindFor(type));
  }

  /** The strategy for a specific inventory kind. */
  forKind(kind: InventoryStrategyKind): InventoryStrategy {
    const strategy = this.byKind[kind];
    if (!strategy) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `No inventory strategy is registered for ${kind}.`,
        HttpStatus.INTERNAL_SERVER_ERROR,
        { kind },
      );
    }
    return strategy;
  }
}
