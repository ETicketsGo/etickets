import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CinemaLegalTypeInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';

/** The audit action written when the platform team changes a cinema's legal type. */
export const CINEMA_LEGAL_TYPE_CHANGED = 'CINEMA_LEGAL_TYPE_CHANGED';

const WORDS: Record<string, string> = {
  MUNICIPAL_CORPORATION: 'Municipal corporation',
  MUNICIPALITY: 'Municipality',
  NAGAR_PANCHAYAT: 'Nagar panchayat',
  GRAM_PANCHAYAT: 'Gram panchayat',
  OTHER: 'Other local body',
  MULTIPLEX: 'Multiplex',
  SINGLE_SCREEN: 'Single screen',
  SPECIAL_THEATRE: 'Special theatre',
  AC: 'Air-conditioned',
  AIR_COOLED: 'Air-cooled',
  NON_AC: 'Not air-conditioned',
};

interface LegalType {
  localBodyType: string | null;
  cinemaFormat: string | null;
  climateType: string | null;
}

/** "Municipal corporation, Multiplex, Air-conditioned", or "not set" for each gap. */
export function legalTypeWords(t: LegalType): string {
  return [t.localBodyType, t.cinemaFormat, t.climateType]
    .map((v) => (v ? (WORDS[v] ?? v) : 'not set'))
    .join(', ');
}

const ROW_SELECT = {
  id: true,
  name: true,
  city: true,
  country: true,
  region: true,
  localBodyType: true,
  cinemaFormat: true,
  climateType: true,
  updatedAt: true,
  organization: { select: { id: true, name: true } },
  venue: { select: { id: true, name: true, city: true, region: true, country: true } },
} satisfies Prisma.CinemaSelect;

type Row = Prisma.CinemaGetPayload<{ select: typeof ROW_SELECT }>;

/** One cinema as the admin screen lists it: where it is (venue first) and its legal type. */
function view(c: Row) {
  return {
    id: c.id,
    name: c.name,
    organization: c.organization,
    venueName: c.venue?.name ?? null,
    // The venue is the place record; the cinema's own columns only fill a gap in an old row.
    city: c.venue?.city ?? c.city ?? null,
    region: c.venue?.region ?? c.region ?? null,
    country: c.venue?.country ?? c.country ?? null,
    localBodyType: c.localBodyType,
    cinemaFormat: c.cinemaFormat,
    climateType: c.climateType,
    updatedAt: c.updatedAt.toISOString(),
  };
}

/**
 * A cinema's legal type, set by the platform team.
 *
 * ── WHY IT IS THE PLATFORM'S ───────────────────────────────────────────────────────
 * Local body, format and cooling choose the row of a state rate order a cinema is priced under,
 * which is the most its tickets may cost. An organizer choosing them would be choosing their own
 * price limit, so `CinemasService` refuses them from an organizer and this is the only writer.
 *
 * ── WHY THE CHANGE AND ITS AUDIT ARE ONE TRANSACTION ───────────────────────────────
 * `AuditService.record` swallows its own failures, which is right for a read log and wrong here:
 * a price limit that changed with no record of who changed it, from what, and why is the one
 * outcome this screen exists to prevent. So the audit row is written in the same transaction as
 * the change, and if it cannot be written the change does not happen.
 */
@Injectable()
export class CinemaLegalTypeService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: { q?: string; page: number; pageSize: number }) {
    const term = q.q?.trim();
    const where: Prisma.CinemaWhereInput = term
      ? {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { city: { contains: term, mode: 'insensitive' } },
            { organization: { name: { contains: term, mode: 'insensitive' } } },
            { venue: { name: { contains: term, mode: 'insensitive' } } },
            { venue: { city: { contains: term, mode: 'insensitive' } } },
            { venue: { region: { contains: term, mode: 'insensitive' } } },
            { id: term },
          ],
        }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.cinema.findMany({
        where,
        select: ROW_SELECT,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.cinema.count({ where }),
    ]);
    return {
      data: rows.map(view),
      meta: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
      },
    };
  }

  async set(actorUserId: string, id: string, input: CinemaLegalTypeInput) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.cinema.findUnique({ where: { id }, select: ROW_SELECT });
      if (!before) {
        throw new AppException(ErrorCodes.NOT_FOUND, 'Cinema not found.', HttpStatus.NOT_FOUND);
      }
      const after = await tx.cinema.update({
        where: { id },
        data: {
          localBodyType: input.localBodyType,
          cinemaFormat: input.cinemaFormat,
          climateType: input.climateType,
        },
        select: ROW_SELECT,
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          organizationId: before.organization.id,
          action: CINEMA_LEGAL_TYPE_CHANGED,
          entityType: 'Cinema',
          entityId: id,
          metadata: {
            before: {
              localBodyType: before.localBodyType,
              cinemaFormat: before.cinemaFormat,
              climateType: before.climateType,
            },
            after: {
              localBodyType: after.localBodyType,
              cinemaFormat: after.cinemaFormat,
              climateType: after.climateType,
            },
            // Read out by the console's history as written, so a support person can say it.
            change: `${legalTypeWords(before)} -> ${legalTypeWords(after)}`,
            reason: input.reason,
          },
        },
      });
      return view(after);
    });
  }
}
