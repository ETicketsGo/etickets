import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Role } from '@eticketsgo/shared-types';
import type {
  CloneSeatLayoutInput,
  PublishSeatLayoutInput,
  UpdateSeatLayoutInput,
} from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/decorators';
import {
  compareLayouts,
  evaluateLayoutOperation,
  type ComparableSeat,
  type LayoutComparison,
  type LayoutOperation,
  type LayoutStatus,
  type LayoutVersion,
} from './seat-layout-versioning';
import {
  generateVenue,
  seatCount as templateSeatCount,
  type TemplateSection,
  type VenueTemplateKey,
} from './venue-templates';

/**
 * Empty a draft layout before rewriting it, in the only order the database allows.
 *
 * ── THE BUG THIS FIXES ─────────────────────────────────────────────────────────────
 * The obvious order — categories, then sections, then seats — is the one that was here, and
 * it cannot work: `Seat.seatCategoryId` is a required relation with no cascade, so deleting
 * a category that still has seats pointing at it is a foreign-key violation. Re-saving any
 * draft that already had seats therefore failed outright. It went unnoticed because the
 * usual path is "generate once, publish", and the second save is the rare one.
 *
 * Seats go first. That releases the references to both categories and rows, after which
 * sections can go (cascading their rows) and categories last. Written once and shared, so
 * the template path and the editor cannot drift back apart.
 */
async function clearLayoutContents(tx: Prisma.TransactionClient, layoutId: string): Promise<void> {
  await tx.seat.deleteMany({ where: { seatMapId: layoutId } });
  await tx.seatSection.deleteMany({ where: { seatMapId: layoutId } });
  await tx.seatCategory.deleteMany({ where: { seatMapId: layoutId } });
}

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/**
 * Seats per INSERT when filling a template.
 *
 * Postgres accepts at most 65535 bind parameters in one statement and a seat row binds six,
 * so the hard ceiling is around ten thousand. Two thousand leaves generous headroom for the
 * day a column is added, and is still few enough statements that a stadium writes in seconds.
 */
const SEAT_INSERT_CHUNK = 2000;

export interface LayoutSummary {
  id: string;
  screenId: string;
  name: string | null;
  version: number;
  status: LayoutStatus;
  effectiveFrom: Date | null;
  publishedAt: Date | null;
  archivedAt: Date | null;
  clonedFromId: string | null;
  seatCount: number;
  /** Sellable seats — gaps excluded, because an aisle is not capacity. */
  capacity: number;
  /** Shows pinned to this version that have not played yet. */
  futureShows: number;
  /** Shows pinned to it that have already played. History; never blocks anything. */
  historicalShows: number;
  createdAt: Date;
}

/**
 * Seat layout versions — clone, edit, publish, activate, compare, archive.
 *
 * Split out of ShowsService deliberately. That file already carries scheduling, sales
 * control and the public seat layout; layout lifecycle is a separate concern with its own
 * policy module, and bolting it on would have made the largest service in the codebase
 * larger still.
 *
 * Every decision here comes from `seat-layout-versioning.ts`. This class supplies the
 * database facts and persists the outcome; it does not decide anything itself.
 */
