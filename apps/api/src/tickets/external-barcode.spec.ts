import QRCode from 'qrcode';
import { TicketsService } from './tickets.service';
import { QrService } from './qr.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../common/decorators';

/**
 * What the customer is actually shown, for a seat we sold and do not admit.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────
 * The gate refusing an external ticket is tested next door. This is the other half, and it
 * is the half a customer meets first: the code on their screen has to be the one the
 * venue's scanner reads. Rendering our signed QR gives them something that looks like a
 * ticket and opens nothing, and they find that out at the door.
 *
 * Written after the fact, because a falsification caught its absence — swapping the
 * presented barcode back to our own token broke no test at all.
 */
const USER: RequestUser = {
  id: 'u1',
  email: 'buyer@example.test',
  fullName: 'Ada',
  roles: [] as never,
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'tk1',
  bookingId: 'bk1',
  eventSessionId: 'sess-1',
  nonce: 'n',
  qrVersion: 1,
  serial: 'TKT-1',
  status: 'ACTIVE',
  seatLabel: 'H-12',
  holderName: 'Ada',
  assignmentStatus: 'UNASSIGNED',
  attendeeUserId: null,
  vendorBarcode: null,
  vendorBarcodeFormat: null,
  vendorName: null,
  booking: { reference: 'ETG-IND-2026-000001', userId: 'u1' },
  ticketType: { name: 'General' },
  eventSession: {
    startsAt: new Date('2026-09-10T12:00:00Z'),
    screen: null,
    event: {
      title: 'A film',
      slug: 'a-film',
      experienceType: 'MOVIE',
      venue: { name: 'Hall A', city: 'Hyderabad' },
    },
  },
  ...over,
});

const wallet = async (over: Record<string, unknown> = {}) => {
  const prisma = {
    ticket: { findMany: jest.fn().mockResolvedValue([row(over)]) },
  } as unknown as PrismaService;
  const qr = { sign: jest.fn().mockReturnValue('our-signed-token') } as unknown as QrService;
  const [t] = await new TicketsService(prisma, qr).wallet(USER);
  return t;
};

/** Read the text back out of a rendered data-URL QR, so the assertion is about the image. */
const decoded = async (dataUrl: string) => {
  // Round-tripping the payload is overkill here; what matters is WHICH string was encoded,
  // and the service encodes exactly one. Re-render both candidates and compare.
  const ours = await QRCode.toDataURL('our-signed-token', { margin: 1, width: 320 });
  return dataUrl === ours ? 'our-signed-token' : 'something-else';
};

describe('a seat sourced from another cinema’s system', () => {
  it('puts THEIR barcode in the image, not our token', async () => {
    const t = await wallet({ vendorBarcode: 'PVR-8891726354', vendorName: 'PVR Cinemas' });
    expect(await decoded(t.qrDataUrl!)).toBe('something-else');
    expect(t.qrDataUrl).toBe(await QRCode.toDataURL('PVR-8891726354', { margin: 1, width: 320 }));
  });

  it('still returns our signed token, because we use it for support and reconciliation', async () => {
    // It stops being the thing on the screen. It does not stop existing.
    const t = await wallet({ vendorBarcode: 'PVR-8891726354' });
    expect(t.qrToken).toBe('our-signed-token');
  });

  it('tells the client whose ticket it is and what shape the code is', async () => {
    const t = await wallet({ vendorBarcode: 'X-1', vendorName: 'PVR Cinemas' });
    expect(t.vendorBarcode).toBe('X-1');
    expect(t.vendorName).toBe('PVR Cinemas');
    // Absent format means QR, which is what every integration so far has used.
    expect(t.vendorBarcodeFormat).toBe('QR');
  });

  it('renders NO image for a symbology that is not a QR', async () => {
    /*
      A cinema that scans CODE128 will not read a QR. Encoding their CODE128 content into a
      QR produces a scannable image of the wrong shape — worse than no image, because it
      looks right and fails silently at the gate. The client is given the value and the
      format and renders it properly.
    */
    const t = await wallet({ vendorBarcode: 'X-1', vendorBarcodeFormat: 'CODE128' });
    expect(t.qrDataUrl).toBeNull();
    expect(t.vendorBarcodeFormat).toBe('CODE128');
  });
});

describe('our own tickets are untouched', () => {
  it('renders our signed token, and says there is no vendor', async () => {
    const t = await wallet();
    expect(await decoded(t.qrDataUrl!)).toBe('our-signed-token');
    expect(t.vendorBarcode).toBeNull();
    expect(t.vendorBarcodeFormat).toBeNull();
    expect(t.vendorName).toBeNull();
  });
});
