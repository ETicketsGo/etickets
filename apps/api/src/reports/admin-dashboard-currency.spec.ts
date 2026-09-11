import { ReportsService } from './reports.service';

/**
 * The platform overview's money, one currency at a time.
 *
 * Reported from QA: "Gross merchandise value ₹11,389.60" was rupees, US dollars and Canadian
 * dollars added together and printed with a rupee sign. These tests pin that every figure is
 * grouped by the currency the booking was sold in, refunds included — which carry no currency
 * of their own and take their booking's.
 */
describe('ReportsService.adminDashboard — money per currency', () => {
  function setup(paid: object[], refunds: object[]) {
    const prisma = {
      booking: {
        groupBy: jest.fn().mockResolvedValue(paid),
        count: jest.fn().mockResolvedValue(40),
      },
      $queryRaw: jest.fn().mockResolvedValue(refunds),
      organization: { count: jest.fn().mockResolvedValue(3) },
      event: { count: jest.fn().mockResolvedValue(9) },
      payment: { count: jest.fn().mockResolvedValue(2) },
      payout: { count: jest.fn().mockResolvedValue(1) },
    };
    const service = new ReportsService(prisma as never, {} as never);
    return { service, prisma };
  }

  const row = (
    currency: string,
    total: number,
    bookingFee: number,
    paymentFee: number,
    count: number,
  ) => ({
    currency,
    _sum: { totalMinor: total, bookingFeeMinor: bookingFee, paymentFeeMinor: paymentFee },
    _count: { _all: count },
  });

  it('never adds rupees to dollars', async () => {
    const { service } = setup(
      [row('INR', 1_000_000, 20_000, 10_000, 30), row('USD', 12_000, 300, 200, 2)],
      [
        { currency: 'INR', amountMinor: BigInt(179_900) },
        { currency: 'USD', amountMinor: 4_000 },
      ],
    );
    const d = await service.adminDashboard();
    expect(d.money).toEqual([
      {
        currency: 'INR',
        gmvMinor: 1_000_000,
        platformRevenueMinor: 30_000,
        refundVolumeMinor: 179_900,
        paidBookings: 30,
      },
      {
        currency: 'USD',
        gmvMinor: 12_000,
        platformRevenueMinor: 500,
        refundVolumeMinor: 4_000,
        paidBookings: 2,
      },
    ]);
  });

  it('puts the biggest market first, so the page opens on it', async () => {
    const { service } = setup([row('CAD', 5_000, 0, 0, 1), row('INR', 900_000, 0, 0, 9)], []);
    const d = await service.adminDashboard();
    expect(d.money.map((m) => m.currency)).toEqual(['INR', 'CAD']);
  });

  it('lists a currency that only has refunds, rather than dropping the money', async () => {
    const { service } = setup([], [{ currency: 'cad', amountMinor: 2_500 }]);
    const d = await service.adminDashboard();
    expect(d.money).toEqual([
      {
        currency: 'CAD',
        gmvMinor: 0,
        platformRevenueMinor: 0,
        refundVolumeMinor: 2_500,
        paidBookings: 0,
      },
    ]);
  });

  it('groups paid bookings by currency in the query itself', async () => {
    const { service, prisma } = setup([], []);
    await service.adminDashboard();
    expect(prisma.booking.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['currency'], where: { confirmedAt: { not: null } } }),
    );
  });
});