@Injectable()
export class SeatLayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /** Load a screen the caller's organization owns, or refuse. */
  private async loadOwnedScreen(user: RequestUser, screenId: string, roles = ORGANIZER_ROLES) {
    const screen = await this.prisma.screen.findUnique({
      where: { id: screenId },
      include: { cinema: true },
    });
    if (!screen) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Screen not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, screen.cinema.organizationId, roles);
    return screen;
  }

  /** Load a layout with its screen, checking tenancy through the screen's cinema. */
  private async loadOwnedLayout(user: RequestUser, layoutId: string, roles = ORGANIZER_ROLES) {
    const layout = await this.prisma.seatMap.findUnique({
      where: { id: layoutId },
      include: { screen: { include: { cinema: true } } },
    });
    if (!layout) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Seat layout not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, layout.screen.cinema.organizationId, roles);
    return layout;
  }

  private asVersion(l: {
    id: string;
    version: number;
    status: string;
    effectiveFrom: Date | null;
    publishedAt: Date | null;
    createdAt: Date;
  }): LayoutVersion {
    return {
      id: l.id,
      version: l.version,
      status: l.status as LayoutStatus,
      effectiveFrom: l.effectiveFrom,
      publishedAt: l.publishedAt,
      createdAt: l.createdAt,
    };
  }

  /**
   * What is committed to a layout version.
   *
   * Future and historical shows are counted separately because they mean opposite things:
   * a future show blocks archiving (the operator meant to move it first), a historical one
   * never can (it holds its own seats, and past trading must not freeze a screen's layout
   * list forever).
   */
  private async commitmentsFor(layoutId: string, screenId: string, now = new Date()) {
    const [futureShows, historicalShows, otherPublishedVersions] = await Promise.all([
      this.prisma.eventSession.count({
        where: { seatMapId: layoutId, startsAt: { gte: now } },
      }),
      this.prisma.eventSession.count({
        where: { seatMapId: layoutId, startsAt: { lt: now } },
      }),
      this.prisma.seatMap.count({
        where: { screenId, status: 'PUBLISHED', id: { not: layoutId } },
      }),
    ]);
    return { futureShows, historicalShows, otherPublishedVersions };
  }

  /** Decide, or throw a refusal carrying the policy code the UI maps to a sentence. */
  private async authorize(
    layout: {
      id: string;
      screenId: string;
      version: number;
      status: string;
      effectiveFrom: Date | null;
      publishedAt: Date | null;
      createdAt: Date;
    },
    operation: LayoutOperation,
  ) {
    const commitments = await this.commitmentsFor(layout.id, layout.screenId);
    const verdict = evaluateLayoutOperation(this.asVersion(layout), operation, commitments);
    if (!verdict.allowed) {
      throw new AppException(ErrorCodes.CONFLICT, verdict.message, HttpStatus.CONFLICT, {
        reason: verdict.code,
      });
    }
    return commitments;
  }

  private async record(
    user: RequestUser,
    layout: {
      id: string;
      screenId: string;
      version: number;
      screen: { cinema: { organizationId: string } };
    },
    action: string,
    metadata: Record<string, unknown>,
  ) {
    await this.audit?.record({
      actorUserId: user.id,
      organizationId: layout.screen.cinema.organizationId,
      action,
      entityType: 'SeatMap',
      entityId: layout.id,
      metadata: { screenId: layout.screenId, version: layout.version, ...metadata },
    });
  }

  // ── Reading ─────────────────────────────────────────────────────────────────────

  /** Every layout version for a screen, newest first, with what is committed to each. */
  async listVersions(user: RequestUser, screenId: string): Promise<LayoutSummary[]> {
    await this.loadOwnedScreen(user, screenId, undefined);

    const layouts = await this.prisma.seatMap.findMany({
      where: { screenId },
      orderBy: [{ version: 'desc' }],
      include: { _count: { select: { seats: true } } },
    });
    if (layouts.length === 0) return [];

    const now = new Date();
    const ids = layouts.map((l) => l.id);

    // Two grouped queries rather than a count per version: a screen re-seated monthly for a
    // decade would otherwise issue a hundred round trips to render one page.
    const [sellable, shows] = await Promise.all([
      this.prisma.seat.groupBy({
        by: ['seatMapId'],
        where: { seatMapId: { in: ids }, kind: { not: 'GAP' } },
        _count: { _all: true },
      }),
      this.prisma.eventSession.groupBy({
        by: ['seatMapId'],
        where: { seatMapId: { in: ids } },
        _count: { _all: true },
        _min: { startsAt: true },
      }),
    ]);
    const capacityBy = new Map(sellable.map((r) => [r.seatMapId as string, r._count._all]));

    // Future/historical needs a split the groupBy above cannot express, so count futures
    // in one extra grouped pass rather than per layout.
    const futures = await this.prisma.eventSession.groupBy({
      by: ['seatMapId'],
      where: { seatMapId: { in: ids }, startsAt: { gte: now } },
      _count: { _all: true },
    });
    const futureBy = new Map(futures.map((r) => [r.seatMapId as string, r._count._all]));
    const totalBy = new Map(shows.map((r) => [r.seatMapId as string, r._count._all]));

    return layouts.map((l) => ({
      id: l.id,
      screenId: l.screenId,
      name: l.name,
      version: l.version,
      status: l.status as LayoutStatus,
      effectiveFrom: l.effectiveFrom,
      publishedAt: l.publishedAt,
      archivedAt: l.archivedAt,
      clonedFromId: l.clonedFromId,
      seatCount: l._count.seats,
      capacity: capacityBy.get(l.id) ?? 0,
      futureShows: futureBy.get(l.id) ?? 0,
      historicalShows: (totalBy.get(l.id) ?? 0) - (futureBy.get(l.id) ?? 0),
      createdAt: l.createdAt,
    }));
  }

  /** The seats of one version, flattened for comparison. */
  private async comparableSeats(layoutId: string): Promise<ComparableSeat[]> {
    const seats = await this.prisma.seat.findMany({
      where: { seatMapId: layoutId },
      select: {
        label: true,
        kind: true,
        row: { select: { label: true } },
        seatCategory: { select: { name: true } },
      },
    });
    return seats.map((s) => ({
      row: s.row.label,
      label: s.label,
      categoryName: s.seatCategory.name,
      kind: s.kind,
    }));
  }

  /**
   * Diff two versions of the same screen's layout.
   *
   * Refuses across screens: comparing Screen 1 v3 with Screen 2 v1 produces a diff where
   * every seat changed, which is technically true and operationally meaningless.
   */
  async compare(
    user: RequestUser,
    fromId: string,
    toId: string,
  ): Promise<LayoutComparison & { from: LayoutSummary; to: LayoutSummary }> {
    const from = await this.loadOwnedLayout(user, fromId, undefined);
    const to = await this.loadOwnedLayout(user, toId, undefined);
    if (from.screenId !== to.screenId) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Two layout versions can only be compared within the same screen.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const [beforeSeats, afterSeats, summaries] = await Promise.all([
      this.comparableSeats(fromId),
      this.comparableSeats(toId),
      this.listVersions(user, from.screenId),
    ]);

    const summaryOf = (id: string) => summaries.find((s) => s.id === id)!;
    return {
      ...compareLayouts(beforeSeats, afterSeats),
      from: summaryOf(fromId),
      to: summaryOf(toId),
    };
  }

  // ── Writing ─────────────────────────────────────────────────────────────────────

  /**
   * Clone a version into a new editable DRAFT.
   *
   * Deep-copies categories, sections, rows and seats into brand-new rows. That copying is
   * the whole mechanism: because the draft owns different `Seat` records, nothing it later
   * becomes can reach a `ShowSeat` or `Ticket` belonging to the source.
   */
  async clone(user: RequestUser, layoutId: string, input: CloneSeatLayoutInput) {
    const source = await this.loadOwnedLayout(user, layoutId);
    await this.authorize(source, 'CLONE');

    const created = await this.prisma.$transaction(async (tx) => {
      // Lock the screen so two operators cloning at once cannot claim the same version
      // number — the unique index would reject the loser with a constraint error rather
      // than something an operator could read.
      await tx.$queryRaw`SELECT id FROM "Screen" WHERE id = ${source.screenId} FOR UPDATE`;

      const highest = await tx.seatMap.findFirst({
        where: { screenId: source.screenId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (highest?.version ?? 0) + 1;

      const draft = await tx.seatMap.create({
        data: {
          screenId: source.screenId,
          name: input.name ?? `${source.name ?? 'Layout'} v${nextVersion}`,
          version: nextVersion,
          status: 'DRAFT',
          clonedFromId: source.id,
        },
      });

      const categories = await tx.seatCategory.findMany({
        where: { seatMapId: source.id },
        orderBy: { sortOrder: 'asc' },
      });
      const categoryIdMap = new Map<string, string>();
      for (const c of categories) {
        const copy = await tx.seatCategory.create({
          data: {
            seatMapId: draft.id,
            name: c.name,
            colorHex: c.colorHex,
            basePriceMinor: c.basePriceMinor,
            sortOrder: c.sortOrder,
          },
        });
        categoryIdMap.set(c.id, copy.id);
      }

      const sections = await tx.seatSection.findMany({
        where: { seatMapId: source.id },
        orderBy: { sortOrder: 'asc' },
        include: {
          rows: {
            orderBy: { sortOrder: 'asc' },
            include: { seats: { orderBy: { colIndex: 'asc' } } },
          },
        },
      });
      for (const s of sections) {
        const sectionCopy = await tx.seatSection.create({
          data: { seatMapId: draft.id, name: s.name, sortOrder: s.sortOrder },
        });
        for (const r of s.rows) {
          const rowCopy = await tx.seatRow.create({
            data: { sectionId: sectionCopy.id, label: r.label, sortOrder: r.sortOrder },
          });
          if (r.seats.length === 0) continue;
          await tx.seat.createMany({
            data: r.seats.map((seat) => ({
              seatMapId: draft.id,
              rowId: rowCopy.id,
              seatCategoryId: categoryIdMap.get(seat.seatCategoryId) ?? seat.seatCategoryId,
              label: seat.label,
              colIndex: seat.colIndex,
              kind: seat.kind,
            })),
          });
        }
      }

      return draft;
    });

    await this.record(user, { ...source, version: created.version }, 'SEAT_LAYOUT_CLONED', {
      sourceLayoutId: source.id,
      sourceVersion: source.version,
      draftLayoutId: created.id,
    });

    return { id: created.id, version: created.version, status: created.status };
  }

  /**
   * Replace a DRAFT's contents.
   *
   * Deletes and rebuilds rather than patching. A draft has no shows and no sold seats by
   * definition, so there is nothing to preserve, and rebuilding avoids an entire class of
   * bug where a row survives pointing at a category the same request removed.
   */
  async updateDraft(user: RequestUser, layoutId: string, input: UpdateSeatLayoutInput) {
    const layout = await this.loadOwnedLayout(user, layoutId);
    await this.authorize(layout, 'EDIT');

    await this.prisma.$transaction(async (tx) => {
      await clearLayoutContents(tx, layoutId);

      if (input.name !== undefined) {
        await tx.seatMap.update({ where: { id: layoutId }, data: { name: input.name } });
      }

      for (const [index, section] of input.sections.entries()) {
        const category = await tx.seatCategory.create({
          data: {
            seatMapId: layoutId,
            name: section.categoryName,
            colorHex: section.colorHex,
            basePriceMinor: section.basePriceMinor,
            sortOrder: index,
          },
        });
        const seatSection = await tx.seatSection.create({
          data: { seatMapId: layoutId, name: section.name, sortOrder: index },
        });
        for (const [rowIndex, rowLabel] of section.rowLabels.entries()) {
          const row = await tx.seatRow.create({
            data: { sectionId: seatSection.id, label: rowLabel, sortOrder: rowIndex },
          });
          await tx.seat.createMany({
            data: Array.from({ length: section.seatsPerRow }, (_unused, i) => ({
              seatMapId: layoutId,
              rowId: row.id,
              seatCategoryId: category.id,
              label: String(i + 1),
              colIndex: i + 1,
              kind: section.seatKinds?.[`${rowLabel}${i + 1}`] ?? 'SEAT',
            })),
          });
        }
      }
    });

    await this.record(user, layout, 'SEAT_LAYOUT_DRAFT_UPDATED', {
      sections: input.sections.length,
    });
    return { id: layoutId, status: 'DRAFT' as const };
  }

  /**
   * Fill a draft layout from a venue template.
   *
   * ── WHY THIS IS NOT `updateDraft` ──────────────────────────────────────────────
   * The existing editor describes a section as "these row labels, this many seats each",
   * which is exactly right for a cinema and cannot express an arena: rows that widen towards
   * the back, blocks turned to face a stage, and an outline to draw the block as. Bending
   * that DTO to carry geometry would make every cinema pay for a shape it does not have.
   *
   * ── WHY IT WRITES IN BULK ──────────────────────────────────────────────────────
   * A stadium template is about fourteen thousand seats across five hundred rows. Created
   * one row at a time — which is what the cinema path does, correctly, for twelve rows —
   * that is five hundred sequential round trips inside one transaction, and it times out
   * long before it finishes. `createManyAndReturn` gets the generated ids back in one
   * statement per level, and seats go in chunked because Postgres takes at most 65535 bind
   * parameters per statement and fourteen thousand seats is well past that.
   */
  async applyTemplate(
    user: RequestUser,
    layoutId: string,
    input: {
      template: VenueTemplateKey;
      rows?: number;
      seatsPerRow?: number;
      basePriceMinor: number;
    },
  ) {
    const layout = await this.loadOwnedLayout(user, layoutId);
    // Same gate as any other edit: a published version can never change underneath a show
    // that has already been sold from it.
    await this.authorize(layout, 'EDIT');

    const venue = generateVenue(input.template, {
      rows: input.rows,
      seatsPerRow: input.seatsPerRow,
    });

    await this.prisma.$transaction(
      async (tx) => {
        await clearLayoutContents(tx, layoutId);

        await tx.seatMap.update({
          where: { id: layoutId },
          data: {
            layoutKind: venue.layoutKind,
            focalPoint: venue.focalPoint,
            focalShape: venue.focalShape,
            focalLabel: venue.focalLabel,
          },
        });

        const categories = await tx.seatCategory.createManyAndReturn({
          data: venue.categories.map((c) => ({
            seatMapId: layoutId,
            name: c.name,
            colorHex: c.colorHex,
            sortOrder: c.sortOrder,
            // The template carries a relative weight, never money. What a front-row seat
            // costs is the organizer's decision; all the template knows is that it is worth
            // more than the back.
            basePriceMinor: Math.round(input.basePriceMinor * c.priceWeight),
          })),
        });
        const categoryByName = new Map(categories.map((c) => [c.name, c.id]));

        const sections = await tx.seatSection.createManyAndReturn({
          data: venue.sections.map((sec) => ({
            seatMapId: layoutId,
            name: sec.name,
            sortOrder: sec.sortOrder,
            shape: sec.shape,
            labelX: sec.labelX,
            labelY: sec.labelY,
            tier: sec.tier,
            rotationDeg: sec.rotationDeg,
          })),
        });
        // Matched by name, which the generator guarantees is unique per venue and a test
        // pins. Matching by array position would be quietly wrong the first time the
        // database returned rows in another order.
        const sectionByName = new Map(sections.map((sec) => [sec.name, sec.id]));

        const rows = await tx.seatRow.createManyAndReturn({
          data: venue.sections.flatMap((sec) =>
            sec.rows.map((row) => ({
              sectionId: sectionByName.get(sec.name) as string,
              label: row.label,
              sortOrder: row.sortOrder,
            })),
          ),
        });
        const rowIdBySectionAndLabel = new Map<string, string>();
        for (const row of rows) rowIdBySectionAndLabel.set(`${row.sectionId}|${row.label}`, row.id);

        const seatData = venue.sections.flatMap((sec: TemplateSection) => {
          const sectionId = sectionByName.get(sec.name) as string;
          const categoryId = categoryByName.get(sec.categoryName) as string;
          return sec.rows.flatMap((row) =>
            row.seats.map((seat) => ({
              seatMapId: layoutId,
              rowId: rowIdBySectionAndLabel.get(`${sectionId}|${row.label}`) as string,
              seatCategoryId: categoryId,
              label: seat.label,
              colIndex: seat.colIndex,
              kind: seat.kind,
            })),
          );
        });
        for (let i = 0; i < seatData.length; i += SEAT_INSERT_CHUNK) {
          await tx.seat.createMany({ data: seatData.slice(i, i + SEAT_INSERT_CHUNK) });
        }
      },
      // A stadium takes real time to write. The default five seconds would abort it after
      // the sections landed and before the seats did, leaving a draft that looks like a
      // venue and cannot sell anything.
      { timeout: 120_000, maxWait: 10_000 },
    );

    await this.record(user, layout, 'SEAT_LAYOUT_TEMPLATE_APPLIED', {
      template: input.template,
      sections: venue.sections.length,
      seats: templateSeatCount(venue),
    });
    return {
      id: layoutId,
      status: 'DRAFT' as const,
      layoutKind: venue.layoutKind,
      sections: venue.sections.length,
      seats: templateSeatCount(venue),
    };
  }

  /**
   * Publish a draft, optionally dated forward.
   *
   * One-way. Once a version can be attached to a show it must never change underneath one,
   * so there is no unpublish — the way back is to publish a replacement.
   */
  async publish(user: RequestUser, layoutId: string, input: PublishSeatLayoutInput) {
    const layout = await this.loadOwnedLayout(user, layoutId);
    await this.authorize(layout, 'PUBLISH');

    const seatCount = await this.prisma.seat.count({ where: { seatMapId: layoutId } });
    if (seatCount === 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This layout has no seats. Add seats before publishing it, or a show scheduled against it would sell nothing.',
        HttpStatus.CONFLICT,
        { reason: 'LAYOUT_EMPTY' },
      );
    }

    const now = new Date();
    const effectiveFrom = input.effectiveFrom ?? now;
    const updated = await this.prisma.seatMap.update({
      where: { id: layoutId },
      data: { status: 'PUBLISHED', publishedAt: now, effectiveFrom },
    });

    await this.record(user, layout, 'SEAT_LAYOUT_PUBLISHED', {
      effectiveFrom,
      seatCount,
      // Dating forward is the "activate a future version" path and is worth distinguishing
      // in the audit trail from an immediate publish.
      scheduled: effectiveFrom.getTime() > now.getTime(),
    });

    return {
      id: updated.id,
      version: updated.version,
      status: updated.status,
      effectiveFrom: updated.effectiveFrom,
      publishedAt: updated.publishedAt,
    };
  }

  /** Retire a superseded version. Never deletes; existing shows keep their own seats. */
  async archive(user: RequestUser, layoutId: string) {
    const layout = await this.loadOwnedLayout(user, layoutId);
    await this.authorize(layout, 'ARCHIVE');

    const updated = await this.prisma.seatMap.update({
      where: { id: layoutId },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    await this.record(user, layout, 'SEAT_LAYOUT_ARCHIVED', {});
    return { id: updated.id, version: updated.version, status: updated.status };
  }

  /** Discard a draft that was never published. */
  async deleteDraft(user: RequestUser, layoutId: string) {
    const layout = await this.loadOwnedLayout(user, layoutId);
    await this.authorize(layout, 'DELETE');

    await this.prisma.seatMap.delete({ where: { id: layoutId } });
    await this.record(user, layout, 'SEAT_LAYOUT_DRAFT_DELETED', {});
    return { id: layoutId, deleted: true };
  }
}
