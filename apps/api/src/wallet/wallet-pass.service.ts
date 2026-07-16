import { Injectable } from '@nestjs/common';
import {
  walletPassEligible,
  walletProviderCanIssue,
  type WalletPassProjection,
  type WalletProvider,
} from '@eticketsgo/shared-types';
import { TicketsService } from '../tickets/tickets.service';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/decorators';
import { WalletConfigService } from './wallet-config.service';
import { AppleWalletAdapter } from './provider/apple-wallet.adapter';
import { GoogleWalletAdapter } from './provider/google-wallet.adapter';
import type { WalletPassResult } from './provider/wallet-pass.provider';

export type WalletPassResponse =
  | { available: false; provider: WalletProvider; status: 'unavailable'; reason: string }
  | {
      available: true;
      eligible: false;
      provider: WalletProvider;
      status: string;
      reason: string;
    }
  | ({ available: true; eligible: true } & WalletPassResult);

/**
 * Projects an existing VALID ticket into a wallet pass (ADR-035 wallet sandbox). It
 * reuses the ticket source of truth + QR signing + per-ticket authorization via
 * TicketsService — a pass is never a separate ticket. Fails closed: an unconfigured
 * provider or an ineligible ticket (revoked/transferred/refunded/expired/checked-in)
 * yields no valid current pass. Every attempt is audited. No secret ever leaves here.
 */
@Injectable()
export class WalletPassService {
  constructor(
    private readonly tickets: TicketsService,
    private readonly walletConfig: WalletConfigService,
    private readonly apple: AppleWalletAdapter,
    private readonly google: GoogleWalletAdapter,
    private readonly audit: AuditService,
  ) {}

  providersStatus() {
    return { providers: this.walletConfig.publicStatus() };
  }

  async generate(
    user: RequestUser,
    ticketId: string,
    provider: WalletProvider,
  ): Promise<WalletPassResponse> {
    // Authorization + the authoritative ticket state come from the ticket service
    // (throws 403/404). This never bypasses the existing ticket rules.
    const ticket = await this.tickets.getForUser(user, ticketId);
    const cfg = this.walletConfig.forProvider(provider);

    const audit = (metadata: Record<string, unknown>) =>
      this.audit.record({
        actorUserId: user.id,
        action: 'WALLET_PASS_GENERATE',
        entityType: 'Ticket',
        entityId: ticketId,
        metadata: { provider, ...metadata },
      });

    // Fail closed: provider not configured.
    if (!walletProviderCanIssue(cfg.status)) {
      await audit({ status: 'unavailable' });
      return {
        available: false,
        provider,
        status: 'unavailable',
        reason: `${provider === 'apple' ? 'Apple' : 'Google'} Wallet is not configured for this environment.`,
      };
    }

    // Fail closed: only a live, valid ticket becomes a valid current pass.
    if (!walletPassEligible(ticket.status)) {
      await audit({ status: cfg.status, eligible: false, ticketStatus: ticket.status });
      return {
        available: true,
        eligible: false,
        provider,
        status: cfg.status,
        reason: `This ticket is ${ticket.status.toLowerCase()} and cannot generate a valid wallet pass.`,
      };
    }

    const projection: WalletPassProjection = {
      ticketId: ticket.id,
      serial: ticket.serial,
      eventTitle: ticket.event.title,
      startsAt: new Date(ticket.startsAt).toISOString(),
      holderName: ticket.holderName,
      ticketType: ticket.ticketType,
      seatLabel: ticket.seatLabel,
      venueName: ticket.venueName,
      bookingRef: ticket.bookingRef,
      qrToken: ticket.qrToken,
    };
    const adapter = provider === 'apple' ? this.apple : this.google;
    const result = adapter.build(cfg, projection);
    await audit({ status: cfg.status, eligible: true, mode: result.mode });
    return { available: true, eligible: true, ...result };
  }
}
