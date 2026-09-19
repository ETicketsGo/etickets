import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AnonymousSessionService } from './orchestration/booking-owner';
import { BookingWorkflowRepository } from './orchestration/booking-workflow.repository';

/**
 * What a presented `x-anon-session` proves about one booking.
 *
 * `UNBOUND` is deliberately not the same answer as `BOUND`. It means the booking records no
 * session at all, so nothing was verified and nothing could be — and whether that is good enough
 * is a decision each route makes for itself, because the routes are not equally dangerous:
 *
 *   * READ  — accepted. This is the behaviour every environment already had, and refusing it
 *             would lock somebody who bought before the column existed out of the tickets they
 *             paid for.
 *   * PAY   — accepted, for the same reason and with less at stake: the server decides provider,
 *             amount and currency, so the worst outcome is somebody paying for a booking that is
 *             not theirs.
 *   * CLAIM — REFUSED. Adopting a booking is permanent and it takes somebody's tickets away, so
 *             "a booking id plus a token I minted myself" must not be enough. Those callers are
 *             sent to the link in their confirmation email, which is a proof they do have.
 */
export type GuestSessionProof = 'BOUND' | 'UNBOUND' | null;

/**
 * Whether the browser presenting a session token is the one that created the booking.
 *
 * ── WHY THIS IS ITS OWN SERVICE ────────────────────────────────────────────────────
 * Three routes need the same answer and they live on two classes — the guest read and claim on
 * `GuestBookingService`, the guest payment on `BookingExecutionRouter`. The rule was previously
 * written out at each site, and the sites disagreed: the read and the payment checked only that
 * the token was well FORMED, which a caller can satisfy by generating 256 random bits. The real
 * check existed on exactly one path and only when the booking orchestrator ran in ACTIVE mode,
 * which no environment does.
 *
 * One implementation, so a route cannot be added later that forgets.
 */
@Injectable()
export class GuestSessionVerifier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly workflows: BookingWorkflowRepository,
    private readonly anon: AnonymousSessionService,
  ) {}

  /** The single source of truth for the current orchestration mode, read the same way. */
  private activeMode(): boolean {
    return (
      this.config.get<boolean>('BOOKING_ORCHESTRATOR_ENABLED') === true &&
      this.config.get<string>('BOOKING_ORCHESTRATOR_MODE', 'shadow') === 'active'
    );
  }

  /**
   * Verify against a booking the caller has already loaded.
   *
   * ── EVERY BINDING THAT EXISTS MUST AGREE ───────────────────────────────────────────
   * A booking can record the session that made it in up to two places: `guestSessionHash` on the
   * booking, written in every mode, and — for one created while the orchestrator was ACTIVE — the
   * owner on its workflow. Both are the SHA-256 of the same raw token, so they agree for the real
   * buyer, and a disagreement in either is a refusal. Checking both rather than replacing one with
   * the other means turning the flag on cannot quietly reduce what is verified.
   */
  async verify(
    booking: { id: string; guestSessionHash: string | null },
    anonymousToken: string,
  ): Promise<GuestSessionProof> {
    const bindings: string[] = [];
    if (booking.guestSessionHash) bindings.push(booking.guestSessionHash);
    if (this.activeMode()) {
      const workflow = await this.workflows.getByBookingId(booking.id);
      /*
        Only an ANONYMOUS_SESSION owner is a session binding. A workflow with no owner recorded (a
        row predating ownership) or one owned by a USER says nothing about this token, and reading
        either as a binding would refuse a guest who holds exactly the right credential.

        Consulted only in active mode, as it always was: in shadow a workflow row can exist from
        observation without its owner being this buyer's session.
      */
      if (workflow?.ownerType === 'ANONYMOUS_SESSION' && workflow.ownerId) {
        bindings.push(workflow.ownerId);
      }
    }
    // Nothing recorded to check against. Never reached for a booking created since the migration:
    // the router writes the hash in the same transaction that inserts the booking.
    if (bindings.length === 0) return 'UNBOUND';
    // Constant-time, and ALL of them: `matches` hashes what was presented and compares digests, so
    // it never reports how much of a token was right.
    return bindings.every((hash) => this.anon.matches(anonymousToken, hash)) ? 'BOUND' : null;
  }

  /**
   * Verify when the caller has only a booking id — the guest payment route.
   *
   * A booking that does not exist reads as `UNBOUND` rather than as a refusal, on purpose: it has
   * no binding, and turning "no such booking" into a 403 here would make this method responsible
   * for an answer that belongs to the service doing the work. That service already produces its
   * own 404, and it produces the same one it always did.
   */
  async verifyByBookingId(bookingId: string, anonymousToken: string): Promise<GuestSessionProof> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, guestSessionHash: true },
    });
    if (!booking) return 'UNBOUND';
    return this.verify(booking, anonymousToken);
  }
}
