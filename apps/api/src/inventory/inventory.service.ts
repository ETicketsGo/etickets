import { HttpStatus, Injectable } from '@nestjs/common';
import { ExperienceType, InventoryStrategyKind } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';
import { ExperienceTypeRegistry } from '../experience/experience-type.registry';
import { GeneralAdmissionInventoryStrategy } from './general-admission.strategy';
import { SeatBasedInventoryStrategy } from './seat-based.strategy';
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
    seatBased: SeatBasedInventoryStrategy,
  ) {
    // Register every implemented strategy by its kind. Capacity/time-slot land in
    // later PRs as those experience types arrive.
    this.byKind = {
      [InventoryStrategyKind.GENERAL_ADMISSION]: generalAdmission,
      [InventoryStrategyKind.SEAT_BASED]: seatBased,
    };
  }

  /**
   * The strategy for a booking that either holds named seats or does not.
   *
   * ── WHY THIS REPLACED forExperienceType ON THE BOOKING PATH ────────────────────────
   * Seating used to be decided by the KIND of experience: MOVIE meant seats, everything
   * else meant a counter. That conflated two different things. Whether a ticket names a seat
   * is a property of the ROOM — the same concert is reserved seating in a theatre and
   * general admission in a standing arena — and encoding it as a property of the experience
   * type is why an event could not have a seat map at all.
   *
   * Callers pass the booking's own `seatBased`, which was settled when it was created, so
   * confirmation and refund reach for the same strategy the hold used.
   */
  forSeating(seatBased: boolean): InventoryStrategy {
    return this.forKind(
      seatBased ? InventoryStrategyKind.SEAT_BASED : InventoryStrategyKind.GENERAL_ADMISSION,
    );
  }

  /**
   * The strategy for a given experience type (via the registry mapping).
   *
   * Still used by the inventory-sourcing provider, which works from a sourcing query rather
   * than from a booking and is behind a flag that is off. It keeps the old meaning until
   * that layer is turned on and can be given the session's room.
   */
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
