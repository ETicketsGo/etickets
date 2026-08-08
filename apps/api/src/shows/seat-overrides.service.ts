import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Role } from '@eticketsgo/shared-types';
import type { BlockSeatsInput, ReleaseSeatsInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/decorators';
import {
  companionCandidates,
  evaluateSeatOverride,
  isCasuallyReleasable,
  shouldSuggestExpiry,
  type OverrideKind,
  type SeatStatus,
} from './seat-overrides';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/** One seat's outcome, so a bulk request reports per seat rather than all-or-nothing. */
export interface SeatOverrideOutcome {
  seatId: string;
  seatLabel: string;
  applied: boolean;
  reason?: string;
  code?: string;
}

export interface OverrideResult {
  sessionId: string;
  applied: number;
  refused: number;
  seats: SeatOverrideOutcome[];
  /** Non-blocking advice, e.g. open-ended maintenance. */
  warnings: string[];
}

/**
 * Show-level seat overrides.
 *
 * ── HOW SAFETY IS ACHIEVED ────────────────────────────────────────────────────────
 * Not by reading state and then writing it. Every mutation is a single conditional UPDATE
 * whose WHERE clause names the states it is willing to act on, exactly mirroring how
 * booking takes a seat (`UPDATE … WHERE status = 'AVAILABLE'`).
 *
 * That is what makes override-versus-booking safe with no extra locking: both are
 * conditional updates on the same row, PostgreSQL serialises them, and whichever lands
 * second finds the precondition already false and affects zero rows. There is no window
 * between the check and the act, because there is no separate check.
 *
 * The pre-read exists only to produce a good REFUSAL MESSAGE. It is never trusted for the
 * decision — if it disagrees with reality, the UPDATE simply matches nothing and the seat is
 * reported as refused.
 */
@Injectable()
export class SeatOverridesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /** Load a show the caller's organization owns, or refuse. */
  private async loadOwnedSession(user: RequestUser, sessionId: string, roles = ORGANIZER_ROLES) {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: sessionId },
      include: {
        event: { select: { organizationId: true } },
        screen: { select: { id: true, name: true, cinema: { select: { id: true, name: true } } } },
      },
    });
    if (!session) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Show not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, session.event.organizationId, roles);
    return session;
  }

  private label(seat: { label: string; row: { label: string } }): string {
    return `${seat.row.label}${seat.label}`;
  }

  private async recordSeatAudit(
    user: RequestUser,
    session: { id: string; screenId: string | null; event: { organizationId: string } },
    action: string,
    metadata: Record<string, unknown>,
  ) {
    await this.audit?.record({
      actorUserId: user.id,
      organizationId: session.event.organizationId,
      action,
      // Anchored on the SHOW, not the seat: "what happened to tonight's 9pm" is the question
      // an operator or an auditor actually asks, and per-seat rows would bury it.
      entityType: 'EventSession',
      entityId: session.id,
      metadata: { screenId: session.screenId, ...metadata },
    });
  }

  // ── Blocking ────────────────────────────────────────────────────────────────────

  /**
   * Block seats on one show.
   *
   * Partial success is deliberate. An operator blocking a whole row where one seat has just
   * sold should get the other eleven blocked and be told precisely which one was refused —
   * failing the batch would make them retry seat by seat to find it.
   */
  async blockSeats(
    user: RequestUser,
    sessionId: string,
    input: BlockSeatsInput,
  ): Promise<OverrideResult> {
    const session = await this.loadOwnedSession(user, sessionId);
    const now = new Date();

    const seats = await this.prisma.showSeat.findMany({
      where: { eventSessionId: sessionId, seatId: { in: input.seatIds } },
      include: { seat: { select: { label: true, row: { select: { label: true } } } } },
    });
    this.assertSeatsBelongToShow(seats, input.seatIds);

    const outcomes: SeatOverrideOutcome[] = [];
    const applied: string[] = [];

    for (const showSeat of seats) {
      const verdict = evaluateSeatOverride(
        {
          status: showSeat.status as SeatStatus,
          overrideKind: showSeat.overrideKind as OverrideKind | null,
          holdExpiresAt: showSeat.holdExpiresAt,
          holdBookingId: showSeat.holdBookingId,
        },
        'BLOCK',
        now,
      );
      if (!verdict.allowed) {
        outcomes.push({
          seatId: showSeat.seatId,
          seatLabel: this.label(showSeat.seat),
          applied: false,
          reason: verdict.message,
          code: verdict.code,
        });
        continue;
      }
      applied.push(showSeat.seatId);
    }

    /*
      One conditional statement for the whole batch.

      The WHERE clause is the guard, not the loop above. A seat that sold in the
      milliseconds since the read simply fails to match and is reported below, so a booking
      racing this override always wins the seat it already took.

      An expired hold is treated as free: the checkout is dead and only the sweeper is late.
    */
    let affectedIds: string[] = [];
    if (applied.length > 0) {
      const rows = await this.prisma.$queryRaw<{ seatId: string }[]>`
        UPDATE "ShowSeat"
           SET "status" = 'BLOCKED',
               "overrideKind" = ${input.kind}::"SeatOverrideKind",
               "overrideReason" = ${input.reason},
               "overrideByUserId" = ${user.id},
               "overrideAt" = ${now},
               "overrideExpiresAt" = ${input.expiresAt ?? null},
               "holdBookingId" = NULL,
               "holdExpiresAt" = NULL,
               "version" = "version" + 1,
               "updatedAt" = NOW()
         WHERE "eventSessionId" = ${sessionId}
           AND "seatId" IN (${Prisma.join(applied)})
           AND ("status" IN ('AVAILABLE', 'BLOCKED')
                OR ("status" = 'HELD' AND ("holdExpiresAt" IS NULL OR "holdExpiresAt" <= ${now})))
        RETURNING "seatId"
      `;
      affectedIds = rows.map((r) => r.seatId);
    }

    const affected = new Set(affectedIds);
    for (const seatId of applied) {
      const showSeat = seats.find((s) => s.seatId === seatId)!;
      outcomes.push(
        affected.has(seatId)
          ? { seatId, seatLabel: this.label(showSeat.seat), applied: true }
          : {
              seatId,
              seatLabel: this.label(showSeat.seat),
              applied: false,
              // Lost the race. Saying so plainly is better than a generic failure: the
              // operator refreshes and sees a sold seat, which is the truth.
              code: 'SEAT_TAKEN_CONCURRENTLY',
              reason:
                'Somebody booked this seat while the override was being applied. It was not blocked.',
            },
      );
    }

    const warnings: string[] = [];
    if (shouldSuggestExpiry(input.kind as OverrideKind, input.expiresAt ?? null)) {
      warnings.push(
        'This maintenance block has no expiry, so it will stay until somebody removes it. Set one if the fault is temporary.',
      );
    }

    const appliedOutcomes = outcomes.filter((o) => o.applied);
    if (appliedOutcomes.length > 0) {
      await this.recordSeatAudit(user, session, 'SHOW_SEATS_BLOCKED', {
        kind: input.kind,
        reason: input.reason,
        housePurpose: input.housePurpose ?? null,
        expiresAt: input.expiresAt ?? null,
        seatCount: appliedOutcomes.length,
        seats: appliedOutcomes.map((o) => o.seatLabel),
        refusedSeats: outcomes.filter((o) => !o.applied).map((o) => o.seatLabel),
      });
    }

    return this.summarise(sessionId, outcomes, warnings);
  }

  // ── Releasing ───────────────────────────────────────────────────────────────────

  /** Put blocked seats back on sale. */
  async releaseSeats(
    user: RequestUser,
    sessionId: string,
    input: ReleaseSeatsInput,
  ): Promise<OverrideResult> {
    const session = await this.loadOwnedSession(user, sessionId);
    const now = new Date();

    const seats = await this.prisma.showSeat.findMany({
      where: { eventSessionId: sessionId, seatId: { in: input.seatIds } },
      include: { seat: { select: { label: true, row: { select: { label: true } } } } },
    });
    this.assertSeatsBelongToShow(seats, input.seatIds);

    const outcomes: SeatOverrideOutcome[] = [];
    const releasing: string[] = [];

    for (const showSeat of seats) {
      const kind = showSeat.overrideKind as OverrideKind | null;
      const verdict = evaluateSeatOverride(
        {
          status: showSeat.status as SeatStatus,
          overrideKind: kind,
          holdExpiresAt: showSeat.holdExpiresAt,
          holdBookingId: showSeat.holdBookingId,
        },
        'RELEASE',
        now,
      );
      if (!verdict.allowed) {
        outcomes.push({
          seatId: showSeat.seatId,
          seatLabel: this.label(showSeat.seat),
          applied: false,
          reason: verdict.message,
          code: verdict.code,
        });
        continue;
      }
      // A safety block is releasable, but only on purpose. Clearing one by clicking through
      // a seat map must not be possible.
      if (!isCasuallyReleasable(kind) && !input.force) {
        outcomes.push({
          seatId: showSeat.seatId,
          seatLabel: this.label(showSeat.seat),
          applied: false,
          code: 'EMERGENCY_REQUIRES_FORCE',
          reason:
            'This is an emergency block. Releasing it puts a seat back on sale that was withdrawn for safety — confirm explicitly to proceed.',
        });
        continue;
      }
      releasing.push(showSeat.seatId);
    }

    let affectedIds: string[] = [];
    if (releasing.length > 0) {
      // Only ever un-blocks. `status = 'BLOCKED'` in the WHERE means this can never free a
      // seat somebody bought, however wrong the pre-read turned out to be.
      const rows = await this.prisma.$queryRaw<{ seatId: string }[]>`
        UPDATE "ShowSeat"
           SET "status" = 'AVAILABLE',
               "overrideKind" = NULL,
               "overrideReason" = NULL,
               "overrideByUserId" = NULL,
               "overrideAt" = NULL,
               "overrideExpiresAt" = NULL,
               "version" = "version" + 1,
               "updatedAt" = NOW()
         WHERE "eventSessionId" = ${sessionId}
           AND "seatId" IN (${Prisma.join(releasing)})
           AND "status" = 'BLOCKED'
        RETURNING "seatId"
      `;
      affectedIds = rows.map((r) => r.seatId);
    }

    const affected = new Set(affectedIds);
    for (const seatId of releasing) {
      const showSeat = seats.find((s) => s.seatId === seatId)!;
      outcomes.push(
        affected.has(seatId)
          ? { seatId, seatLabel: this.label(showSeat.seat), applied: true }
          : {
              seatId,
              seatLabel: this.label(showSeat.seat),
              applied: false,
              code: 'SEAT_NOT_BLOCKED',
              reason: 'This seat was no longer blocked by the time the release was applied.',
            },
      );
    }

    const appliedOutcomes = outcomes.filter((o) => o.applied);
    if (appliedOutcomes.length > 0) {
      await this.recordSeatAudit(
        user,
        session,
        input.force ? 'SHOW_SEATS_RELEASED_FORCED' : 'SHOW_SEATS_RELEASED',
        {
          reason: input.reason,
          seatCount: appliedOutcomes.length,
          seats: appliedOutcomes.map((o) => o.seatLabel),
          // Recording what was undone matters as much as recording the undo.
          previousKinds: [
            ...new Set(
              seats
                .filter((s) => appliedOutcomes.some((o) => o.seatId === s.seatId))
                .map((s) => s.overrideKind)
                .filter(Boolean),
            ),
          ],
        },
      );
    }

    return this.summarise(sessionId, outcomes, []);
  }

  /**
   * Sweep maintenance blocks whose deadline has passed.
   *
   * Only ever touches rows that are still BLOCKED with an elapsed deadline, so a seat
   * re-blocked for a different reason in the meantime is left alone. Idempotent, and safe
   * to run from a schedule or on demand.
   */
  async expireLapsedOverrides(now = new Date()): Promise<{ released: number }> {
    const released = await this.prisma.$executeRaw`
      UPDATE "ShowSeat"
         SET "status" = 'AVAILABLE',
             "overrideKind" = NULL,
             "overrideReason" = NULL,
             "overrideByUserId" = NULL,
             "overrideAt" = NULL,
             "overrideExpiresAt" = NULL,
             "version" = "version" + 1,
             "updatedAt" = NOW()
       WHERE "status" = 'BLOCKED'
         AND "overrideExpiresAt" IS NOT NULL
         AND "overrideExpiresAt" <= ${now}
    `;
    return { released };
  }

  // ── Accessibility ───────────────────────────────────────────────────────────────

  /**
   * Companion seats worth holding beside a wheelchair space.
   *
   * Suggests; it does not act. Whether to hold a neighbouring seat on a sold-out premiere is
   * an operational judgement, and making it automatic would quietly remove sellable
   * inventory on every accessible booking.
   */
  async companionSuggestions(user: RequestUser, sessionId: string, wheelchairSeatId: string) {
    await this.loadOwnedSession(user, sessionId, undefined);

    const rows = await this.prisma.showSeat.findMany({
      where: { eventSessionId: sessionId },
      select: {
        seatId: true,
        status: true,
        seat: { select: { colIndex: true, kind: true, row: { select: { label: true } } } },
      },
    });

    const seatIds = companionCandidates(
      rows.map((r) => ({
        seatId: r.seatId,
        row: r.seat.row.label,
        colIndex: r.seat.colIndex,
        kind: r.seat.kind,
        status: r.status as SeatStatus,
      })),
      wheelchairSeatId,
    );

    return {
      sessionId,
      wheelchairSeatId,
      candidates: seatIds.map((id) => {
        const row = rows.find((r) => r.seatId === id)!;
        return { seatId: id, label: `${row.seat.row.label}${row.seat.colIndex}` };
      }),
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────────

  /**
   * Every requested seat must exist on THIS show.
   *
   * Without this, passing another show's seat ids would silently no-op and report success —
   * and a cross-tenant caller could probe which ids exist by watching the counts.
   */
  private assertSeatsBelongToShow(found: { seatId: string }[], requested: string[]) {
    if (found.length === requested.length) return;
    const missing = requested.filter((id) => !found.some((f) => f.seatId === id));
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      `${missing.length} of the selected seats do not belong to this show.`,
      HttpStatus.BAD_REQUEST,
      { reason: 'SEAT_NOT_ON_SHOW' },
    );
  }

  private summarise(
    sessionId: string,
    outcomes: SeatOverrideOutcome[],
    warnings: string[],
  ): OverrideResult {
    // Stable order so a UI list does not reshuffle between calls.
    const seats = [...outcomes].sort((a, b) => a.seatLabel.localeCompare(b.seatLabel));
    return {
      sessionId,
      applied: seats.filter((s) => s.applied).length,
      refused: seats.filter((s) => !s.applied).length,
      seats,
      warnings,
    };
  }
}
