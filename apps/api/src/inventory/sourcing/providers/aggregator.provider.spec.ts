import { ExperienceType } from '@eticketsgo/shared-types';
import { AppException } from '../../../common/errors';
import { AggregatorInventoryProvider } from './aggregator.provider';

describe('AggregatorInventoryProvider (placeholder — fails closed)', () => {
  const provider = new AggregatorInventoryProvider();
  const ctx = {
    experienceType: ExperienceType.MOVIE,
    eventSessionId: 'sess_1',
    bookingId: 'bk_1',
    lines: [{ ticketTypeId: 'tt1', quantity: 1 }],
  };

  it('advertises REMOTE + failover-eligible capabilities', () => {
    expect(provider.capabilities).toEqual({ search: true, authority: 'REMOTE', failover: true });
    expect(provider.sourceKind).toBe('AGGREGATOR');
  });

  it.each([
    ['search', () => provider.search({})],
    ['availability', () => provider.availability({ ...ctx, ticketTypeIds: ['tt1'] })],
    ['lockInventory', () => provider.lockInventory({ ...ctx, holdExpiresAt: new Date() })],
    ['confirmBooking', () => provider.confirmBooking(ctx)],
    ['cancelBooking', () => provider.cancelBooking(ctx)],
    ['refund', () => provider.refund({ ...ctx, tickets: [{ ticketTypeId: 'tt1' }] })],
    ['sync', () => provider.sync({})],
  ])('%s fails closed with a clear error (never fabricates)', async (_op, call) => {
    await expect(call()).rejects.toBeInstanceOf(AppException);
  });

  it('reports unhealthy so the resolver never selects it', async () => {
    const health = await provider.health();
    expect(health.healthy).toBe(false);
    expect(health.reason).toBe('not_integrated');
  });
});
