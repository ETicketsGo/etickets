import { HttpStatus, Injectable } from '@nestjs/common';
import { Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import {
  evaluatePilotReadiness,
  overallReadiness,
  READINESS_SECTIONS,
  type ReadinessCheck,
  type ReadinessFacts,
  type ReadinessLevel,
} from './pilot-readiness';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

export interface PilotReadinessReport {
  cinemaId: string;
  cinemaName: string;
  timezone: string;
  overall: ReadinessLevel;
  blockers: number;
  warnings: number;
  sections: { section: string; level: ReadinessLevel; checks: ReadinessCheck[] }[];
  evaluatedAt: Date;
}

/**
 * Gathers the facts the readiness rules need, in one pass.
 *
 * The rules live in `pilot-readiness.ts` and decide everything; this class only reads the
 * database. Keeping the two apart is what makes it possible to test "a single operator is a
 * warning, not a blocker" without standing up a cinema.
 */
@Injectable()
export class PilotReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
  ) {}

  async evaluate(user: RequestUser, cinemaId: string): Promise<PilotReadinessReport> {
    const cinema = await this.prisma.cinema.findUnique({
      where: { id: cinemaId },
      include: { organization: true, screens: true },
    });
    if (!cinema) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Cinema not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, cinema.organizationId, ORGANIZER_ROLES);

    const now = new Date();
    const activeScreens = cinema.screens.filter((s) => s.status === 'ACTIVE');

    /*
      An in-service screen with no PUBLISHED layout cannot sell a seat, and the failure only
      shows up when somebody tries to schedule on it. Checked per screen so the report can
      name the offenders rather than reporting a count an operator then has to hunt through.
    */
    const publishedByScreen = await this.prisma.seatMap.groupBy({
      by: ['screenId'],
      where: { screenId: { in: activeScreens.map((s) => s.id) }, status: 'PUBLISHED' },
      _count: { _all: true },
    });
    const hasLayout = new Set(publishedByScreen.map((r) => r.screenId));
    const activeScreensWithoutPublishedLayout = activeScreens
      .filter((s) => !hasLayout.has(s.id))
      .map((s) => s.name);

    const [operatorCount, categories, activeFeeRules, futureShows, policyEvents, inrRoutes] =
      await Promise.all([
        this.prisma.organizationMember.count({
          where: { organizationId: cinema.organizationId, role: { in: ORGANIZER_ROLES } },
        }),
        this.prisma.seatCategory.findMany({
          where: {
            seatMap: { screenId: { in: activeScreens.map((s) => s.id) }, status: 'PUBLISHED' },
          },
          select: { basePriceMinor: true },
        }),
        this.prisma.feeRule.count({ where: { active: true, currency: 'INR' } }),
        this.prisma.eventSession.count({
          where: {
            screen: { cinemaId },
            startsAt: { gte: now },
            status: { not: 'CANCELLED' },
          },
        }),
        this.prisma.event.count({
          where: { organizationId: cinema.organizationId, refundPolicy: { not: null } },
        }),
        this.prisma.paymentRoute.count({ where: { currency: 'INR', active: true } }).catch(() => 0),
      ]);

    /*
      "Discoverable" means a PUBLISHED film actually has a future show here. Shows can exist
      against a draft film, in which case the schedule looks healthy and the public listing is
      empty — a failure that is invisible from the organizer side.
    */
    const publicCatalogueReachable =
      (await this.prisma.eventSession.count({
        where: {
          screen: { cinemaId },
          startsAt: { gte: now },
          status: { not: 'CANCELLED' },
          event: { status: 'PUBLISHED', movie: { status: 'PUBLISHED' } },
        },
      })) > 0;

    const facts: ReadinessFacts = {
      cinemaId,
      organization: {
        status: cinema.organization.status,
        contactEmail: cinema.organization.contactEmail,
        contactPhone: cinema.organization.contactPhone,
      },
      cinema: {
        timezone: cinema.timezone,
        status: cinema.status,
        address: cinema.address,
        city: cinema.city,
      },
      activeScreens: activeScreens.length,
      totalScreens: cinema.screens.length,
      activeScreensWithoutPublishedLayout,
      operatorCount,
      pricedCategories: categories.filter((c) => c.basePriceMinor > 0).length,
      unpricedCategories: categories.filter((c) => c.basePriceMinor <= 0).length,
      activeFeeRules,
      hasCancellationPolicy: policyEvents > 0,
      hasInrPaymentRoute: inrRoutes > 0,
      // Non-secret: whether the environment can resolve credentials at all. The values are
      // never read here and must never appear in a readiness response.
      paymentProviderConfigured: Boolean(
        process.env.RAZORPAY_KEY_ID || process.env.PAYMENTS_MOCK_MODE === 'true',
      ),
      futurePublishedShows: futureShows,
      publicCatalogueReachable,
    };

    const checks = evaluatePilotReadiness(facts);
    return {
      cinemaId,
      cinemaName: cinema.name,
      timezone: cinema.timezone,
      overall: overallReadiness(checks),
      blockers: checks.filter((c) => c.level === 'BLOCKED').length,
      warnings: checks.filter((c) => c.level === 'WARNING').length,
      sections: READINESS_SECTIONS.map((section) => {
        const forSection = checks.filter((c) => c.section === section);
        return {
          section,
          level: overallReadiness(forSection),
          checks: forSection,
        };
      }).filter((s) => s.checks.length > 0),
      evaluatedAt: now,
    };
  }
}
