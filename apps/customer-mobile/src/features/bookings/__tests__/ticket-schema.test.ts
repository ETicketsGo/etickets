import { z } from 'zod';
import { canPresentTicket, ticketSchema } from '../schema';
import { stripCredential } from '@/services/ticket-cache';

// ticket-cache imports AsyncStorage; these tests never touch storage.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

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

describe('transferred tickets (qrToken withheld by the server)', () => {
  it('accepts a null, missing or empty qrToken', () => {
    expect(ticketSchema.parse(ticket({ qrToken: null, qrDataUrl: null })).qrToken).toBeNull();
    const { qrToken: _omit, ...missing } = ticket();
    expect(ticketSchema.safeParse(missing).success).toBe(true);
    expect(ticketSchema.parse(ticket({ qrToken: '' })).qrToken).toBe('');
  });

  it('does not let a transferred ticket empty the wallet', () => {
    // REGRESSION (P0): qrToken was a required string, so one transferred ticket rejected the
    // array and the customer's Tickets screen showed nothing.
    const wallet = z
      .array(ticketSchema)
      .parse([ticket(), ticket({ id: 't2', qrToken: null, qrDataUrl: null })]);
    expect(wallet.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(wallet[0].qrToken).toBe('signed');
  });

  it('only a non-empty token is presentable', () => {
    expect(canPresentTicket({ qrToken: 'signed' })).toBe(true);
    expect(canPresentTicket({ qrToken: null })).toBe(false);
    expect(canPresentTicket({ qrToken: '' })).toBe(false);
    expect(canPresentTicket({})).toBe(false);
  });

  it('caches whether a ticket is presentable, never the token itself', () => {
    const valid = stripCredential(ticketSchema.parse(ticket()));
    expect(valid.presentable).toBe(true);
    expect('qrToken' in valid).toBe(false);
    expect(valid.qrDataUrl).toBe('data:image/png;base64,QR');

    const transferred = stripCredential(
      ticketSchema.parse(ticket({ qrToken: null, qrDataUrl: null })),
    );
    expect(transferred.presentable).toBe(false);
    expect('qrToken' in transferred).toBe(false);
  });
});
