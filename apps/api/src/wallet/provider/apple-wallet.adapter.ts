import { Injectable } from '@nestjs/common';
import type { WalletPassProjection } from '@eticketsgo/shared-types';
import type { ResolvedWalletConfig } from '../wallet-config.service';
import type { WalletPassProvider, WalletPassResult } from './wallet-pass.provider';

/**
 * Apple Wallet adapter. Produces a `pass.json`-shaped descriptor (eventTicket) whose
 * barcode is the EXISTING signed QR token — the pass is a projection, not a new ticket.
 * In sandbox mode the descriptor is returned unsigned; producing an installable
 * `.pkpass` requires a Pass Type ID certificate (WALLET_APPLE_CERT_REF) resolved via a
 * secret manager in production — an external dependency, never bundled here.
 */
@Injectable()
export class AppleWalletAdapter implements WalletPassProvider {
  readonly kind = 'apple' as const;

  build(cfg: ResolvedWalletConfig, p: WalletPassProjection): WalletPassResult {
    const descriptor = {
      formatVersion: 1,
      passTypeIdentifier: cfg.ids.passTypeIdentifier,
      teamIdentifier: cfg.ids.teamIdentifier,
      serialNumber: p.ticketId,
      description: `${p.eventTitle} — ${p.ticketType}`,
      relevantDate: p.startsAt,
      barcodes: [
        { message: p.qrToken, format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1' },
      ],
      eventTicket: {
        primaryFields: [{ key: 'event', label: 'Event', value: p.eventTitle }],
        secondaryFields: [
          { key: 'holder', label: 'Attendee', value: p.holderName ?? 'Guest' },
          ...(p.seatLabel ? [{ key: 'seat', label: 'Seat', value: p.seatLabel }] : []),
        ],
        auxiliaryFields: [
          { key: 'ref', label: 'Booking', value: p.bookingRef },
          ...(p.venueName ? [{ key: 'venue', label: 'Venue', value: p.venueName }] : []),
        ],
      },
    };
    return {
      provider: 'apple',
      status: cfg.status,
      mode: cfg.mode,
      descriptor,
      note:
        cfg.mode === 'sandbox'
          ? 'Sandbox descriptor — install requires a Pass Type ID certificate (production).'
          : 'Signed .pkpass generation requires the configured signing certificate.',
    };
  }
}
