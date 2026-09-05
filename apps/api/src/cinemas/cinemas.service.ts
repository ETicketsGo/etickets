import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Role, SessionStatus } from '@eticketsgo/shared-types';
import type {
  CreateCinemaInput,
  CreateScreenInput,
  UpdateCinemaInput,
  UpdateScreenInput,
} from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { AuditService } from '../audit/audit.service';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

@Injectable()
export class CinemasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    // Optional so existing specs constructing this service with two arguments keep working.
    @Optional() private readonly audit?: AuditService,
  ) {}

  private async loadOwnedCinema(user: RequestUser, id: string, roles = ORGANIZER_ROLES) {
    const cinema = await this.prisma.cinema.findUnique({ where: { id } });
    if (!cinema)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Cinema not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, cinema.organizationId, roles);
    return cinema;
  }

  private async loadOwnedScreen(user: RequestUser, id: string, roles = ORGANIZER_ROLES) {
    const screen = await this.prisma.screen.findUnique({
      where: { id },
      include: { cinema: { select: { organizationId: true } } },
    });
    if (!screen)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Screen not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, screen.cinema.organizationId, roles);
    return screen;
  }

  async create(user: RequestUser, organizationId: string, input: CreateCinemaInput) {
    await this.access.assertMember(user, organizationId, ORGANIZER_ROLES);
    if (input.venueId) {
      const venue = await this.prisma.venue.findUnique({ where: { id: input.venueId } });
      if (!venue || venue.organizationId !== organizationId) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          'Venue not found for this organization.',
          HttpStatus.NOT_FOUND,
        );
      }
    }
    /*
      A cinema with no venue gets one of its own, made from its own details.

      This is not bookkeeping. `ensureMovieEvent` needs a venue to hang the movie Event on,
      and when the cinema has none it falls back to ANY venue in the organization — or
      refuses with "No venue is available for this organization." if there are none.

      That refusal is what a brand-new theater actually hits. Found by running the
      onboarding path end to end on a fresh organization: cinema created, screen created,
      layout published, film published, and then scheduling the first show fails naming a
      concept the operator has never seen, cannot create (there is no venue endpoint in this
      API), and which no readiness check mentions. The onboarding checklist went green over
      a cinema that could not sell a ticket.

      Creating the venue here also stops the fallback being load-bearing. Borrowing another
      city's venue record is worse than the error: a Bengaluru show would be filed against a
      Mumbai venue and the public listing would say so.

      Cinemas created before this, and callers passing an explicit `venueId`, are untouched.
    */
    const venueId =
      input.venueId ??
      (
        await this.prisma.venue.create({
          data: {
            organizationId,
            name: input.name,
            city: input.city,
            address: input.address,
          },
          select: { id: true },
        })
      ).id;

    return this.prisma.cinema.create({
      data: {
        organizationId,
        venueId,
        name: input.name,
        brand: input.brand,
        city: input.city,
        address: input.address,
        latitude: input.latitude,
        longitude: input.longitude,
        /*
          Explicitly persisted, and this list is why.

          `create` enumerates its fields rather than spreading `input`, so a new field is
          silently dropped until somebody adds it here — which is exactly what happened: a
          Sydney cinema was created and stored as Asia/Kolkata, because the column default
          filled in for the value the caller actually supplied. It was invisible to every
          India fixture, where the default and the intended value are the same string.
        */
        timezone: input.timezone,
        // Regulatory classification. Optional everywhere, required in practice wherever a rate
        // order prices by it — and an unclassified cinema in such a place fails closed rather
        // than selling at a price nobody checked.
        country: input.country,
        region: input.region,
        district: input.district,
        localBodyType: input.localBodyType,
        cinemaFormat: input.cinemaFormat,
        climateType: input.climateType,
      },
      include: { screens: true },
    });
  }

  async update(user: RequestUser, id: string, patch: UpdateCinemaInput) {
    const cinema = await this.loadOwnedCinema(user, id);

    /*
      Changing the timezone of a cinema that already has shows is REFUSED.

      Show start times are stored as absolute instants, resolved through the venue's zone at
      the moment they were scheduled. Re-pointing the zone does not move them — it changes
      what those instants are ADVERTISED as. A 10:00 Hyderabad show becomes a 04:30 show if
      the cinema is re-declared as Europe/London, and every ticket already sold now names a
      time the customer will not turn up for.

      Silently reinterpreting them is the one outcome that must not happen, so this refuses
      rather than guessing. Correcting a genuinely wrong zone on a trading cinema is a data
      migration — the sessions have to be re-resolved deliberately — and that is a decision
      for a person, not a side effect of a form save.

      An empty cinema can be corrected freely, which is the case that actually matters during
      onboarding: an operator who picks the wrong zone before scheduling anything can fix it.
    */
    if (patch.timezone !== undefined && patch.timezone !== cinema.timezone) {
      const sessionCount = await this.prisma.eventSession.count({
        where: { screen: { cinemaId: id } },
      });
      if (sessionCount > 0) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          `This cinema has ${sessionCount} scheduled show${
            sessionCount === 1 ? '' : 's'
          }. Changing its timezone would re-advertise every one of them at a different local time, including shows that are already sold. Cancel or move them first, or contact support to migrate the schedule.`,
          HttpStatus.CONFLICT,
          { reason: 'TIMEZONE_LOCKED_BY_SHOWS', sessionCount },
        );
      }
    }

    return this.prisma.cinema.update({
      where: { id },
      data: patch,
      include: { screens: true },
    });
  }

  async listForOrg(user: RequestUser, organizationId: string) {
    await this.access.assertMember(user, organizationId);
    return this.prisma.cinema.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: { screens: true },
    });
  }

  async getForOrg(user: RequestUser, id: string) {
    await this.loadOwnedCinema(user, id, undefined);
    return this.prisma.cinema.findUnique({ where: { id }, include: { screens: true } });
  }

  // ─── Screens ───

  /**
   * A cinema's screens, each with the number of future shows on it.
   *
   * The count is included so the operator can be warned BEFORE taking a screen out of
   * service — "Screen 2 has 14 future shows" is the difference between an informed decision
   * and a surprise. Returning it only from the update response would mean showing the
   * consequence after the fact.
   *
   * One grouped query for the whole cinema rather than one per screen.
   */
  async listScreens(user: RequestUser, cinemaId: string) {
    await this.loadOwnedCinema(user, cinemaId, undefined);
    const screens = await this.prisma.screen.findMany({
      where: { cinemaId },
      orderBy: { createdAt: 'asc' },
    });
    if (screens.length === 0) return screens;

    const counts = await this.prisma.eventSession.groupBy({
      by: ['screenId'],
      where: {
        screenId: { in: screens.map((s) => s.id) },
        startsAt: { gt: new Date() },
        status: { not: SessionStatus.CANCELLED },
      },
      _count: { _all: true },
    });
    const byScreen = new Map(counts.map((c) => [c.screenId, c._count._all]));

    /*
      Whether each screen can actually host a show.

      A screen with no published seat layout cannot take a movie booking — scheduling one is
      refused. Until now nothing said so until the refusal, so the Schedule dialog listed
      every screen identically and the operator picked one by name and hoped. Reported from
      QA as not being able to tell the screens apart.

      One grouped query for the cinema, like the show counts above, rather than one per
      screen.
    */
    const mapped = await this.prisma.seatMap.groupBy({
      by: ['screenId'],
      where: { screenId: { in: screens.map((s) => s.id) }, status: 'PUBLISHED' },
      _count: { _all: true },
    });
    const hasMap = new Set(mapped.map((m) => m.screenId));

    return screens.map((s) => ({
      ...s,
      futureShowsRequiringAttention: byScreen.get(s.id) ?? 0,
      hasSeatMap: hasMap.has(s.id),
    }));
  }

  async addScreen(user: RequestUser, cinemaId: string, input: CreateScreenInput) {
    await this.loadOwnedCinema(user, cinemaId);
    return this.prisma.screen.create({
      data: {
        cinemaId,
        name: input.name,
        screenType: input.screenType,
        capacity: input.capacity,
      },
    });
  }

  /**
   * Update a screen, including its operational status.
   *
   * A status change deliberately does NOT touch shows already scheduled on the screen.
   * Cancelling a show somebody has paid for must be an explicit, audited, per-show act,
   * never a side effect of marking a room out of service. What the operator gets instead is
   * a COUNT of future shows that now need a decision — surfaced, not acted on.
   */
  async updateScreen(user: RequestUser, id: string, patch: UpdateScreenInput) {
    const screen = await this.loadOwnedScreen(user, id);
    const { statusReason, ...data } = patch;
    const updated = await this.prisma.screen.update({ where: { id }, data });

    if (patch.status && patch.status !== screen.status) {
      const futureShows = await this.prisma.eventSession.count({
        where: {
          screenId: id,
          startsAt: { gt: new Date() },
          status: { not: SessionStatus.CANCELLED },
        },
      });
      await this.audit?.record({
        actorUserId: user.id,
        organizationId: screen.cinema.organizationId,
        action: 'SCREEN_STATUS_CHANGED',
        entityType: 'Screen',
        entityId: id,
        metadata: {
          cinemaId: screen.cinemaId,
          from: screen.status,
          to: patch.status,
          reason: statusReason,
          futureShowsRequiringAttention: futureShows,
        },
      });
      return { ...updated, futureShowsRequiringAttention: futureShows };
    }
    return updated;
  }

  async removeScreen(user: RequestUser, id: string) {
    await this.loadOwnedScreen(user, id);
    await this.prisma.screen.delete({ where: { id } });
    return { success: true };
  }
}
