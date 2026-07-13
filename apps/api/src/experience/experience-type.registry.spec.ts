import { ExperienceType, InventoryStrategyKind } from '@eticketsgo/shared-types';
import { ExperienceTypeRegistry } from './experience-type.registry';
import { AppException } from '../common/errors';

describe('ExperienceTypeRegistry', () => {
  const registry = new ExperienceTypeRegistry();

  it('maps EVENT to general-admission inventory (current behaviour)', () => {
    expect(registry.inventoryKindFor(ExperienceType.EVENT)).toBe(
      InventoryStrategyKind.GENERAL_ADMISSION,
    );
    expect(registry.supports(ExperienceType.EVENT)).toBe(true);
  });

  it('reports experience types without a strategy as unsupported', () => {
    // MOVIE lands with the seat-based strategy in a later PR.
    expect(registry.supports(ExperienceType.MOVIE)).toBe(false);
    expect(() => registry.inventoryKindFor(ExperienceType.MOVIE)).toThrow(AppException);
  });
});
