import { HttpStatus, Injectable } from '@nestjs/common';
import { ExperienceType, InventoryStrategyKind } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * Maps each experience type to the inventory model it uses. This is the single
 * extension point that keeps the booking engine open/closed: adding a new
 * experience type (e.g. MOVIE → SEAT_BASED in PR-3) is a one-line change here
 * plus a new strategy, with zero edits to BookingsService/PaymentsService.
 * See ADR-009 and ADR-010.
 */
@Injectable()
export class ExperienceTypeRegistry {
  private readonly inventoryKindByType: Partial<Record<ExperienceType, InventoryStrategyKind>> = {
    // The only type live today. Movies/museums/tours are registered in later PRs
    // as their strategies land — deliberately absent so an unsupported booking
    // fails loudly rather than silently using the wrong inventory model.
    [ExperienceType.EVENT]: InventoryStrategyKind.GENERAL_ADMISSION,
  };

  /** The inventory strategy kind for an experience type, or throw if unsupported. */
  inventoryKindFor(type: ExperienceType): InventoryStrategyKind {
    const kind = this.inventoryKindByType[type];
    if (!kind) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Booking is not yet available for ${type} experiences.`,
        HttpStatus.CONFLICT,
        { experienceType: type },
      );
    }
    return kind;
  }

  /** Whether bookings are currently supported for this experience type. */
  supports(type: ExperienceType): boolean {
    return Boolean(this.inventoryKindByType[type]);
  }
}
