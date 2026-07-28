import { ConfigService } from '@nestjs/config';
import { MockPaymentProvider } from './mock-payment.provider';

function provider() {
  const config = {
    getOrThrow: () => 'test-secret-key-000000000000000000',
  } as unknown as ConfigService;
  return new MockPaymentProvider(config);
}

describe('MockPaymentProvider void (dev/test only)', () => {
  it('advertises idempotent void + status query capability', () => {
    const c = provider().capabilities;
    expect(c.supportsVoid).toBe(true);
    expect(c.supportsIdempotentVoid).toBe(true);
    expect(c.supportsPaymentStatusQuery).toBe(true);
  });

  it('voids an authorization (CANCELLED) and is idempotent on repeat', async () => {
    const p = provider();
    expect((await p.cancel!({ providerRef: 'pi_1' })).status).toBe('CANCELLED');
    expect((await p.cancel!({ providerRef: 'pi_1' })).status).toBe('CANCELLED');
  });

  it('refuses to void a captured payment', async () => {
    expect((await provider().cancel!({ providerRef: 'pi_1#captured' })).status).toBe('CAPTURED');
  });

  it('throws on the ambiguous/void-lost scenario (executor recovers via status query)', async () => {
    await expect(provider().cancel!({ providerRef: 'pi_1#ambiguous' })).rejects.toBeTruthy();
  });

  it('status query recovers an ambiguous void as CANCELLED, and #retry stays AUTHORIZED', async () => {
    const p = provider();
    expect((await p.getPayment!('pi_1#ambiguous')).status).toBe('CANCELLED');
    expect((await p.getPayment!('pi_1#retry')).status).toBe('AUTHORIZED');
    expect((await p.getPayment!('pi_1#captured')).status).toBe('CAPTURED');
  });
});
