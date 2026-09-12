import { z } from 'zod';
import { ticketSchema } from '../schema';

const ticket = (overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  serial: 'ETG-1',
  status: 'ACTIVE',
  holderName: null,
  ticketType: 'Normal',
  event: { title: 'Show', slug: 'show' },
  startsAt: '2026-10-01T14:00:00.000Z',
  qrToken: 'signed',
  qrDataUrl: 'data:image/png;base64,QR',
  bookingId: 'b1',
  bookingRef: 'ETG-IN-2026-1',
  experienceType: 'MOVIE',
  seatLabel: 'A1',
  venueName: null,
  screenName: null,
  cinemaName: null,
  assignmentStatus: 'UNASSIGNED',
  attendeeName: null,
  ownedByViewer: true,
  assignedToViewer: false,
  ...overrides,
});

describe('ticket contract', () => {
  it('accepts a ticket whose vendor barcode has no QR image', () => {
    expect(ticketSchema.parse(ticket({ qrDataUrl: null })).qrDataUrl).toBeNull();
  });

  it('does not let one such ticket fail the whole wallet', () => {
    // REGRESSION: `qrDataUrl` was a required string, so a single null rejected the array
    // and the wallet showed nothing at all.
    const wallet = z
      .array(ticketSchema)
      .safeParse([ticket(), ticket({ id: 't2', qrDataUrl: null })]);
    expect(wallet.success).toBe(true);
  });
});
