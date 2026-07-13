import { ExperienceType, InventoryStrategyKind } from '@eticketsgo/shared-types';
import { ExperienceTypeRegistry } from './experience-type.registry';
import { AppException } from '../common/errors';

describe('ExperienceTypeRegistry', () => {
  const registry = new ExperienceTypeRegistry();

  it('maps EVENT to general-admission and MOVIE to seat-based inventory', () => {
    expect(registry.inventoryKindFor(ExperienceType.EVENT)).toBe(
      InventoryStrategyKind.GENERAL_ADMISSION,
    );
    expect(registry.inventoryKindFor(ExperienceType.MOVIE)).toBe(InventoryStrategyKind.SEAT_BASED);
    expect(registry.supports(ExperienceType.EVENT)).toBe(true);
    expect(registry.supports(ExperienceType.MOVIE)).toBe(true);
  });

  it('reports experience types without a strategy as unsupported', () => {
    // Museums/theme-parks register their strategies (capacity/time-slot) in later PRs.
    expect(registry.supports(ExperienceType.MUSEUM)).toBe(false);
    expect(() => registry.inventoryKindFor(ExperienceType.MUSEUM)).toThrow(AppException);
  });
});
