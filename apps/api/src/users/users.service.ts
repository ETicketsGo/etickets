import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Role, UserStatus, countryAliases, marketFor } from '@eticketsgo/shared-types';
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
        memberships: {
          select: { organizationId: true, role: true, status: true },
        },
      },
    });
    if (!user) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'User not found.', HttpStatus.NOT_FOUND);
    }
    return user;
  }

  async updateProfile(userId: string, fullName: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { fullName },
      select: { id: true, email: true, fullName: true, roles: true },
    });
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
          fullName: true,
          roles: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    const countries = await this.countriesFor(data.map((u) => u.id));
    return {
      data: data.map((u) => ({ ...u, countries: countries.get(u.id) ?? [] })),
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

    return {
      total,
      /** Accounts no country could be derived for - exactly the rows the list shows as unknown. */
      withoutCountry,
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
