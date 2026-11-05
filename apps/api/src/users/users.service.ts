import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  Role,
  UserStatus,
  countryAliases,
  isReservedEmail,
  marketFor,
  phoneCallingCode,
  phoneCallingCodeLabel,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async profile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        roles: true,
        status: true,
        createdAt: true,
        countryOfResidence: true,
        memberships: {
          select: { organizationId: true, role: true, status: true },
        },
      },
    });
    if (!user) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'User not found.', HttpStatus.NOT_FOUND);
    }
    // A phone-only account's placeholder address is never shown: it is not an email address.
    return { ...user, email: isReservedEmail(user.email) ? null : user.email };
  }

  /**
   * The person's own profile fields.
   *
   * `countryOfResidence` is the ONLY way that column is ever written: chosen here by the person,
   * or cleared with `null`. It is never inferred from a phone number, the network or bookings.
   */
  async updateProfile(
    userId: string,
    input: { fullName?: string; countryOfResidence?: string | null },
  ) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.countryOfResidence !== undefined
          ? { countryOfResidence: input.countryOfResidence }
          : {}),
      },
      select: { id: true, email: true, fullName: true, roles: true, countryOfResidence: true },
    });
    return { ...user, email: isReservedEmail(user.email) ? null : user.email };
  }

  /**
   * The filter the account directory is read through.
   *
   * ── WHY ROLE AND STATUS ARE FILTERED HERE AND NOT IN THE BROWSER ─────────────────
   * The console used to ask for page 1 and then drop the rows that did not match the role or
   * status somebody picked. So "show me the suspended accounts" returned the suspended accounts
   * AMONG THE FIRST TWENTY - usually none - while the pager underneath still said 340 results
   * and every page looked empty. A filter that silently applies to a page and not to the
   * directory is worse than no filter at all.
   */
  private directoryWhere(f: {
    query?: string;
    role?: Role;
    status?: UserStatus;
    country?: string;
  }): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = {};
    if (f.query) {
      where.OR = [
        { email: { contains: f.query, mode: 'insensitive' } },
        { fullName: { contains: f.query, mode: 'insensitive' } },
      ];
      /*
        A phone-only account has no name and no email, so a phone number is the only thing an
        operator can search it by - and they type it the way it is written on screen,
        "+91 98765 43210" or "469-588-4580", never as the stored "+919876543210". So the digits
        are compared against the stored number's digits. Four at least: fewer matches half the
        directory and finds nobody in particular.
      */
      const digits = f.query.replace(/\D/g, '');
      if (digits.length >= 4) where.OR.push({ phone: { contains: digits } });
    }
    if (f.role) where.roles = { has: f.role };
    if (f.status) where.status = f.status;
    if (f.country) {
      /*
        Every spelling of the country, because `Venue.country` and
        `Organization.registeredCountry` hold whatever was typed before the dropdown existed -
        "India", "india", "IN". Matching the canonical name alone would report an empty market.
      */
      const aliases = countryAliases(f.country);
      where.AND = [
        {
          OR: [
            {
              bookings: {
                some: { event: { venue: { country: { in: aliases, mode: 'insensitive' } } } },
              },
            },
            {
              memberships: {
                some: { organization: { registeredCountry: { in: aliases, mode: 'insensitive' } } },
              },
            },
          ],
        },
      ];
    }
    return where;
  }

  /**
   * Which countries an account belongs to, and how we know.
   *
   * ── WHY THIS IS DERIVED AND NOT A COLUMN ───────────────────────────────────────────
   * A `User` has no country and should not get one. Nobody is asked for it at sign-up, a locale
   * is a language setting rather than a place, and a phone calling code cannot tell the United
   * States from Canada - the market list says so in as many words, and guessing would put a
   * Canadian customer in a US report.
   *
   * What the platform does know is what the account DID: the countries of the venues it bought
   * tickets at, and the countries of the organizations it belongs to. Both are facts somebody
   * entered deliberately. An account with neither has no country, which is a real answer and is
   * reported as one rather than filled in with a default.
   */
  private async countriesFor(userIds: string[]): Promise<Map<string, string[]>> {
    if (userIds.length === 0) return new Map();
    const [bought, member] = await Promise.all([
      this.prisma.$queryRaw<{ userid: string; country: string | null }[]>`
        SELECT DISTINCT b."userId" AS userid, v."country" AS country
        FROM "Booking" b
        JOIN "Event" e ON e."id" = b."eventId"
        JOIN "Venue" v ON v."id" = e."venueId"
        WHERE b."userId" IN (${Prisma.join(userIds)})
      `,
      this.prisma.organizationMember.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, organization: { select: { registeredCountry: true } } },
      }),
    ]);

    const byUser = new Map<string, Set<string>>();
    const add = (userId: string, country: string | null | undefined) => {
      const market = marketFor(country);
      const name = market?.name ?? country?.trim();
      if (!name) return;
      const found = byUser.get(userId) ?? new Set<string>();
      found.add(name);
      byUser.set(userId, found);
    };
    for (const row of bought) add(row.userid, row.country);
    for (const row of member) add(row.userId, row.organization.registeredCountry);
    return new Map([...byUser.entries()].map(([id, set]) => [id, [...set].sort()]));
  }

  async list(
    page: number,
    pageSize: number,
    filters: { query?: string; role?: Role; status?: UserStatus; country?: string } = {},
  ) {
    const where = this.directoryWhere(filters);
    const [total, data] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          // So the console can show a phone-only account by its number, not its placeholder.
          phone: true,
          fullName: true,
          roles: true,
          status: true,
          createdAt: true,
          phoneVerifiedAt: true,
          countryOfResidence: true,
          detectedCountry: true,
          detectedCountrySource: true,
        },
      }),
    ]);

    const countries = await this.countriesFor(data.map((u) => u.id));
    return {
      data: data.map(({ phoneVerifiedAt, ...u }) => {
        const activity = countries.get(u.id) ?? [];
        // Only a VERIFIED number says anything; an unverified one is a claim.
        const verifiedPhone = phoneVerifiedAt ? u.phone : null;
        return {
          ...u,
          /** @deprecated read `activityCountries`; kept for an admin console older than it. */
          countries: activity,
          /** Countries the account bought tickets in or belongs to an organizer in. */
          activityCountries: activity,
          /** The verified number's calling code (`+91`): a fact about the NUMBER, not the person. */
          phoneCallingCode: phoneCallingCode(verifiedPhone),
          /** The same with the countries sharing it: `+1 (US/CA)`. */
          phoneCallingCodeLabel: phoneCallingCodeLabel(verifiedPhone),
        };
      }),
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  /**
   * The shape of the whole directory: how many accounts per country, per role, per status.
   *
   * Deliberately NOT narrowed by the console's filters. It is the map somebody reads to decide
   * what to filter by, and a map that redraws itself around the pin you just dropped is no use
   * for finding the next one.
   *
   * An account can belong to two countries - somebody who bought in India and in Canada - so the
   * country counts add up to more than the total, and the report says so rather than picking one.
   */
  async directorySummary() {
    const [total, byStatus, byCountryRaw, placedRows] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.$queryRaw<{ country: string | null; count: bigint }[]>`
        SELECT x.country AS country, COUNT(DISTINCT x.userid)::bigint AS count
        FROM (
          SELECT b."userId" AS userid, v."country" AS country
          FROM "Booking" b
          JOIN "Event" e ON e."id" = b."eventId"
          JOIN "Venue" v ON v."id" = e."venueId"
          WHERE b."userId" IS NOT NULL
          UNION
          SELECT m."userId" AS userid, o."registeredCountry" AS country
          FROM "OrganizationMember" m
          JOIN "Organization" o ON o."id" = m."organizationId"
        ) x
        WHERE x.country IS NOT NULL AND x.country <> ''
        GROUP BY 1
      `,
      /*
        ── "NOT KNOWN" HAS TO MEAN WHAT THE TABLE SHOWS ─────────────────────────────────
        This used to count accounts with no booking and no membership, which is NOT the same set
        as the accounts with no country: somebody who belongs to an organizer that has not said
        where it is registered has a membership and still has no country. The summary said 1 while
        four rows underneath read "Not known", and a number that disagrees with the list below it
        is worse than no number.

        So it is counted the same way the column is derived - accounts that appear nowhere in the
        country union - and the arithmetic holds.
      */
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT x.userid)::bigint AS count
        FROM (
          SELECT b."userId" AS userid, v."country" AS country
          FROM "Booking" b
          JOIN "Event" e ON e."id" = b."eventId"
          JOIN "Venue" v ON v."id" = e."venueId"
          WHERE b."userId" IS NOT NULL
          UNION
          SELECT m."userId" AS userid, o."registeredCountry" AS country
          FROM "OrganizationMember" m
          JOIN "Organization" o ON o."id" = m."organizationId"
        ) x
        WHERE x.country IS NOT NULL AND x.country <> ''
      `,
    ]);

    // Spellings fold together: "IN" and "India" are one market, counted once.
    const byCountry = new Map<string, number>();
    for (const row of byCountryRaw) {
      const name = marketFor(row.country)?.name ?? row.country?.trim();
      if (!name) continue;
      byCountry.set(name, (byCountry.get(name) ?? 0) + Number(row.count));
    }

    const roleCounts = await Promise.all(
      Object.values(Role).map(async (role) => ({
        role,
        count: await this.prisma.user.count({ where: { roles: { has: role } } }),
      })),
    );

    // Never negative, even if a row is added between the two counts.
    const withoutCountry = Math.max(0, total - Number(placedRows[0]?.count ?? 0));

    /*
      ── THE OTHER KINDS OF COUNTRY EVIDENCE, EACH COUNTED APART ────────────────────────
      Residence (what the person chose), the network at sign-up (a hint), and the verified
      phone's calling code (a fact about the number). Never added together: +1 is two
      countries, and a network hint is not a residence.
    */
    const [byResidenceRaw, byDetectedRaw, verifiedPhones, noEvidenceRows] = await Promise.all([
      this.prisma.user.groupBy({
        by: ['countryOfResidence'],
        where: { countryOfResidence: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.user.groupBy({
        by: ['detectedCountry'],
        where: { detectedCountry: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.user.findMany({
        where: { phone: { not: null }, phoneVerifiedAt: { not: null } },
        select: { phone: true },
      }),
      /*
        Accounts with NO evidence of any kind: no residence, no network country, no verified
        number, and nowhere in the activity union. The honest "nothing known" figure.
      */
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM "User" u
        WHERE u."countryOfResidence" IS NULL
          AND u."detectedCountry" IS NULL
          AND (u."phone" IS NULL OR u."phoneVerifiedAt" IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM "Booking" b
            JOIN "Event" e ON e."id" = b."eventId"
            JOIN "Venue" v ON v."id" = e."venueId"
            WHERE b."userId" = u."id" AND v."country" IS NOT NULL AND v."country" <> ''
          )
          AND NOT EXISTS (
            SELECT 1 FROM "OrganizationMember" m
            JOIN "Organization" o ON o."id" = m."organizationId"
            WHERE m."userId" = u."id"
              AND o."registeredCountry" IS NOT NULL AND o."registeredCountry" <> ''
          )
      `,
    ]);
    const byPhoneCode = new Map<string, number>();
    for (const { phone } of verifiedPhones) {
      const label = phoneCallingCodeLabel(phone) ?? 'Other';
      byPhoneCode.set(label, (byPhoneCode.get(label) ?? 0) + 1);
    }
    const counted = (rows: { key: string | null; count: number }[]) =>
      rows
        .filter((r): r is { key: string; count: number } => Boolean(r.key))
        .map((r) => ({ country: r.key, count: r.count }))
        .sort((a, b) => b.count - a.count);

    return {
      total,
      /**
       * Accounts with no ACTIVITY country (no booking, no organizer membership with one) -
       * exactly the rows whose "Active in" is empty. Not "country not known": such an account
       * may still have a residence, a network country or a verified number.
       */
      withoutCountry,
      /** Same number as `withoutCountry`, under the name that says what it counts. */
      withoutActivityCountry: withoutCountry,
      /** Accounts with no country evidence of ANY kind. */
      withoutAnyCountryEvidence: Number(noEvidenceRows[0]?.count ?? 0),
      /** Chosen by the person. */
      byResidence: counted(
        byResidenceRaw.map((r) => ({ key: r.countryOfResidence, count: r._count._all })),
      ),
      /** The network at sign-up - a hint. */
      byDetected: counted(
        byDetectedRaw.map((r) => ({ key: r.detectedCountry, count: r._count._all })),
      ),
      /** Verified numbers by calling code (`+1 (US/CA)`) - a fact about the number. */
      byPhoneCallingCode: [...byPhoneCode.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
      byCountry: [...byCountry.entries()]
        .map(([country, count]) => ({ country, count }))
        .sort((a, b) => b.count - a.count),
      byRole: roleCounts.filter((r) => r.count > 0).sort((a, b) => b.count - a.count),
      byStatus: byStatus
        .map((g) => ({ status: g.status, count: g._count._all }))
        .sort((a, b) => b.count - a.count),
    };
  }
}
