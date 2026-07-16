import { Injectable } from '@nestjs/common';
import type { WalletPassProjection } from '@eticketsgo/shared-types';
import type { ResolvedWalletConfig } from '../wallet-config.service';
import type { WalletPassProvider, WalletPassResult } from './wallet-pass.provider';

/**
 * Google Wallet adapter. Produces an EventTicketObject-shaped descriptor whose barcode
 * is the EXISTING signed QR token. In sandbox mode the descriptor is returned unsigned;
 * an "Add to Google Wallet" link requires a JWT signed with a service-account key
 * (WALLET_GOOGLE_SERVICE_ACCOUNT_REF) resolved via a secret manager in production — an
 * external dependency, never bundled here.
 */
@Injectable()
export class GoogleWalletAdapter implements WalletPassProvider {
  readonly kind = 'google' as const;

  build(cfg: ResolvedWalletConfig, p: WalletPassProjection): WalletPassResult {
    const issuerId = cfg.ids.issuerId;
    const descriptor = {
      id: `${issuerId}.${p.ticketId}`,
      classId: `${issuerId}.eticketsgo_event`,
      state: 'ACTIVE',
      ticketHolderName: p.holderName ?? 'Guest',
      ticketNumber: p.serial,
      barcode: { type: 'QR_CODE', value: p.qrToken },
      eventName: { defaultValue: { language: 'en', value: p.eventTitle } },
      seatInfo: p.seatLabel
        ? { seat: { defaultValue: { language: 'en', value: p.seatLabel } } }
        : undefined,
      textModulesData: [
        { header: 'Booking', body: p.bookingRef },
        ...(p.venueName ? [{ header: 'Venue', body: p.venueName }] : []),
      ],
    };
    return {
      provider: 'google',
      status: cfg.status,
      mode: cfg.mode,
      descriptor,
      note:
        cfg.mode === 'sandbox'
          ? 'Sandbox descriptor — a save link requires a service-account-signed JWT (production).'
          : 'Signed save-JWT generation requires the configured service account.',
    };
  }
}
