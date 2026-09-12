import { AddOnsService } from './addons.service';
import { BundlesService } from './bundles.service';

/**
 * The public add-on and bundle lists answer only for a PUBLISHED event.
 *
 * Both routes are unauthenticated, and both answered for any event id — a draft, one under
 * review, one paused — which published an organizer's unreleased catalogue and prices to anybody
 * holding the id. The public event page already refuses anything that is not PUBLISHED; these
 * now follow the same rule.
 */

type Row = { eventId: string; enabled: boolean; event: { status: string } };
type Where = { eventId?: string; enabled?: boolean; event?: { status?: string } };

/*
  Stands in for the one query each method makes, and applies its `where` the way the database
  would — relation filter included. Asserting on the query object alone would pass for a filter
  that was spelled correctly and applied to nothing.
*/
function table<T extends Row>(rows: T[]) {
  return jest.fn(async ({ where }: { where: Where }) =>
    rows.filter(
      (r) =>
        (where.eventId === undefined || r.eventId === where.eventId) &&
        (where.enabled === undefined || r.enabled === where.enabled) &&
        (where.event?.status === undefined || r.event.status === where.event.status),
    ),
  );
}

describe('AddOnsService.publicListForEvent', () => {
  const addOn = (eventId: string, status: string) => ({
    id: `ao-${eventId}`,
    eventId,
    enabled: true,
    event: { status },
    type: 'MERCH',
    name: 'Tote bag',
    description: null,
    priceMinor: 49900,
    currency: 'INR',
    imageUrl: null,
    maxPerOrder: 4,
    salesStartAt: null,
    salesEndAt: null,
    inventory: { quantityTotal: 10, quantitySold: 0, quantityHeld: 0 },
  });
  const svc = new AddOnsService(
    {
      addOn: {
        findMany: table([
          addOn('ev-live', 'PUBLISHED'),
          addOn('ev-draft', 'DRAFT'),
          addOn('ev-paused', 'PAUSED'),
        ]),
      },
    } as never,
    {} as never,
    {} as never,
  );

  it('lists a published event’s add-ons', async () => {
    await expect(svc.publicListForEvent('ev-live')).resolves.toEqual([
      expect.objectContaining({ name: 'Tote bag', priceMinor: 49900 }),
    ]);
  });

  it.each(['ev-draft', 'ev-paused'])(
    'lists nothing for %s, which the public cannot see',
    async (eventId) => {
      await expect(svc.publicListForEvent(eventId)).resolves.toEqual([]);
    },
  );
});

describe('BundlesService.publicListForEvent', () => {
  const bundle = (eventId: string, status: string) => ({
    id: `b-${eventId}`,
    eventId,
    enabled: true,
    event: { status },
    salesStartAt: null,
    salesEndAt: null,
    items: [],
  });

  function service() {
    const svc = new BundlesService(
      {
        bundle: {
          findMany: table([bundle('ev-live', 'PUBLISHED'), bundle('ev-draft', 'DRAFT')]),
        },
      } as never,
      {} as never,
      {} as never,
    );
    // Pricing is not what is under test; a priced bundle with one component is enough to list.
    jest
      .spyOn(
        svc as unknown as { withPricing: (b: { id: string }) => Promise<unknown> },
        'withPricing',
      )
      .mockImplementation(async (b: { id: string }) => ({ id: b.id, components: [{}] }));
    return svc;
  }

  it('lists a published event’s bundles', async () => {
    await expect(service().publicListForEvent('ev-live')).resolves.toEqual([
      expect.objectContaining({ id: 'b-ev-live' }),
    ]);
  });

  it('lists nothing for a draft event', async () => {
    await expect(service().publicListForEvent('ev-draft')).resolves.toEqual([]);
  });
});
