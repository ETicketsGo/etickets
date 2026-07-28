import { ConfigService } from '@nestjs/config';
import { MockPaymentProvider } from './mock-payment.provider';

function provider() {
  const config = {
    getOrThrow: () => 'test-secret-key-000000000000000000',
  } as unknown as ConfigService;
  return new MockPaymentProvider(config);
}

describe('MockPaymentProvider refund (dev/test only)', () => {
  it('advertises idempotent full-refund + status-query capability', () => {
    const c = provider().capabilities;
    expect(c.supportsFullRefund).toBe(true);
    expect(c.supportsIdempotentRefund).toBe(true);
    expect(c.supportsRefundStatusQuery).toBe(true);
  });

  it('refunds a captured payment (COMPLETED) and is idempotent on repeat (stable ref)', async () => {
    const p = provider();
    const a = await p.refund!({ providerRef: 'pi_1', amountMinor: 5000, currency: 'USD' });
    const b = await p.refund!({ providerRef: 'pi_1', amountMinor: 5000, currency: 'USD' });
    expect(a.status).toBe('COMPLETED');
    expect(b.status).toBe('COMPLETED');
    expect(a.providerRef).toBe(b.providerRef); // stable refund reference → idempotent
  });

  it('reports FAILED on the #refundfail scenario', async () => {
    expect(
      (
        await provider().refund!({
          providerRef: 'pi_1#refundfail',
          amountMinor: 5000,
          currency: 'USD',
        })
      ).status,
    ).toBe('FAILED');
  });

  it('throws on the ambiguous/refund-lost scenario (executor recovers via getRefund)', async () => {
    await expect(
      provider().refund!({
        providerRef: 'pi_1#refundambiguous',
        amountMinor: 5000,
        currency: 'USD',
      }),
    ).rejects.toBeTruthy();
  });

  it('status query recovers an ambiguous refund as COMPLETED, and #reffail stays FAILED', async () => {
    const p = provider();
    expect((await p.getRefund!('mock_rf_x')).status).toBe('COMPLETED');
    expect((await p.getRefund!('mock_rf_x#reffail')).status).toBe('FAILED');
  });
});
