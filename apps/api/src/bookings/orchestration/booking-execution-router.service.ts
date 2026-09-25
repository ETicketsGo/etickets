import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CreateBookingInput } from '@eticketsgo/validation';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { AuditService } from '../../audit/audit.service';
import { BookingsService } from '../bookings.service';
import { PaymentsService } from '../../payments/payments.service';
import { feeTaxSummary } from '../../pricing/fee-tax';
import { LocalBookingOrchestrator } from './local-booking-orchestrator.service';
import { AnonymousSessionService, BookingOwnerResolver, type ResolvedOwner } from './booking-owner';
import { GuestSessionVerifier } from '../guest-session';
import { toPublicBookingStatus } from './booking-status.mapping';
import { BookingWorkflowState as WS } from './booking-workflow-state';

export type OrchestrationMode = 'disabled' | 'shadow' | 'active';

export interface RequestPrincipal {
  /** Authenticated user (from the trusted JWT principal), if any. */
  user?: RequestUser | null;
  /** Raw anonymous checkout token from the `x-anon-session` header, if any. */
  anonymousToken?: string | null;
  correlationId?: string;
  ip?: string | null;
}

export interface InitiateContext extends RequestPrincipal {
  body: CreateBookingInput;
  idempotencyKey?: string;
}

export interface PaymentContext extends RequestPrincipal {
  bookingId: string;
  /** Guest payment route: a well-formed anonymous session token is mandatory (every mode). */
  requireAnonymousToken?: boolean;
}

export interface StatusContext extends RequestPrincipal {
  bookingId: string;
}

export interface CancelContext extends RequestPrincipal {
  bookingId: string;
  reason?: string;
}

/**
 * The ONE authoritative booking-execution routing decision point (ADR-042 §2, P5.2A).
 * Controllers call ONLY this — no controller or service re-checks the mode flags. It
 * selects exactly one mode per operation:
 *
 *   disabled → legacy BookingsService/PaymentsService only
 *   shadow   → legacy path (+ the existing in-service shadow observation), legacy response
 *   active   → LocalBookingOrchestrator for supported LOCAL_AUTHORITATIVE inventory, with
 *              NO silent mid-flow fallback to the legacy path
 *
 * Public request/response shapes are preserved in every mode; active mode adds only
 * internal fields (never removing or changing existing ones), plus a one-time
 * `anonymousSessionToken` for brand-new guest checkouts.
 *
 * That last field is now returned in EVERY mode rather than only in active mode, and the guest's
 * session hash is written onto the booking in every mode too. It is the same additive, optional
 * field clients already read; what changed is that a guest checkout no longer depends on an
 * orchestration flag for the one credential that gets the buyer back to their booking. See
 * {@link BookingExecutionRouter.guestSession}.
 */
