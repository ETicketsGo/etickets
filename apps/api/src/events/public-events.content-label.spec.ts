import { PublicEventsService } from './public-events.service';
import { AdvertisedPriceService } from '../pricing/advertised-price.service';

const advertised = new AdvertisedPriceService(
  { feeRule: { findMany: async () => [] } } as never,
  { get: () => undefined } as never,
);

const row = (id: string, organizationId: string) => ({
  id,
  organizationId,
  title: id,
  slug: id,
  category: 'Music',
  feeMode: 'ADDED',
  venue: { name: 'V', city: 'Pune', country: 'IN', region: null, timezone: null },
  organization: { name: 'Org' },
  images: [],
  sessions: [],
});

/** Newest first, as the database returns them: the two TEST fixtures are newer than the demo. */
const ALL = [row('t1', 'org-test'), row('t2', 'org-test'), row('d1', 'org-demo')];

function makeService() {
  const findMany = jest.fn(async (args: { select?: unknown; where: unknown }) => {
    if (args.select) return ALL.map((r) => ({ id: r.id, organizationId: r.organizationId }));
    const ids = (args.where as { AND?: { id?: { in: string[] } }[] }).AND?.[1]?.id?.in;
    // The database returns the page in its own (newest first) order; the service must reorder.
    return ALL.filter((r) => !ids || ids.includes(r.id));
  });
  const prisma = {
    event: { count: jest.fn(), findMany },
    $transaction: jest.fn(async (qs: Promise<unknown>[]) => Promise.all(qs)),
  };
  return new PublicEventsService(prisma as never, advertised);
}

describe('PublicEventsService.list content labels', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('labels each card and puts DEMO before TEST across pages, dropping nothing', async () => {
    process.env.APP_ENV = 'QA';
    process.env.DEMO_ORGANIZATION_IDS = 'org-demo';
    const service = makeService();
    const page1 = await service.list({ page: 1, pageSize: 2 });
    expect(page1.data.map((e) => [e.id, e.contentLabel])).toEqual([
      ['d1', 'DEMO'],
      ['t1', 'TEST'],
    ]);
    const page2 = await service.list({ page: 2, pageSize: 2 });
    expect(page2.data.map((e) => [e.id, e.contentLabel])).toEqual([['t2', 'TEST']]);
  });

  it('is label-free and unreordered in PRODUCTION even with demo organizations set', async () => {
    process.env.APP_ENV = 'PRODUCTION';
    process.env.DEMO_ORGANIZATION_IDS = 'org-demo';
    const result = await makeService().list({ page: 1, pageSize: 10 });
    expect(result.data.map((e) => [e.id, e.contentLabel])).toEqual([
      ['t1', null],
      ['t2', null],
      ['d1', null],
    ]);
  });
});
