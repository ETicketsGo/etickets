import { EventsService } from './events.service';

/**
 * The refund terms an organizer sets, and the ones the platform actually enforces.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────
 * `refundsEnabled` and `refundCutoffHours` have been on `Event` since the cut-off stopped
 * being a constant in platform code, and `RefundsService` reads both on every request. Nothing
 * ever WROTE them. Every event took the defaults — refunds on, 48 hours — while its organizer
 * typed their real terms into a free-text "Refund policy" box that no code path reads.
 *
 * So an organizer could write "no refunds" and the platform would go on offering them, or
 * write "up to a week before" and the platform would close at 48 hours. The buyer read the
 * prose; the software did something else; and the money moved according to the software.
 *
 * These assert that what the organizer chose is what gets stored.
 */
const ORGANIZER = { id: 'u-1', email: 'o@t.test', fullName: 'O', roles: [] } as never;

function setup() {
  const created = jest.fn().mockResolvedValue({ id: 'ev-1' });
  const prisma = {
    venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v-1', organizationId: 'org-1' }) },
    event: { create: created, findFirst: jest.fn().mockResolvedValue(null) },
  } as never;
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) } as never;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as never;
  const service = new EventsService(prisma, access, audit, {} as never, {} as never, {} as never);
  return { service, created };
}

const base = {
  title: 'Comedy Night',
  category: 'Comedy',
  venueId: 'v-1',
  feeMode: 'CUSTOMER_PAYS',
  isFree: false,
} as never;

describe('creating an event stores the refund RULE, not only the prose', () => {
  it('records "no refunds" when that is what was chosen', async () => {
    const { service, created } = setup();
    await service.create(ORGANIZER, 'org-1', {
      ...(base as object),
      refundPolicy: 'All sales final.',
      refundsEnabled: false,
    } as never);

    const data = created.mock.calls[0][0].data;
    expect(data.refundsEnabled).toBe(false);
    // The prose is still stored — it says WHY, and can carry conditions the rule cannot.
    expect(data.refundPolicy).toBe('All sales final.');
  });

  it('records the cut-off the organizer picked, including zero', async () => {
    const { service, created } = setup();
    await service.create(ORGANIZER, 'org-1', {
      ...(base as object),
      refundsEnabled: true,
      // 0 is a real answer — "right up to start time" — and must not be read as "unset".
      refundCutoffHours: 0,
    } as never);

    expect(created.mock.calls[0][0].data.refundCutoffHours).toBe(0);
  });

  it('carries a longer window through unchanged', async () => {
    const { service, created } = setup();
    await service.create(ORGANIZER, 'org-1', {
      ...(base as object),
      refundsEnabled: true,
      refundCutoffHours: 168,
    } as never);

    expect(created.mock.calls[0][0].data.refundCutoffHours).toBe(168);
  });

  it('leaves the schema defaults alone when nothing was said', async () => {
    /*
      An older client that does not send these must keep behaving exactly as it did: refunds
      on, 48 hours. Writing `undefined` explicitly would be the same thing, but writing a
      hardcoded 48 here would move the default out of the schema and into two places.
    */
    const { service, created } = setup();
    await service.create(ORGANIZER, 'org-1', base);

    const data = created.mock.calls[0][0].data;
    expect('refundsEnabled' in data).toBe(false);
    expect('refundCutoffHours' in data).toBe(false);
  });
});