@Injectable()
export class BookingExecutionRouter {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
    private readonly payments: PaymentsService,
    private readonly orchestrator: LocalBookingOrchestrator,
    private readonly owners: BookingOwnerResolver,
    private readonly anon: AnonymousSessionService,
    // One implementation of "is this the browser that created the booking?", shared with the guest
    // read and claim routes on GuestBookingService. See GuestSessionVerifier.
    private readonly sessions: GuestSessionVerifier,
  ) {}

  /** The single source of truth for the current orchestration mode. */
  mode(): OrchestrationMode {
    if (this.config.get<boolean>('BOOKING_ORCHESTRATOR_ENABLED') !== true) return 'disabled';
    return this.config.get<string>('BOOKING_ORCHESTRATOR_MODE', 'shadow') === 'active'
      ? 'active'
      : 'shadow';
  }

  private ownerTypeLabel(user?: RequestUser | null): 'user' | 'anonymous' {
    return user?.id ? 'user' : 'anonymous';
  }

  // ── Initiation ────────────────────────────────────────────────────────────

  /**
   * The anonymous checkout session a guest is buying under — the same answer in every mode.
   *
   * ── WHY THIS IS NOT DECIDED PER MODE ANY MORE ──────────────────────────────────────
   * It was, and the consequence was found end to end: guest ownership lived only on
   * `BookingWorkflow.ownerId`, which is written only in ACTIVE mode, and every environment runs
   * SHADOW. So there was nothing for a presented `x-anon-session` to be checked against — any
   * well-formed token opened any guest booking whose id somebody knew, and the browser that had
   * just bought the booking could not prove it in order to claim it. The session is now written
   * onto the booking itself, in every mode, which is what makes it a fact rather than a mode.
   *
   * A guest who presents a well-formed token keeps it, so a second purchase in the same browser
   * joins the same session. One who presents none is issued one, and it is returned once — the
   * only copy that ever leaves the server.
   */
  private guestSession(presented?: string | null): {
    token: string;
    hash: string;
    issued: boolean;
  } {
    const issued = !this.anon.isWellFormed(presented);
    const token = issued ? this.anon.issueToken() : presented;
    return { token, hash: this.anon.hash(token), issued };
  }

  /**
   * Bind the session to the booking, once and only while it is unbound.
   *
   * `userId: null` and `guestSessionHash: null` are in the WHERE clause rather than checked
   * beforehand, so this can never overwrite a binding that already exists or touch an account
   * booking — which is what makes it safe to call on an idempotent replay, and safe if it is ever
   * reached twice.
   */
  private bindGuestSession(
    client: { booking: { updateMany: (args: unknown) => Promise<unknown> } },
    bookingId: string,
    hash: string,
  ): Promise<unknown> {
    return client.booking.updateMany({
      where: { id: bookingId, userId: null, guestSessionHash: null },
      data: { guestSessionHash: hash },
    });
  }

  async initiate(ctx: InitiateContext): Promise<unknown> {
    const mode = this.mode();
    this.metrics.recordBookingApi('initiate', mode, this.ownerTypeLabel(ctx.user));
    // A signed-in buyer is owned by their user id and has no anonymous session at all.
    const guest = ctx.user?.id ? null : this.guestSession(ctx.anonymousToken);

    if (mode !== 'active') {
      /*
        disabled + shadow: the legacy path, plus the one thing that is new in every mode — the
        guest's session hash, written INSIDE the transaction that inserts the booking. Atomic
        deliberately: a booking that exists without its session bound is a booking its own buyer
        cannot prove they made, and there is no second moment at which the raw token is in hand.
      */
      const booking = (await this.bookings.create(
        ctx.user ?? null,
        ctx.body,
        ctx.idempotencyKey,
        guest
          ? {
              inHoldTx: async (tx, bookingId) => {
                await this.bindGuestSession(tx as never, bookingId, guest.hash);
              },
            }
          : undefined,
      )) as Record<string, unknown>;
      // Additive, and only when the server minted the token: a client that sent its own already
      // has it. Returned once — nothing stores the raw token, here or anywhere.
      return guest?.issued ? { ...booking, anonymousSessionToken: guest.token } : booking;
    }

    // Active mode: resolve durable ownership server-side. A brand-new guest with no token
    // is issued one now and it is returned once in the response.
    const issuedToken: string | undefined = guest?.issued ? guest.token : undefined;
    const owner: ResolvedOwner = ctx.user?.id
      ? { ownerType: 'USER', ownerId: ctx.user.id }
      : { ownerType: 'ANONYMOUS_SESSION', ownerId: guest!.hash };

    const idempotencyKey =
      ctx.idempotencyKey ?? `${owner.ownerId}:${ctx.body.eventSessionId}:${owner.ownerType}`;
    const result = await this.orchestrator.initiate({
      eventSessionId: ctx.body.eventSessionId,
      items: ctx.body.items,
      // Lock-layer owner ref: the user id, or the (hashed) anonymous owner id — never the
      // raw guest token.
      owner: ctx.user?.id ? { ownerId: ctx.user.id } : { anonymousSessionId: owner.ownerId },
      requestOwner: owner,
      buyerName: ctx.body.buyerName,
      buyerEmail: ctx.body.buyerEmail,
      couponCode: ctx.body.couponCode,
      idempotencyKey,
      correlationId: ctx.correlationId,
    });
    await this.audit.record({
      actorUserId: ctx.user?.id ?? null,
      action: 'BOOKING_INITIATED_ACTIVE',
      entityType: 'Booking',
      entityId: result.bookingId,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      metadata: { ownerType: owner.ownerType, workflowState: result.workflowState },
    });
    /*
      The same binding the other modes write, so one rule holds everywhere: every guest booking
      carries the hash of the session that made it. Here it is belt and braces — active mode also
      records the owner on the workflow, atomically — which is why this one write is allowed to
      happen after the booking rather than inside it. If it were ever to fail, the workflow owner
      still proves the session, and the booking falls back to exactly today's behaviour.
    */
    if (guest) await this.bindGuestSession(this.prisma as never, result.bookingId, guest.hash);
    const response = await this.shapeBookingResponse(result.bookingId);
    return issuedToken ? { ...response, anonymousSessionToken: issuedToken } : response;
  }

  // ── Payment initiation ──────────────────────────────────────────────────────

  async beginPayment(ctx: PaymentContext): Promise<unknown> {
    const mode = this.mode();
    this.metrics.recordBookingApi('begin_payment', mode, this.ownerTypeLabel(ctx.user));
    // Guest payment route: a valid anonymous session token is mandatory in EVERY mode, and
    // an authenticated caller may not use the guest route to adopt a guest booking.
    if (ctx.requireAnonymousToken) {
      if (ctx.user) {
        this.metrics.recordBookingOwnerRejection('begin_payment', 'user_on_guest_route');
        throw new AppException(
          ErrorCodes.FORBIDDEN,
          'Use the account payment route when signed in.',
          HttpStatus.FORBIDDEN,
        );
      }
      if (!this.anon.isWellFormed(ctx.anonymousToken)) {
        this.metrics.recordBookingOwnerRejection('begin_payment', 'missing_anonymous_token');
        throw new AppException(
          ErrorCodes.UNAUTHORIZED,
          'A valid guest checkout session is required.',
          HttpStatus.UNAUTHORIZED,
        );
      }
      /*
        And that the session is the one that CREATED this booking.

        Well-formedness was the whole check here, in every mode, which meant 256 bits the caller
        generated themselves plus a booking id was enough to open a payment on somebody else's
        booking. Less harmful than reading it — the server decides provider, amount and currency,
        so the outcome is paying for a stranger's ticket — but the same missing check, and shipping
        a verified read alongside an unverified payment would be incoherent.

        Checked in EVERY mode, on purpose. In active mode the orchestrator also asserts the
        workflow owner; the verifier consults that same owner, so the two agree rather than one
        being the other's exception.

        A booking that records no session is still accepted, exactly as it is on the read route: it
        is the status quo, not a regression, and the storefront always pays with the token it
        created the booking with, so the real path never notices this check.
      */
      const proof = await this.sessions.verifyByBookingId(ctx.bookingId, ctx.anonymousToken);
      if (proof === null) {
        this.metrics.recordBookingOwnerRejection('begin_payment', 'session_not_bound');
        throw new AppException(
          ErrorCodes.FORBIDDEN,
          'This booking was not started in this browser.',
          HttpStatus.FORBIDDEN,
        );
      }
    }
    if (mode !== 'active') {
      return this.payments.createIntent(ctx.bookingId, ctx.user ?? undefined);
    }
    const owner = this.owners.resolveForRequest({
      user: ctx.user,
      anonymousToken: ctx.anonymousToken,
    });
    const result = await this.orchestrator.beginPayment({
      bookingId: ctx.bookingId,
      owner: { ownerId: ctx.user?.id },
      requestOwner: owner,
      idempotencyKey: ctx.bookingId,
      correlationId: ctx.correlationId,
    });
    await this.audit.record({
      actorUserId: ctx.user?.id ?? null,
      action: 'BOOKING_PAYMENT_INITIATED_ACTIVE',
      entityType: 'Booking',
      entityId: ctx.bookingId,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      metadata: { ownerType: owner.ownerType, workflowState: result.workflowState },
    });
    return result.payment;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async getStatus(ctx: StatusContext): Promise<unknown> {
    // Status retrieval keeps the existing owner-checked getForUser contract in every mode;
    // authenticated users always use the trusted principal. (Guest status retrieval is not
    // part of the existing public API and is intentionally unchanged here.)
    const mode = this.mode();
    this.metrics.recordBookingApi('status', mode, this.ownerTypeLabel(ctx.user));
    if (!ctx.user) {
      throw new AppException(
        ErrorCodes.UNAUTHORIZED,
        'Sign in to view this booking.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.bookings.getForUser(ctx.user, ctx.bookingId);
  }

  // ── Cancellation ─────────────────────────────────────────────────────────────

  async cancel(ctx: CancelContext): Promise<unknown> {
    const mode = this.mode();
    this.metrics.recordBookingApi('cancel', mode, this.ownerTypeLabel(ctx.user));
    if (mode !== 'active') {
      /*
        The signed-in buyer's own unpaid booking, cancelled on the legacy path — see
        `BookingsService.cancelUnpaid` for what that does and refuses.

        A guest is accepted here too, and was not always. The old refusal reasoned that the
        anonymous checkout token is bound to a booking only by the orchestration workflow, which
        this path never creates - so anyone holding a booking id could have released somebody
        else's seats. That is no longer how the binding works: `guestSessionHash` is written onto
        the booking in every mode, so the same verifier the payment route uses can answer here,
        and it is held to its strictest answer. Reported from QA: a guest pressed "Yes, cancel
        it" and the screen sat on Review & pay, because this threw a 409 the buyer never saw.
      */
      if (!ctx.user) {
        const proof = await this.sessions.verifyByBookingId(
          ctx.bookingId,
          ctx.anonymousToken ?? '',
        );
        /*
          BOUND only, unlike the read and the payment above. Those two grade `UNBOUND` as good
          enough because the worst case is somebody seeing, or paying for, a booking that is not
          theirs. Cancelling RELEASES it: the seats go back on sale and the buyer arrives at a
          screen saying their hold is gone. So this is graded like `claim` - the session hash on
          the booking has to match, and a self-minted token proves nothing.
        */
        if (proof !== 'BOUND') {
          // Three different things, counted separately: a caller with no token at all, one whose
          // token does not match, and a booking that records no session to match against.
          this.metrics.recordBookingOwnerRejection(
            'cancel',
            !ctx.anonymousToken
              ? 'session_missing'
              : proof === null
                ? 'session_mismatch'
                : 'session_not_bound',
          );
          throw new AppException(
            ErrorCodes.FORBIDDEN,
            'This booking was not started in this browser.',
            HttpStatus.FORBIDDEN,
          );
        }
        return this.bookings.cancelUnpaidAsGuest(ctx.bookingId);
      }
      return this.bookings.cancelUnpaid(ctx.user, ctx.bookingId);
    }
    const owner = this.owners.resolveForRequest({
      user: ctx.user,
      anonymousToken: ctx.anonymousToken,
    });
    const result = await this.orchestrator.cancel({
      bookingId: ctx.bookingId,
      owner: { ownerId: ctx.user?.id },
      requestOwner: owner,
      reason: ctx.reason,
      correlationId: ctx.correlationId,
    });
    await this.audit.record({
      actorUserId: ctx.user?.id ?? null,
      action: 'BOOKING_CANCELLED_ACTIVE',
      entityType: 'Booking',
      entityId: ctx.bookingId,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      metadata: { ownerType: owner.ownerType, refundPending: result.refundPending },
    });
    return {
      id: ctx.bookingId,
      status: toPublicBookingStatus(result.workflowState as WS),
      refundPending: result.refundPending,
    };
  }

  /**
   * Booking-orchestration health/readiness (ADR-042 §22). Bounded counts only — never lists
   * or ids. Reports the mode, that active routes are wired, and durable-drift signals
   * (stuck workflows, manual-review backlog) so operators can gate an active rollout.
   */
  async health(): Promise<Record<string, unknown>> {
    const mode = this.mode();
    const activePreStates = [WS.DRAFT, WS.INVENTORY_RESOLVED, WS.LOCK_PENDING, WS.LOCKED];
    const staleBefore = new Date(Date.now() - 15 * 60 * 1000);
    const [manualReviewBacklog, stuckWorkflows] = await Promise.all([
      this.prisma.bookingWorkflow.count({ where: { state: WS.MANUAL_REVIEW } }).catch(() => -1),
      this.prisma.bookingWorkflow
        .count({ where: { state: { in: activePreStates }, updatedAt: { lt: staleBefore } } })
        .catch(() => -1),
    ]);
    // Active mode requires sourcing on to resolve a provider (also enforced at startup).
    const sourcingEnabled = this.config.get<boolean>('INVENTORY_SOURCING_ENABLED') === true;
    const ready = mode !== 'active' || sourcingEnabled;
    return {
      mode,
      activeRoutesWired: true,
      sourcingEnabled,
      manualReviewBacklog,
      stuckWorkflows,
      ready,
    };
  }

  /**
   * Rebuild the existing public booking-create response shape from durable data (active
   * mode) so mobile/web clients see no contract change. Internal workflow state is not
   * exposed.
   */
  private async shapeBookingResponse(bookingId: string): Promise<Record<string, unknown>> {
    const b = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true, taxLines: true },
    });
    if (!b) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    return {
      id: b.id,
      status: b.status,
      currency: b.currency,
      holdExpiresAt: b.holdExpiresAt,
      /*
        The whole fee breakdown the legacy path returns, rebuilt from the booking's snapshot.

        This used to send six of the fields, and not `currency`, `subtotalMinor` or
        `netSubtotalMinor` — which the clients' price breakdown requires — so switching
        orchestration on would have broken the checkout summary without changing a price.
        Everything here is read from what the booking stored, so it is the price the order
        was actually taken at.
      */
      fees: {
        currency: b.currency,
        subtotalMinor: b.subtotalMinor,
        discountMinor: b.discountMinor,
        netSubtotalMinor: b.subtotalMinor - b.discountMinor,
        bookingFeeMinor: b.bookingFeeMinor,
        paymentFeeMinor: b.paymentFeeMinor,
        customerFeeMinor: b.customerFeeMinor,
        organizerFeeMinor: b.organizerFeeMinor,
        taxLines: b.taxLines.map((t) => ({
          label: t.label,
          rateBasisPoints: t.rateBasisPoints,
          baseMinor: t.baseMinor,
          amountMinor: t.amountMinor,
          basis: t.basis,
          inclusive: t.inclusive,
        })),
        ...feeTaxSummary(b.taxLines, b.customerFeeMinor),
        taxMinor: b.taxMinor,
        maintenanceMinor: b.maintenanceMinor,
        maintenanceTreatment: b.maintenanceTreatment,
        totalMinor: b.totalMinor,
      },
      payment: { id: b.payment?.id, status: b.payment?.status },
    };
  }
}
