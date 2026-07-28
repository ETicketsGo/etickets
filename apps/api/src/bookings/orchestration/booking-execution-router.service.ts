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
import { LocalBookingOrchestrator } from './local-booking-orchestrator.service';
import { AnonymousSessionService, BookingOwnerResolver, type ResolvedOwner } from './booking-owner';
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

  async initiate(ctx: InitiateContext): Promise<unknown> {
    const mode = this.mode();
    this.metrics.recordBookingApi('initiate', mode, this.ownerTypeLabel(ctx.user));
    if (mode !== 'active') {
      // disabled + shadow: unchanged legacy path (shadow observation happens inside create()).
      return this.bookings.create(ctx.user ?? null, ctx.body, ctx.idempotencyKey);
    }

    // Active mode: resolve durable ownership server-side. A brand-new guest with no token
    // is issued one now and it is returned once in the response.
    let issuedToken: string | undefined;
    let owner: ResolvedOwner;
    if (ctx.user?.id) {
      owner = { ownerType: 'USER', ownerId: ctx.user.id };
    } else {
      const token = this.anon.isWellFormed(ctx.anonymousToken)
        ? ctx.anonymousToken
        : (issuedToken = this.anon.issueToken());
      owner = { ownerType: 'ANONYMOUS_SESSION', ownerId: this.anon.hash(token) };
    }

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
    const response = await this.shapeBookingResponse(result.bookingId);
    return issuedToken ? { ...response, anonymousSessionToken: issuedToken } : response;
  }

  // ── Payment initiation ──────────────────────────────────────────────────────

  async beginPayment(ctx: PaymentContext): Promise<unknown> {
    const mode = this.mode();
    this.metrics.recordBookingApi('begin_payment', mode, this.ownerTypeLabel(ctx.user));
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
      // No legacy customer-cancel endpoint exists; disabled/shadow reject rather than
      // inventing behaviour. Unpaid holds still expire via the durable sweep.
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Booking cancellation is not available.',
        HttpStatus.CONFLICT,
      );
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
      include: { payment: true },
    });
    if (!b) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    return {
      id: b.id,
      status: b.status,
      currency: b.currency,
      holdExpiresAt: b.holdExpiresAt,
      fees: {
        bookingFeeMinor: b.bookingFeeMinor,
        paymentFeeMinor: b.paymentFeeMinor,
        discountMinor: b.discountMinor,
        customerFeeMinor: b.customerFeeMinor,
        organizerFeeMinor: b.organizerFeeMinor,
        totalMinor: b.totalMinor,
      },
      payment: { id: b.payment?.id, status: b.payment?.status },
    };
  }
}
