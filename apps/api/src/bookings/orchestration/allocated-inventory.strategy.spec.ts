import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AllocatedInventoryStrategy,
  type AllocationDescriptor,
} from './allocated-inventory.strategy';

function strat() {
  return new AllocatedInventoryStrategy(
    {} as unknown as PrismaService,
    { get: () => true } as unknown as ConfigService,
    new MetricsService(),
  );
}

const seatAlloc = (over: Partial<AllocationDescriptor> = {}): AllocationDescriptor => ({
  providerCode: 'p',
  providerTenantId: '',
  allocationId: 'a1',
  inventoryType: 'SEAT',
  status: 'ACTIVE',
  allocatedSeatRefs: ['A1', 'A2', 'A3'],
  ...over,
});
const gaAlloc = (over: Partial<AllocationDescriptor> = {}): AllocationDescriptor => ({
  providerCode: 'p',
  providerTenantId: '',
  allocationId: 'a1',
  inventoryType: 'QUANTITY',
  status: 'ACTIVE',
  capacity: 10,
  localConsumed: 6,
  ...over,
});

describe('AllocatedInventoryStrategy.validate', () => {
  it('accepts seats inside the allocation', () => {
    expect(() =>
      strat().validate(seatAlloc(), { inventoryType: 'SEAT', seatRefs: ['A1', 'A2'] }),
    ).not.toThrow();
  });

  it('rejects a seat outside the allocation', () => {
    expect(() =>
      strat().validate(seatAlloc(), { inventoryType: 'SEAT', seatRefs: ['A1', 'Z9'] }),
    ).toThrow(AppException);
  });

  it('accepts a GA quantity within remaining capacity', () => {
    expect(() =>
      strat().validate(gaAlloc(), { inventoryType: 'QUANTITY', quantity: 4 }),
    ).not.toThrow();
  });

  it('rejects a GA quantity that would exceed the allocation', () => {
    expect(() => strat().validate(gaAlloc(), { inventoryType: 'QUANTITY', quantity: 5 })).toThrow(
      AppException,
    );
  });

  it('blocks new bookings when the allocation is suspended/expired/exhausted', () => {
    for (const status of ['SUSPENDED', 'EXPIRED', 'EXHAUSTED', 'CANCELLED']) {
      expect(() =>
        strat().validate(gaAlloc({ status }), { inventoryType: 'QUANTITY', quantity: 1 }),
      ).toThrow(AppException);
    }
  });

  it('blocks bookings outside the effective window', () => {
    expect(() =>
      strat().validate(gaAlloc({ startsAt: new Date(Date.now() + 60_000) }), {
        inventoryType: 'QUANTITY',
        quantity: 1,
      }),
    ).toThrow(AppException);
    expect(() =>
      strat().validate(gaAlloc({ expiresAt: new Date(Date.now() - 60_000) }), {
        inventoryType: 'QUANTITY',
        quantity: 1,
      }),
    ).toThrow(AppException);
  });
});

describe('AllocatedInventoryStrategy.classify', () => {
  it('never reports capacity mismatch when within allocation', () => {
    expect(strat().classify(gaAlloc(), 6)).toBe('IN_SYNC');
  });

  it('flags capacity mismatch when local exceeds allocation', () => {
    expect(strat().classify(gaAlloc({ capacity: 5 }), 6)).toBe('ALLOCATION_CAPACITY_MISMATCH');
  });

  it('flags expired/suspended allocations with active holds (never auto-cancels)', () => {
    expect(strat().classify(gaAlloc({ status: 'EXPIRED' }), 3)).toBe(
      'ALLOCATION_EXPIRED_WITH_ACTIVE_HOLDS',
    );
    expect(strat().classify(gaAlloc({ status: 'SUSPENDED' }), 3)).toBe(
      'ALLOCATION_SUSPENDED_WITH_ACTIVE_BOOKINGS',
    );
  });

  it('flags a missing allocation mapping', () => {
    expect(strat().classify(null, 0)).toBe('ALLOCATION_MAPPING_MISSING');
  });
});
