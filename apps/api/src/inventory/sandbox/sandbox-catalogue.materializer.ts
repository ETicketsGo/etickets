import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { CinemasService } from '../../cinemas/cinemas.service';
import { MoviesService } from '../../movies/movies.service';
import { ShowsService } from '../../shows/shows.service';
import { QubeMockInventoryProvider } from '../sourcing/providers/qube/qube-mock.provider';
import { QUBE_MOCK_PROVIDER_CODE } from '../sourcing/providers/qube/qube-mock.fixture';
import type { ExternalSeat, ExternalSeatMap } from '../sourcing/cinema-capabilities.interface';

/**
 * Turns a SANDBOX provider's mapped catalogue into real internal entities.
 *
 * ── WHY THIS IS NOT A GENERIC IMPORTER ─────────────────────────────────────────────
 * ADR-040 ingests a provider's catalogue, records identity in `ProviderMapping`, and stops
 * at `status: UNMAPPED` — "no internal entity linked yet — resolved by ops". That is a
 * DECISION, not an omission. A feed that can create and publish internal entities is a feed
 * that can rename your storefront, and one that can retract them is one that can unpublish a
 * show people are holding tickets for. Neither should be possible without a person.
 *
 * So this does not change ADR-040 and does not run for real providers. It exists so the
 * sandbox can be driven end to end — catalogue in, ticket out — without inventing a
 * production auto-publisher to do it. For any provider that is not the sandbox it refuses,
 * loudly, and the production path stays exactly where it was: an operator reviews the
 * UNMAPPED queue and approves each link. See `docs/integrations/catalogue-governance.md`.
 *
 * ── WHY IT CALLS THE ORDINARY PRODUCT SERVICES ─────────────────────────────────────
 * It is an automated OPERATOR, not a back door. Every entity is created through the same
 * `CinemasService` / `MoviesService` / `ShowsService` calls an organizer would make, as an
 * actor with real organization membership, so tenancy checks, scheduling conflict rules,
 * seat-layout versioning and audit all apply. Writing rows directly would have been shorter
 * and would have proved nothing: the interesting question is whether an imported catalogue
 * survives the platform's own rules, and the honest way to ask is to make it go through them.
 *
 * It found one answer immediately — the fixture's original showtimes were unschedulable in a
 * real room, because the sandbox has no concept of turning a screen round between films.
 *
 * ── IDENTITY ───────────────────────────────────────────────────────────────────────
 * Nothing is ever matched by title, name or start time. The only link is the external id
 * recorded in `ProviderMapping`, which is why a second run creates nothing and a moved show
 * moves rather than duplicating.
 */

export interface SandboxMaterializationRequest {
  providerCode: string;
  providerTenantId?: string;
  /** The organization the imported cinema belongs to. */
  organizationId: string;
  /** The operator this runs as. Ordinary membership checks apply to it. */
  actor: RequestUser;
  /**
   * OUR price per external seat category, in minor units.
   *
   * Required, with no fallback to the provider's own numbers. A vendor's prices are advisory
   * metadata — ETicketsGo prices its own sales through its own pricing, fee and tax engine,
   * including ceilings a remote POS knows nothing about. Defaulting to the vendor's figure
   * would make "we never charge a number we did not decide" true only by accident.
   */
  pricingByCategory: Record<string, number>;
}

export interface SandboxMaterializationReport {
  cinemas: { created: number; linked: number };
  screens: { created: number; linked: number };
  movies: { created: number; linked: number };
  shows: { created: number; linked: number; rescheduled: number };
  /** External ids that could not be materialized, with the reason. Never silently dropped. */
  skipped: Array<{ externalEntityType: string; externalEntityId: string; reason: string }>;
}

/** Internal entity types recorded in `ProviderMapping.internalEntityType`. */
const INTERNAL = {
  CINEMA: 'cinema',
  SCREEN: 'screen',
  MOVIE: 'movie',
  SESSION: 'eventSession',
  SEAT: 'seat',
  SEAT_CATEGORY: 'seatCategory',
} as const;

