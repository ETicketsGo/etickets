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

  it('#refundlost makes the refund and then loses the answer; the lookup finds it by key', async () => {
    const p = provider();
    await expect(
      p.refund!({ providerRef: 'pay_1#refundlost', amountMinor: 700, idempotencyKey: 'etg-rf-r1' }),
    ).rejects.toBeTruthy();
    expect(await p.findPaymentRefunds!('pay_1#refundlost')).toEqual([
      expect.objectContaining({
        amountMinor: 700,
        status: 'COMPLETED',
        idempotencyKey: 'etg-rf-r1',
      }),
    ]);
  });

  it('the same key twice is one refund, not two', async () => {
    const p = provider();
    const input = { providerRef: 'pay_2', amountMinor: 700, idempotencyKey: 'etg-rf-r2' };
    const a = await p.refund!(input);
    const b = await p.refund!(input);
    expect(a.providerRef).toBe(b.providerRef);
    expect(await p.findPaymentRefunds!('pay_2')).toHaveLength(1);
  });

  it('#refundunknown loses the answer and cannot be looked up either', async () => {
    const p = provider();
    await expect(
      p.refund!({ providerRef: 'pay_3#refundunknown', amountMinor: 1 }),
    ).rejects.toBeTruthy();
    await expect(p.findPaymentRefunds!('pay_3#refundunknown')).rejects.toBeTruthy();
  });
});
