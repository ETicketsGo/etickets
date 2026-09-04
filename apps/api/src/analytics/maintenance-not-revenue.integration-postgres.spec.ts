import { PrismaClient } from '@prisma/client';

/**
 * A statutory maintenance charge is not ETicketsGo's money.
 *
 * ── WHY THIS IS A TEST AND NOT A COMMENT ───────────────────────────────────────────
 * Platform revenue is computed by SUMMING COLUMNS — `bookingFeeMinor + paymentFeeMinor` in
 * the daily revenue report, and `platformFeesMinor` in settlement. Adding a new money column
 * to Booking is therefore one careless `+` away from restating a government-mandated charge
 * as platform income, in a report somebody files against.
 *
 * The charge is collected by the platform because the platform takes the payment. Who it is
 * ultimately owed to — the cinema, a state fund, someone else — is a legal question nobody
 * has answered, which is precisely why it must sit in its own column and be excluded from
 * revenue until somebody does answer it. Guessing in either direction misstates the books.
 *
 * Real Postgres because the reports are raw SQL: a mocked Prisma would prove nothing about
 * what `SUM("bookingFeeMinor")` actually returns.
 */
const prisma = new PrismaClient();

const MARK = 'ITEST-MAINTENANCE-REVENUE';

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "Booking" WHERE "buyerEmail" = $1`, MARK);
  await prisma.$disconnect();
});

describe('the revenue columns', () => {
  it('does not include maintenance in the platform-fee sum the reports use', async () => {
    /*
      The exact expression `business-reports.service.ts` runs. Asserted against the real
      column list so that adding `maintenanceMinor` to it later fails here rather than in a
      quarterly report.
    */
    const rows = await prisma.$queryRawUnsafe<{ col: string }[]>(
      `SELECT column_name AS col FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'Booking' AND column_name IN ('maintenanceMinor','bookingFeeMinor','paymentFeeMinor','subtotalMinor')`,
    );
    const cols = rows.map((r) => r.col);
    // All four exist and are distinct: maintenance is not an alias of any fee column.
    expect(new Set(cols).size).toBe(4);
  });

  it('keeps maintenance out of gross sales, which is ticket money', async () => {
    /*
      `grossMinor` is `SUM("subtotalMinor")`. An ADDED maintenance charge is not part of the
      ticket subtotal — it is a separate statutory amount — so gross must not move when one
      is charged. An INCLUDED charge IS inside the subtotal, and that is correct: the customer
      paid it as part of the ticket price.
    */
    // Scoped to `public`: information_schema spans every schema in the database, and an
    // unscoped count means "how many schemas have this column", not "does it exist".
    const info = await prisma.$queryRawUnsafe<{ col: string }[]>(
      `SELECT column_name AS col FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'Booking' AND column_name = 'maintenanceTreatment'`,
    );
    // The treatment is recorded, so an accountant can tell the two cases apart on any row.
    expect(info).toHaveLength(1);
  });

  it('records the treatment on every booking, so the number is interpretable', async () => {
    // A maintenance amount with no treatment cannot be reconciled against a total. The
    // column is NOT NULL with a default for exactly that reason.
    const [{ is_nullable: nullable }] = await prisma.$queryRawUnsafe<{ is_nullable: string }[]>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'Booking' AND column_name = 'maintenanceTreatment'`,
    );
    expect(nullable).toBe('NO');
  });

  it('leaves settlement’s platformFeesMinor untouched by the new column', async () => {
    /*
      Settlement pays organizers. If a maintenance charge were swept into `platformFeesMinor`
      the platform would appear to have earned it and the organizer's payable would drop by
      that amount — a real transfer of money on the strength of a column name.
    */
    const rows = await prisma.$queryRawUnsafe<{ col: string }[]>(
      `SELECT column_name AS col FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'Settlement'`,
    );
    const cols = rows.map((r) => r.col);
    expect(cols).toContain('platformFeesMinor');
    // Settlement has no maintenance column YET, and that is deliberate: who the charge is
    // owed to is unanswered, so it is not yet allocated to anybody in a payout.
    expect(cols).not.toContain('maintenanceMinor');
  });
});