@Injectable()
export class SandboxCatalogueMaterializer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly cinemas: CinemasService,
    private readonly movies: MoviesService,
    private readonly shows: ShowsService,
    private readonly sandbox: QubeMockInventoryProvider,
  ) {}

  /**
   * Three independent conditions, all of which must hold.
   *
   * The flag alone is not enough. `APP_ENV` is checked separately because every deployed
   * environment runs `NODE_ENV=production` — asking the wrong one is a mistake this codebase
   * has already made twice — and the provider code is checked because a switch named for a
   * sandbox must not become a generic auto-publisher the first time somebody adds a provider.
   */
  get enabled(): boolean {
    return (
      this.config.get<boolean>('INVENTORY_SANDBOX_MATERIALIZATION_ENABLED') === true &&
      !this.isProdLike()
    );
  }

  private isProdLike(): boolean {
    const env = String(this.config.get<string>('APP_ENV') ?? 'LOCAL').toUpperCase();
    return env === 'PRODUCTION' || env === 'PROD' || env === 'STAGING' || env === 'UAT';
  }

  async materialize(req: SandboxMaterializationRequest): Promise<SandboxMaterializationReport> {
    if (req.providerCode !== QUBE_MOCK_PROVIDER_CODE) {
      throw new AppException(
        ErrorCodes.INVENTORY_SOURCE_UNSUPPORTED,
        `Catalogue materialization is a sandbox facility and is not available for '${req.providerCode}'. ` +
          'A real provider catalogue is reviewed and approved by an operator.',
        HttpStatus.FORBIDDEN,
        { providerCode: req.providerCode },
      );
    }
    if (!this.enabled) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Sandbox catalogue materialization is disabled in this environment.',
        HttpStatus.FORBIDDEN,
      );
    }

    const tenantId = req.providerTenantId ?? '';
    const report: SandboxMaterializationReport = {
      cinemas: { created: 0, linked: 0 },
      screens: { created: 0, linked: 0 },
      movies: { created: 0, linked: 0 },
      shows: { created: 0, linked: 0, rescheduled: 0 },
      skipped: [],
    };

    // Dependency order. A show needs its room and its film to exist first, and the ordering
    // is explicit here rather than inherited from whatever order the feed happened to arrive
    // in — a paged feed makes no promises about that.
    await this.materializeCinemas(req, tenantId, report);
    await this.materializeScreens(req, tenantId, report);
    await this.materializeMovies(req, tenantId, report);
    await this.materializeShows(req, tenantId, report);
    return report;
  }

  // ── cinemas ────────────────────────────────────────────────────────────────────

  private async materializeCinemas(
    req: SandboxMaterializationRequest,
    tenantId: string,
    report: SandboxMaterializationReport,
  ): Promise<void> {
    const cinemas = await this.sandbox.getCinemas();
    for (const mapping of await this.mappings(req.providerCode, tenantId, 'VENUE')) {
      const external = cinemas.find((c) => c.externalId === mapping.externalEntityId);
      if (!external) {
        report.skipped.push({
          externalEntityType: 'VENUE',
          externalEntityId: mapping.externalEntityId,
          reason: 'not_in_provider_catalogue',
        });
        continue;
      }
      if (await this.stillLinked(mapping, INTERNAL.CINEMA, 'cinema')) {
        report.cinemas.linked += 1;
        continue;
      }
      const cinema = await this.cinemas.create(req.actor, req.organizationId, {
        name: external.name,
        city: external.city ?? 'Unknown',
        // The venue's own zone, never the server's. A showtime without one is not a time.
        timezone: external.timezone ?? 'Asia/Kolkata',
      } as never);
      await this.link(mapping.id, INTERNAL.CINEMA, (cinema as { id: string }).id);
      report.cinemas.created += 1;
    }
  }

  // ── screens (and the seat layout that makes a room sellable) ───────────────────

  private async materializeScreens(
    req: SandboxMaterializationRequest,
    tenantId: string,
    report: SandboxMaterializationReport,
  ): Promise<void> {
    const screens = await this.sandbox.getScreens();
    const shows = await this.sandbox.getShows({});
    for (const mapping of await this.mappings(req.providerCode, tenantId, 'SCREEN')) {
      const external = screens.find((s) => s.externalId === mapping.externalEntityId);
      if (!external) {
        report.skipped.push({
          externalEntityType: 'SCREEN',
          externalEntityId: mapping.externalEntityId,
          reason: 'not_in_provider_catalogue',
        });
        continue;
      }
      if (await this.stillLinked(mapping, INTERNAL.SCREEN, 'screen')) {
        report.screens.linked += 1;
        continue;
      }
      const cinemaId = await this.internalIdFor(
        req.providerCode,
        tenantId,
        'VENUE',
        external.cinemaExternalId,
      );
      if (!cinemaId) {
        report.skipped.push({
          externalEntityType: 'SCREEN',
          externalEntityId: mapping.externalEntityId,
          reason: 'cinema_not_mapped',
        });
        continue;
      }

      // The layout comes from the provider, read through ANY of that screen's shows: seats
      // are a property of the room, so every show in it reports the same positions.
      const anyShow = shows.find((s) => s.screenExternalId === external.externalId);
      if (!anyShow) {
        report.skipped.push({
          externalEntityType: 'SCREEN',
          externalEntityId: mapping.externalEntityId,
          reason: 'no_show_to_read_layout_from',
        });
        continue;
      }
      const seatMap = await this.sandbox.getSeatMap(anyShow.externalId);
      const sellable = seatMap.seats.filter((s) => s.kind !== 'GAP').length;

      const screen = await this.cinemas.addScreen(req.actor, cinemaId, {
        name: external.name,
        screenType: '2D',
        // Counted from the layout, not asserted. A room described as holding 140 seats but
        // drawn with aisle gaps sells fewer, and the drawing is what admits people.
        capacity: sellable,
      } as never);
      const screenId = (screen as { id: string }).id;
      await this.shows.generateSeatMap(
        req.actor,
        screenId,
        this.layoutFor(seatMap, req.pricingByCategory) as never,
      );
      await this.link(mapping.id, INTERNAL.SCREEN, screenId);
      await this.mapSeatsAndCategories(req, tenantId, screenId, seatMap);
      report.screens.created += 1;
    }
  }

  /**
   * The provider's seat map, expressed as the platform's own layout input.
   *
   * One section per external category, rows in the order the provider lists them, and
   * non-seat positions carried across as what they are: a GAP where the aisle runs, a
   * WHEELCHAIR space where the ramp reaches. Dropping those would inflate the room's capacity
   * and — the defect this platform has already had once — put an aisle on sale.
   */
  private layoutFor(
    seatMap: ExternalSeatMap,
    pricingByCategory: Record<string, number>,
  ): {
    name: string;
    sections: Array<{
      name: string;
      categoryName: string;
      basePriceMinor: number;
      rowLabels: string[];
      seatsPerRow: number;
      seatKinds?: Array<{ rowLabel: string; seats: number[]; kind: string }>;
    }>;
  } {
    const byCategory = new Map<string, ExternalSeat[]>();
    for (const seat of seatMap.seats) {
      const list = byCategory.get(seat.categoryExternalId) ?? [];
      list.push(seat);
      byCategory.set(seat.categoryExternalId, list);
    }

    const sections = [];
    for (const category of seatMap.categories) {
      const seats = byCategory.get(category.externalId) ?? [];
      if (seats.length === 0) continue;
      const priceMinor = pricingByCategory[category.externalId];
      if (priceMinor === undefined) {
        throw new AppException(
          ErrorCodes.VALIDATION_FAILED,
          `No ETicketsGo price was given for provider seat category '${category.externalId}'. ` +
            'The provider’s own price is advisory and is never charged to a customer.',
          HttpStatus.BAD_REQUEST,
          { categoryExternalId: category.externalId },
        );
      }
      const rowLabels = [...new Set(seats.map((s) => s.row))];
      const seatsPerRow = Math.max(...seats.map((s) => s.number));
      const seatKinds = rowLabels
        .map((rowLabel) => ({
          rowLabel,
          byKind: seats.filter((s) => s.row === rowLabel && s.kind && s.kind !== 'SEAT'),
        }))
        .flatMap(({ rowLabel, byKind }) => {
          const kinds = [...new Set(byKind.map((s) => s.kind as string))];
          return kinds.map((kind) => ({
            rowLabel,
            kind,
            seats: byKind.filter((s) => s.kind === kind).map((s) => s.number),
          }));
        });
      sections.push({
        name: category.name,
        categoryName: category.name,
        basePriceMinor: priceMinor,
        rowLabels,
        seatsPerRow,
        seatKinds: seatKinds.length > 0 ? seatKinds : undefined,
      });
    }
    return { name: `Imported from ${QUBE_MOCK_PROVIDER_CODE}`, sections };
  }

  /**
   * Record which internal seat is which external seat, once, at import.
   *
   * The pairing is positional — row label and number — because at the moment the internal
   * seats are being CREATED FROM the external layout, position is the only correspondence
   * there is, and it is correct by construction. What matters is that it happens exactly
   * once: from here on the identity is the mapping row, so a provider that renumbers its
   * rows moves nobody's seat, and a seat with no mapping fails the checkout closed instead
   * of being guessed at.
   */
  private async mapSeatsAndCategories(
    req: SandboxMaterializationRequest,
    tenantId: string,
    screenId: string,
    seatMap: ExternalSeatMap,
  ): Promise<void> {
    const internalMap = await this.prisma.seatMap.findFirst({
      where: { screenId },
      orderBy: { version: 'desc' },
      include: {
        categories: true,
        seats: { include: { row: true } },
      },
    });
    if (!internalMap) return;

    for (const category of seatMap.categories) {
      const internal = internalMap.categories.find((c) => c.name === category.name);
      if (!internal) continue;
      await this.upsertMapping(
        req.providerCode,
        tenantId,
        'SEAT_CATEGORY',
        category.externalId,
        INTERNAL.SEAT_CATEGORY,
        internal.id,
      );
    }

    const internalByLabel = new Map(
      internalMap.seats.map((s) => [`${s.row.label}${s.label}`, s.id]),
    );
    for (const seat of seatMap.seats) {
      const internalId = internalByLabel.get(seat.label);
      if (!internalId) continue;
      await this.upsertMapping(
        req.providerCode,
        tenantId,
        'SEAT',
        seat.externalId,
        INTERNAL.SEAT,
        internalId,
      );
    }
  }

  // ── films ──────────────────────────────────────────────────────────────────────

  private async materializeMovies(
    req: SandboxMaterializationRequest,
    tenantId: string,
    report: SandboxMaterializationReport,
  ): Promise<void> {
    const movies = await this.sandbox.getMovies();
    for (const mapping of await this.mappings(req.providerCode, tenantId, 'EXPERIENCE')) {
      const external = movies.find((m) => m.externalId === mapping.externalEntityId);
      if (!external) {
        report.skipped.push({
          externalEntityType: 'EXPERIENCE',
          externalEntityId: mapping.externalEntityId,
          reason: 'not_in_provider_catalogue',
        });
        continue;
      }
      if (await this.stillLinked(mapping, INTERNAL.MOVIE, 'movie')) {
        report.movies.linked += 1;
        continue;
      }
      const movie = await this.movies.create(req.actor, req.organizationId, {
        title: external.title,
        runtimeMinutes: external.runtimeMinutes ?? 120,
        language: external.language ?? 'te',
        certificate: external.certificate,
        genres: [],
        cast: [],
      } as never);
      const movieId = (movie as { id: string }).id;
      await this.movies.setStatus(req.actor, movieId, 'PUBLISHED' as never);
      await this.link(mapping.id, INTERNAL.MOVIE, movieId);
      report.movies.created += 1;
    }
  }

  // ── shows ──────────────────────────────────────────────────────────────────────

  private async materializeShows(
    req: SandboxMaterializationRequest,
    tenantId: string,
    report: SandboxMaterializationReport,
  ): Promise<void> {
    const shows = await this.sandbox.getShows({});
    for (const mapping of await this.mappings(req.providerCode, tenantId, 'SESSION')) {
      const external = shows.find((s) => s.externalId === mapping.externalEntityId);
      if (!external) {
        // Absence is NOT a cancellation. A show missing from a page could as easily be a
        // paging bug, and unpublishing a screening people hold tickets for on that evidence
        // is exactly the silent destruction the governance model exists to prevent.
        report.skipped.push({
          externalEntityType: 'SESSION',
          externalEntityId: mapping.externalEntityId,
          reason: 'absent_from_feed_not_treated_as_cancellation',
        });
        continue;
      }

      const existing = await this.linkedSession(mapping);
      if (existing) {
        // A mapped show that MOVED. Same external id ⇒ same screening ⇒ reschedule, never a
        // second show. The two-minute difference test: an importer keyed on start time would
        // create a duplicate here and sell tickets for a screening that will not happen.
        if (existing.startsAt.getTime() !== external.startsAt.getTime()) {
          const padMinutes = external.endsAt
            ? Math.max(
                0,
                Math.round(
                  (external.endsAt.getTime() - external.startsAt.getTime()) / 60_000 -
                    (await this.runtimeOf(existing.eventId)),
                ),
              )
            : 0;
          try {
            await this.shows.rescheduleShow(req.actor, existing.id, {
              startsAt: external.startsAt,
              padMinutes,
            } as never);
            report.shows.rescheduled += 1;
          } catch (err) {
            report.skipped.push({
              externalEntityType: 'SESSION',
              externalEntityId: mapping.externalEntityId,
              reason: `reschedule_refused:${(err as { code?: string }).code ?? 'error'}`,
            });
          }
        }
        report.shows.linked += 1;
        continue;
      }

      const movieId = await this.internalIdFor(
        req.providerCode,
        tenantId,
        'EXPERIENCE',
        external.movieExternalId,
      );
      const screenId = await this.internalIdFor(
        req.providerCode,
        tenantId,
        'SCREEN',
        external.screenExternalId,
      );
      if (!movieId || !screenId) {
        report.skipped.push({
          externalEntityType: 'SESSION',
          externalEntityId: mapping.externalEntityId,
          reason: !movieId ? 'movie_not_mapped' : 'screen_not_mapped',
        });
        continue;
      }

      const pricing = await this.pricingForScreen(req, tenantId, screenId);
      try {
        const created = await this.shows.scheduleShow(req.actor, movieId, {
          screenId,
          startsAt: external.startsAt,
          endsAt: external.endsAt ?? new Date(external.startsAt.getTime() + 150 * 60_000),
          pricing,
        } as never);
        await this.link(mapping.id, INTERNAL.SESSION, created.sessionId);
        report.shows.created += 1;
      } catch (err) {
        // A schedule the platform refuses is reported, never forced. The provider's timetable
        // is not automatically runnable in our model, and pretending otherwise would put two
        // films in one room.
        report.skipped.push({
          externalEntityType: 'SESSION',
          externalEntityId: mapping.externalEntityId,
          reason: `schedule_refused:${(err as { code?: string }).code ?? 'error'}`,
        });
      }
    }
  }

  /** OUR price per internal seat category, resolved through the seat-category mappings. */
  private async pricingForScreen(
    req: SandboxMaterializationRequest,
    tenantId: string,
    screenId: string,
  ): Promise<Array<{ seatCategoryId: string; priceMinor: number }>> {
    const map = await this.prisma.seatMap.findFirst({
      where: { screenId },
      orderBy: { version: 'desc' },
      include: { categories: true },
    });
    if (!map) return [];
    const out: Array<{ seatCategoryId: string; priceMinor: number }> = [];
    for (const [externalCategoryId, priceMinor] of Object.entries(req.pricingByCategory)) {
      const internalId = await this.internalIdFor(
        req.providerCode,
        tenantId,
        'SEAT_CATEGORY',
        externalCategoryId,
      );
      if (internalId && map.categories.some((c) => c.id === internalId)) {
        out.push({ seatCategoryId: internalId, priceMinor });
      }
    }
    return out;
  }

  private async runtimeOf(eventId: string): Promise<number> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { movie: { select: { runtimeMinutes: true } } },
    });
    return event?.movie?.runtimeMinutes ?? 0;
  }

  // ── mapping plumbing ───────────────────────────────────────────────────────────

  private async mappings(providerCode: string, providerTenantId: string, entityType: string) {
    return this.prisma.providerMapping.findMany({
      where: { providerCode, providerTenantId, externalEntityType: entityType },
      orderBy: { externalEntityId: 'asc' },
    });
  }

  /**
   * Is this mapping still pointing at something that exists?
   *
   * A mapping whose internal row has been deleted is worse than an unmapped one: it looks
   * approved. Re-checking here means the sandbox heals rather than failing later with a
   * foreign-key error nobody can trace back to an import.
   */
  private async stillLinked(
    mapping: { status: string; internalEntityType: string | null; internalEntityId: string | null },
    expectedType: string,
    delegate: 'cinema' | 'screen' | 'movie',
  ): Promise<boolean> {
    if (mapping.status !== 'ACTIVE' || mapping.internalEntityType !== expectedType) return false;
    if (!mapping.internalEntityId) return false;
    const id = mapping.internalEntityId;
    const found =
      delegate === 'cinema'
        ? await this.prisma.cinema.findUnique({ where: { id }, select: { id: true } })
        : delegate === 'screen'
          ? await this.prisma.screen.findUnique({ where: { id }, select: { id: true } })
          : await this.prisma.movie.findUnique({ where: { id }, select: { id: true } });
    return Boolean(found);
  }

  private async linkedSession(mapping: {
    status: string;
    internalEntityType: string | null;
    internalEntityId: string | null;
  }): Promise<{ id: string; eventId: string; startsAt: Date } | null> {
    if (mapping.status !== 'ACTIVE' || mapping.internalEntityType !== INTERNAL.SESSION) return null;
    if (!mapping.internalEntityId) return null;
    return this.prisma.eventSession.findUnique({
      where: { id: mapping.internalEntityId },
      select: { id: true, eventId: true, startsAt: true },
    });
  }

  private async internalIdFor(
    providerCode: string,
    providerTenantId: string,
    externalEntityType: string,
    externalEntityId: string,
  ): Promise<string | null> {
    const mapping = await this.prisma.providerMapping.findUnique({
      where: {
        providerCode_providerTenantId_externalEntityType_externalEntityId: {
          providerCode,
          providerTenantId,
          externalEntityType,
          externalEntityId,
        },
      },
      select: { status: true, internalEntityId: true },
    });
    return mapping?.status === 'ACTIVE' ? (mapping.internalEntityId ?? null) : null;
  }

  private async link(
    mappingId: string,
    internalEntityType: string,
    internalEntityId: string,
  ): Promise<void> {
    await this.prisma.providerMapping.update({
      where: { id: mappingId },
      data: { internalEntityType, internalEntityId, status: 'ACTIVE' },
    });
  }

  /** Seats and categories have no ingested mapping of their own; the import creates theirs. */
  private async upsertMapping(
    providerCode: string,
    providerTenantId: string,
    externalEntityType: string,
    externalEntityId: string,
    internalEntityType: string,
    internalEntityId: string,
  ): Promise<void> {
    await this.prisma.providerMapping.upsert({
      where: {
        providerCode_providerTenantId_externalEntityType_externalEntityId: {
          providerCode,
          providerTenantId,
          externalEntityType,
          externalEntityId,
        },
      },
      create: {
        providerCode,
        providerTenantId,
        externalEntityType,
        externalEntityId,
        internalEntityType,
        internalEntityId,
        ownershipMode: 'PROVIDER_AUTHORITATIVE',
        status: 'ACTIVE',
        lastSyncedAt: new Date(),
      },
      update: { internalEntityType, internalEntityId, status: 'ACTIVE', lastSyncedAt: new Date() },
    });
  }
}
