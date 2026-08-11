import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolvePaymentEnv } from '../payments/configuration/payment-environment';
import type { PaymentReadinessFacts } from './payment-readiness';
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
    private readonly config: ConfigService,
  ) {}

  /*
    What this environment can charge with — presence and mode only, never a value.

    Read from ConfigService rather than `process.env` so it goes through the same validated
    schema the payment module uses. The previous version read `process.env.PAYMENTS_MOCK_MODE`,
    a variable that exists nowhere else in this system: it was not in the schema, so it was
    never validated, and its only effect anywhere was to turn this check green.

    `PAYMENT_PROVIDER_NAME` is the switch that actually selects a gateway. The similarly named
    `PAYMENT_PROVIDER` is declared in the schema but read by no runtime code — reading it
    would have produced the same class of wrong answer.
  */
  private paymentFacts(): PaymentReadinessFacts {
    const nonEmpty = (key: string) => Boolean(this.config.get<string>(key)?.trim());
    return {
      environment: resolvePaymentEnv(this.config.get<string>('APP_ENV')),
      provider:
        this.config.get<PaymentReadinessFacts['provider']>('PAYMENT_PROVIDER_NAME') ?? 'mock',
      razorpay: {
        hasKeyId: nonEmpty('RAZORPAY_KEY_ID'),
        hasKeySecret: nonEmpty('RAZORPAY_KEY_SECRET'),
        hasWebhookSecret: nonEmpty('RAZORPAY_WEBHOOK_SECRET'),
        mode: this.config.get<string>('RAZORPAY_MODE') === 'live' ? 'live' : 'test',
      },
      liveEnabled: this.config.get<string>('PAYMENT_LIVE_ENABLED') === 'true',
    };
  }

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
      What upcoming shows would actually charge.

      Seat-category prices are a template for scheduling; the show's own ticket types are
      what a customer pays, and they can be edited afterwards without touching the layout.
      Reading only the template reported a cinema READY while tomorrow's show sold for
      nothing, so both are gathered and the show is the one that blocks.

      PAUSED shows count: a paused show is still scheduled and will resume, and finding out
      it is priced at zero the moment sales reopen is the failure this is here to prevent.
    */
    const futureTicketTypes = await this.prisma.eventSession.findMany({
      where: { screen: { cinemaId }, startsAt: { gte: now }, status: { not: 'CANCELLED' } },
      select: {
        id: true,
        ticketTypes: { where: { status: 'ACTIVE' }, select: { priceMinor: true } },
      },
    });
    const futureShowsWithZeroPrice = futureTicketTypes.filter(
      (s) => s.ticketTypes.length > 0 && s.ticketTypes.some((t) => t.priceMinor <= 0),
    ).length;
    const futureShowsPriced = futureTicketTypes.filter(
      (s) => s.ticketTypes.length > 0 && s.ticketTypes.every((t) => t.priceMinor > 0),
    ).length;

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
      futureShowsWithZeroPrice,
      futureShowsPriced,
      activeFeeRules,
      hasCancellationPolicy: policyEvents > 0,
      hasInrPaymentRoute: inrRoutes > 0,
      payments: this.paymentFacts(),
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
