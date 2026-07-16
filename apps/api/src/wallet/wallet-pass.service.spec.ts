import { WalletPassService } from './wallet-pass.service';
import { WalletConfigService } from './wallet-config.service';
import { AppleWalletAdapter } from './provider/apple-wallet.adapter';
import { GoogleWalletAdapter } from './provider/google-wallet.adapter';
import { TicketsService } from '../tickets/tickets.service';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/decorators';

const USER: RequestUser = {
  id: 'u1',
  email: 'c@e.test',
  fullName: 'Customer',
  roles: ['CUSTOMER'] as never,
};

const activeTicket = {
  id: 'tk1',
  serial: 'S-1',
  status: 'ACTIVE',
  holderName: 'Ada',
  ticketType: 'GA',
  event: { title: 'Night Show', slug: 'night' },
  startsAt: new Date('2030-01-01T20:00:00Z'),
  qrToken: 'signed-qr-token',
  seatLabel: 'A1',
  venueName: 'The Hall',
  bookingRef: 'ETG-1',
};

function build(env: Record<string, string>, ticket: unknown = activeTicket) {
  const config = { get: (k: string) => env[k] } as never;
  const walletConfig = new WalletConfigService(config);
  const tickets = { getForUser: jest.fn().mockResolvedValue(ticket) } as unknown as TicketsService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const svc = new WalletPassService(
    tickets,
    walletConfig,
    new AppleWalletAdapter(),
    new GoogleWalletAdapter(),
    audit,
  );
  return { svc, tickets, audit };
}

const SANDBOX_ENV = {
  WALLET_APPLE_ENABLED: 'true',
  WALLET_APPLE_MODE: 'sandbox',
  WALLET_APPLE_PASS_TYPE_ID: 'pass.com.eticketsgo.sandbox',
  WALLET_APPLE_TEAM_ID: 'TEAMSANDBOX',
  WALLET_GOOGLE_ENABLED: 'true',
  WALLET_GOOGLE_MODE: 'sandbox',
  WALLET_GOOGLE_ISSUER_ID: '3388000000000000000',
};

describe('WalletConfigService (env-based, fail-closed, non-secret)', () => {
  it('is unavailable with no env configured', () => {
    const { svc } = build({});
    expect(svc.providersStatus().providers.every((p) => p.status === 'unavailable')).toBe(true);
  });

  it('is sandbox when enabled with required non-secret config', () => {
    const { svc } = build(SANDBOX_ENV);
    const s = svc.providersStatus().providers;
    expect(s.find((p) => p.provider === 'apple')?.status).toBe('sandbox');
    expect(s.find((p) => p.provider === 'google')?.status).toBe('sandbox');
  });

  it('never exposes secret material in the public status', () => {
    const { svc } = build({ ...SANDBOX_ENV, WALLET_APPLE_CERT_REF: 'secret://apple-cert' });
    const json = JSON.stringify(svc.providersStatus());
    expect(json).not.toContain('secret://');
    expect(json).not.toContain('WALLET_APPLE_CERT_REF');
  });
});

describe('WalletPassService.generate (fail-closed + audited)', () => {
  it('fails closed (unavailable) when the provider is not configured', async () => {
    const { svc, audit } = build({});
    const res = await svc.generate(USER, 'tk1', 'apple');
    expect(res).toMatchObject({ available: false, status: 'unavailable' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WALLET_PASS_GENERATE' }),
    );
  });

  it('refuses an ineligible ticket even when the provider is configured', async () => {
    const { svc } = build(SANDBOX_ENV, { ...activeTicket, status: 'REFUNDED' });
    const res = await svc.generate(USER, 'tk1', 'apple');
    expect(res).toMatchObject({ available: true, eligible: false });
  });

  it('builds a sandbox pass descriptor for a valid ticket + carries the SAME QR token', async () => {
    const { svc, audit } = build(SANDBOX_ENV);
    const res = await svc.generate(USER, 'tk1', 'apple');
    expect(res).toMatchObject({
      available: true,
      eligible: true,
      provider: 'apple',
      mode: 'sandbox',
    });
    if (res.available && 'descriptor' in res) {
      // The barcode is the existing signed QR token — not a new/separate ticket.
      expect(JSON.stringify(res.descriptor)).toContain('signed-qr-token');
      // No secret material in the descriptor.
      expect(JSON.stringify(res.descriptor)).not.toContain('secret');
    }
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WALLET_PASS_GENERATE',
        metadata: expect.objectContaining({ eligible: true }),
      }),
    );
  });

  it('propagates the ticket-service authorization (never bypasses ticket rules)', async () => {
    const { svc, tickets } = build(SANDBOX_ENV);
    (tickets.getForUser as jest.Mock).mockRejectedValueOnce(new Error('forbidden'));
    await expect(svc.generate(USER, 'tk1', 'google')).rejects.toThrow();
  });
});
