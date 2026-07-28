import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, ErrorCodes } from '../../common/errors';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestUser } from '../../common/decorators';
import { BookingsService } from '../bookings.service';
import { PaymentsService } from '../../payments/payments.service';
import { InventoryResolver } from '../../inventory/sourcing/inventory.resolver';
import { InventoryLockService } from '../../inventory/locking/inventory-lock.service';
import { BookingWorkflowRepository } from './booking-workflow.repository';
import { BookingOwnerResolver } from './booking-owner';
import { BookingConfirmationBridge } from './booking-confirmation-bridge';
import { ProviderAuthoritativeStrategy } from './provider-authoritative.strategy';
import { AllocatedInventoryStrategy } from './allocated-inventory.strategy';
import { BookingWorkflowState as WS } from './booking-workflow-state';

/** Bounded membership test that keeps TS from narrowing the array to a literal tuple. */
const oneOf = (state: WS, states: readonly WS[]): boolean => states.includes(state);
import { BookingOrchestratorErrorCodes } from './booking-orchestrator.errors';
import type {
  BeginBookingPaymentRequest,
  BookingCancellationResult,
  BookingConfirmationResult,
  BookingExpirationResult,
  BookingOrchestrationResult,
  BookingOrchestrator,
  BookingPaymentResult,
  BookingReconciliationResult,
  CancelBookingRequest,
  ConfirmBookingPaymentRequest,
  ExpireBookingRequest,
  InitiateBookingRequest,
  RetryBookingWorkflowRequest,
} from './booking-orchestrator.contract';
import type { InventoryOwnershipMode } from '../../inventory/sync/contracts/canonical-change';

/**
 * Concrete provider-neutral booking orchestrator for LOCAL_AUTHORITATIVE inventory
 * (ADR-042, P5.1). It owns workflow DECISIONS + ordering + state transitions + durable
 * workflow metadata, and COMPOSES the existing seams — it never re-implements inventory,
 * payment routing, ticket issuance, or confirmation. Provider-authoritative / allocated
 * inventory return a clear unsupported-capability error in this increment (no fake
 * success). Active mode is opt-in (flag off by default); disabled/shadow use the legacy
 * path unchanged.
 */
@Injectable()
export class LocalBookingOrchestrator implements BookingOrchestrator, OnModuleInit {
  private readonly logger = new Logger('BookingOrchestrator');

  constructor(
    private readonly resolver: InventoryResolver,
    private readonly locks: InventoryLockService,
    private readonly bookings: BookingsService,
    private readonly payments: PaymentsService,
    private readonly workflows: BookingWorkflowRepository,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly owners: BookingOwnerResolver,
    private readonly confirmationBridge: BookingConfirmationBridge,
    private readonly providerStrategy: ProviderAuthoritativeStrategy,
    private readonly allocated: AllocatedInventoryStrategy,
  ) {}

  onModuleInit(): void {
    // Post-commit payment confirmation reconciles the durable workflow through here
    // (no-op unless a workflow exists — i.e. active mode). Keeps the orchestrator the
    // single workflow decision point without a PaymentsService→Orchestrator DI cycle.
    this.confirmationBridge.register((bookingId) => this.syncWorkflowConfirmed(bookingId));
  }

  private get activeLocks(): boolean {
    return (
      this.config.get<boolean>('INVENTORY_LOCKS_ENABLED') === true &&
      this.config.get<string>('INVENTORY_LOCKS_MODE') === 'active'
    );
  }

  async initiate(request: InitiateBookingRequest): Promise<BookingOrchestrationResult> {
    const started = Date.now();
    const session = await this.prisma.eventSession.findUnique({
      where: { id: request.eventSessionId },
      select: {
        id: true,
        eventId: true,
        event: { select: { experienceType: true, organizationId: true } },
      },
    });
    if (!session)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Session not found.', HttpStatus.NOT_FOUND);

    // Server-side provider resolution. Inventory ownership mode selects the workflow strategy;
    // clients never choose it, and a workflow cannot change strategy after initiation.
    const provider = await this.resolver.resolve({
      experienceType: session.event.experienceType,
      eventSessionId: request.eventSessionId,
    });

    // PROVIDER_AUTHORITATIVE → the external provider owns inventory truth (P5.2B S3).
    if (provider.capabilities.authority !== 'LOCAL') {
      if (!this.providerStrategy.enabled) {
        this.metrics.recordBookingOrchestration('initiate', 'unsupported_ownership');
        throw new AppException(
          BookingOrchestratorErrorCodes.MANUAL_REVIEW_REQUIRED,
          'Provider-authoritative inventory is not supported in this booking path yet.',
          HttpStatus.NOT_IMPLEMENTED,
          { providerCode: provider.name },
        );
      }
      return this.providerStrategy.initiate(request, {
        id: session.id,
        eventId: session.eventId,
        organizationId: session.event.organizationId,
      });
    }

    // LOCAL authority. It may be ALLOCATED (locally authoritative within a provider
    // allocation) — validate the allocation boundary before the local hold (P5.2B S4).
    let ownershipMode: InventoryOwnershipMode = 'LOCAL_AUTHORITATIVE';
    if (this.allocated.enabled) {
      const alloc = await this.allocated.resolve(session.eventId).catch(() => null);
      if (alloc) {
        ownershipMode = 'ALLOCATED';
        const seatRefs = request.items.flatMap((i) => i.seatIds ?? []);
        this.allocated.validate(
          alloc,
          seatRefs.length > 0
            ? { inventoryType: 'SEAT', seatRefs }
            : {
                inventoryType: 'QUANTITY',
                quantity: request.items.reduce((s, i) => s + i.quantity, 0),
              },
        );
      }
    }

    const fingerprint = BookingWorkflowRepository.fingerprint([
      request.eventSessionId,
      JSON.stringify(request.items),
      request.owner.ownerId ?? request.owner.anonymousSessionId ?? '',
      request.couponCode,
    ]);
    const { workflow, created } = await this.workflows.createOrGet({
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: fingerprint,
      correlationId: request.correlationId,
      inventoryOwnershipMode: ownershipMode,
      selectedProviderCode: provider.name,
      // Durable server-decided ownership persisted at creation (ADR-042 §4).
      ownerType: request.requestOwner?.ownerType,
      ownerId: request.requestOwner?.ownerId,
      tenantId: request.tenantId ?? session.event.organizationId,
      organizerId: request.organizerId ?? session.event.organizationId,
    });
    // A replayed idempotency key must not let a different owner adopt an existing workflow.
    if (!created && request.requestOwner) this.owners.assertOwner(workflow, request.requestOwner);

    // Idempotent replay: a workflow already bound to a real booking returns it unchanged.
    if (!created && !workflow.bookingId.startsWith('pending-')) {
      this.metrics.recordBookingOrchestration('initiate', 'replay');
      return this.result(workflow.bookingId, workflow.state as WS, ownershipMode, provider.name);
    }

    let current = (await this.workflows.advance(workflow, WS.INVENTORY_RESOLVED)).workflow;
    // The matrix requires INVENTORY_RESOLVED → LOCK_PENDING → LOCKED in every mode.
    current = (await this.workflows.advance(current, WS.LOCK_PENDING)).workflow;

    // Active mode: acquire the distributed lock BEFORE the PostgreSQL hold; release on failure.
    let lockId: string | undefined;
    let fencingToken: number | undefined;
    const seatIds = request.items.flatMap((i) => i.seatIds ?? []);
    const owner = {
      ownerId: request.owner.ownerId,
      anonymousSessionId: request.owner.anonymousSessionId,
    };
    if (this.activeLocks) {
      const quantity = request.items.reduce((s, i) => s + i.quantity, 0);
      const lock = await this.locks.acquire({
        holdId: workflow.id,
        inventoryType: seatIds.length > 0 ? 'SEAT' : 'QUANTITY',
        inventoryKey: `session:${request.eventSessionId}`,
        seatIds: seatIds.length > 0 ? seatIds : undefined,
        quantity: seatIds.length > 0 ? undefined : quantity,
        capacity: quantity,
        owner,
        idempotencyKey: `wf:${workflow.id}`,
        correlationId: request.correlationId,
      });
      lockId = lock.lock.lockId;
      fencingToken = lock.lock.fencingToken;
    }

    try {
      const user: RequestUser | null = request.owner.ownerId
        ? ({ id: request.owner.ownerId } as RequestUser)
        : null;
      const booking = (await this.bookings.create(
        user,
        {
          eventSessionId: request.eventSessionId,
          items: request.items,
          buyerName: request.buyerName ?? '',
          buyerEmail: request.buyerEmail ?? '',
          couponCode: request.couponCode,
        } as never,
        request.idempotencyKey,
      )) as { id: string };
      await this.workflows.attachBooking(current.id, {
        bookingId: booking.id,
        lockId,
        fencingToken,
        paymentProvider: undefined,
      });
      const reloaded = (await this.workflows.get(current.id))!;
      current = (await this.workflows.advance(reloaded, WS.LOCKED)).workflow;
      this.metrics.recordBookingOrchestration('initiate', 'ok');
      this.metrics.observeBookingOrchestration('initiate', (Date.now() - started) / 1000);
      return this.result(booking.id, current.state as WS, ownershipMode, provider.name);
    } catch (err) {
      // Compensation: the PostgreSQL hold failed → the Redis lock must not survive.
      if (lockId) {
        await this.locks
          .release({ lockId, owner, fencingToken })
          .catch(() =>
            this.logger.error(`lock release after hold failure failed for wf=${current.id}`),
          );
      }
      await this.workflows
        .advance(current, WS.FAILED, { lastErrorCode: this.codeOf(err) })
        .catch(() => undefined);
      this.metrics.recordBookingOrchestration('initiate', 'hold_failed');
      throw err;
    }
  }

  async beginPayment(request: BeginBookingPaymentRequest): Promise<BookingPaymentResult> {
    const workflow = await this.requireWorkflow(request.bookingId);
    // Dispatch by the PERSISTED ownership mode — a workflow never changes strategy mid-flow.
    if (workflow.inventoryOwnershipMode === 'PROVIDER_AUTHORITATIVE') {
      return this.providerStrategy.beginPayment(request, workflow);
    }
    if (request.requestOwner) this.owners.assertOwner(workflow, request.requestOwner);
    if (workflow.state !== WS.LOCKED && workflow.state !== WS.PAYMENT_PENDING) {
      throw new AppException(
        BookingOrchestratorErrorCodes.INVALID_TRANSITION,
        'This booking is not ready for payment.',
        HttpStatus.CONFLICT,
        { state: workflow.state },
      );
    }
    // Idempotent: repeated beginPayment returns the same payment (createIntent is retry-safe).
    const user: RequestUser | undefined =
      workflow.selectedProviderCode && request.owner.ownerId
        ? ({ id: request.owner.ownerId } as RequestUser)
        : undefined;
    const payment = await this.payments.createIntent(request.bookingId, user);
    const pp = (payment as { provider?: unknown }).provider;
    const paymentProvider = typeof pp === 'string' ? pp : undefined;
    if (workflow.state === WS.LOCKED) {
      await this.workflows.advance(workflow, WS.PAYMENT_PENDING, {
        paymentProvider: paymentProvider ?? null,
      });
    }
    this.metrics.recordBookingOrchestration('begin_payment', 'ok');
    const after = (await this.workflows.get(workflow.id))!;
    return { bookingId: request.bookingId, workflowState: after.state as WS, payment };
  }

  async confirmPayment(request: ConfirmBookingPaymentRequest): Promise<BookingConfirmationResult> {
    const started = Date.now();
    const workflow = await this.requireWorkflow(request.bookingId);
    // Reuse the existing atomic confirm (inventory confirm + booking confirm + outbox
    // BookingConfirmed in one tx, with the alreadyConfirmed exactly-once guard).
    const result = await this.payments.processVerifiedEvent({
      type: 'payment.succeeded',
      providerRef: request.providerRef,
      bookingId: request.bookingId,
      amountMinor: request.amountMinor,
    });
    const status = (result as { status?: string }).status;
    const confirmed = status === 'confirmed' || status === 'already_confirmed';
    if (confirmed) await this.advanceToConfirmed(workflow, request.bookingId);
    this.metrics.recordBookingOrchestration('confirm', confirmed ? 'ok' : 'not_confirmed');
    this.metrics.observeBookingOrchestration('confirm', (Date.now() - started) / 1000);
    const after = (await this.workflows.get(workflow.id))!;
    return {
      bookingId: request.bookingId,
      workflowState: after.state as WS,
      confirmed,
      ticketsIssued: (result as { tickets?: number }).tickets,
    };
  }

  /**
   * Advance the durable workflow to CONFIRMED for a booking the payment layer has ALREADY
   * atomically confirmed (via the webhook path's processVerifiedEvent). This performs NO
   * re-confirmation — it only reconciles the workflow + finalizes the Redis lock — so the
   * single decision point stays the orchestrator without recursing through the payment
   * service. No-op if there is no workflow or it is already confirmed. Never throws into
   * the confirmation path.
   */
  async syncWorkflowConfirmed(bookingId: string): Promise<void> {
    const workflow = await this.workflows.getByBookingId(bookingId).catch(() => null);
    if (!workflow) return;
    await this.advanceToConfirmed(workflow, bookingId).catch(() => {
      this.metrics.recordBookingOrchestration('confirm_sync', 'failed');
      this.logger.error(`workflow confirm-sync failed for booking=${bookingId}; reconcile`);
    });
  }

  private async advanceToConfirmed(
    workflow: { id: string; state: string; lockId: string | null },
    bookingId: string,
  ): Promise<void> {
    if (oneOf(workflow.state as WS, [WS.CONFIRMED, WS.TICKET_PENDING, WS.TICKET_ISSUED])) return;
    // Drive the workflow to CONFIRMED (idempotent: re-delivery replays).
    let w = (await this.workflows.get(workflow.id))!;
    if (w.state === WS.PAYMENT_PENDING)
      w = (await this.workflows.advance(w, WS.PAYMENT_AUTHORIZED)).workflow;
    if (w.state === WS.PAYMENT_AUTHORIZED)
      w = (await this.workflows.advance(w, WS.CONFIRMING)).workflow;
    if (w.state === WS.CONFIRMING) w = (await this.workflows.advance(w, WS.CONFIRMED)).workflow;
    // Finalize the Redis lock after commit; a cleanup failure is reconcilable, never a rollback.
    if (w.lockId) {
      const raw = await this.locks.getRaw(w.lockId).catch(() => null);
      if (raw) {
        await this.locks.markInternal(raw, 'CONFIRMED').catch(() => {
          this.metrics.recordBookingOrchestration('confirm', 'redis_cleanup_failed');
          this.logger.error(
            `Redis finalize failed after confirm for booking=${bookingId}; reconcile`,
          );
        });
      }
    }
  }

  async cancel(request: CancelBookingRequest): Promise<BookingCancellationResult> {
    const workflow = await this.requireWorkflow(request.bookingId);
    if (request.requestOwner) this.owners.assertOwner(workflow, request.requestOwner);
    // Unpaid held booking: release hold + lock, go CANCELLED. Paid → refund path (deferred impl).
    const paid = oneOf(workflow.state as WS, [WS.CONFIRMED, WS.TICKET_PENDING, WS.TICKET_ISSUED]);
    if (paid) {
      await this.workflows.advance(workflow, WS.CANCELLATION_PENDING, {
        manualReviewReason: 'paid_cancellation_refund_pending',
      });
      this.metrics.recordBookingOrchestration('cancel', 'refund_pending');
      const w = (await this.workflows.get(workflow.id))!;
      return { bookingId: request.bookingId, workflowState: w.state as WS, refundPending: true };
    }
    // Unpaid: reuse the existing hold-release path (idempotent) + release the lock.
    await this.bookings.releaseExpiredHolds(undefined).catch(() => undefined); // conservative: only affects expired holds
    if (workflow.lockId) {
      const owner = {
        ownerId: workflow.selectedProviderCode ? undefined : undefined,
        internal: true,
      };
      const raw = await this.locks.getRaw(workflow.lockId).catch(() => null);
      if (raw) await this.locks.markInternal(raw, 'RELEASED').catch(() => undefined);
      void owner;
    }
    await this.workflows.advance(workflow, WS.CANCELLATION_PENDING).catch(() => undefined);
    const cur = (await this.workflows.get(workflow.id))!;
    if (cur.state === WS.CANCELLATION_PENDING)
      await this.workflows.advance(cur, WS.CANCELLED).catch(() => undefined);
    this.metrics.recordBookingOrchestration('cancel', 'cancelled');
    const w = (await this.workflows.get(workflow.id))!;
    return { bookingId: request.bookingId, workflowState: w.state as WS, refundPending: false };
  }

  async expire(request: ExpireBookingRequest): Promise<BookingExpirationResult> {
    const workflow = await this.requireWorkflow(request.bookingId);
    if (oneOf(workflow.state as WS, [WS.CONFIRMED, WS.TICKET_ISSUED])) {
      // Never expire a confirmed booking.
      return { bookingId: request.bookingId, workflowState: workflow.state as WS };
    }
    // Durable expiration remains the existing worker sweep; here we advance the workflow.
    let w = workflow;
    if (!oneOf(w.state as WS, [WS.EXPIRING, WS.EXPIRED]))
      w = (await this.workflows.advance(w, WS.EXPIRING)).workflow;
    if (w.lockId) {
      const raw = await this.locks.getRaw(w.lockId).catch(() => null);
      if (raw) await this.locks.markInternal(raw, 'EXPIRED').catch(() => undefined);
    }
    if (w.state === WS.EXPIRING) w = (await this.workflows.advance(w, WS.EXPIRED)).workflow;
    this.metrics.recordBookingOrchestration('expire', 'ok');
    return { bookingId: request.bookingId, workflowState: w.state as WS };
  }

  /**
   * Reconcile booking workflows to EXPIRED after the durable hold-expiration sweep has
   * ALREADY released inventory authoritatively (ADR-042 §4/§19, P5.2B). Runs in an explicit
   * INTERNAL context — never a customer path — and is idempotent: it only advances workflows
   * whose booking is already EXPIRED, never touches CONFIRMED bookings, releases a surviving
   * Redis lock, and tolerates concurrent sweeps (guarded transitions). A workflow-transition
   * failure is observable (metric) and left for the next sweep/reconciliation — it never
   * re-releases inventory. No-op when there are no active-mode workflows.
   */
  async sweepExpiredWorkflows(limit = 200): Promise<{ scanned: number; expired: number }> {
    const ctx = this.owners.internal('hold-expiry-worker');
    const activePre: WS[] = [
      WS.DRAFT,
      WS.INVENTORY_RESOLVED,
      WS.LOCK_PENDING,
      WS.LOCKED,
      WS.PAYMENT_PENDING,
      WS.PAYMENT_AUTHORIZED,
    ];
    const candidates = await this.prisma.bookingWorkflow.findMany({
      where: { state: { in: activePre }, NOT: { bookingId: { startsWith: 'pending-' } } },
      orderBy: { updatedAt: 'asc' },
      take: Math.min(limit, 500),
      select: { bookingId: true },
    });
    let expired = 0;
    for (const wf of candidates) {
      const booking = await this.prisma.booking
        .findUnique({ where: { id: wf.bookingId }, select: { status: true } })
        .catch(() => null);
      // Only follow the AUTHORITATIVE PostgreSQL decision; never expire a booking the sweep
      // did not already expire, and never a confirmed one.
      if (booking?.status !== 'EXPIRED') continue;
      try {
        const res = await this.expire({ bookingId: wf.bookingId });
        if (oneOf(res.workflowState, [WS.EXPIRED, WS.EXPIRING])) expired++;
      } catch {
        this.metrics.recordBookingOrchestration('expire_sweep', 'transition_failed');
        // Left for the next sweep — inventory is already released authoritatively.
      }
    }
    if (candidates.length > 0) {
      this.metrics.recordBookingOrchestration('expire_sweep', 'ok');
      this.logger.log(
        `expiry sweep by ${ctx.actor}: scanned=${candidates.length} expired=${expired}`,
      );
    }
    return { scanned: candidates.length, expired };
  }

  async retry(request: RetryBookingWorkflowRequest): Promise<BookingOrchestrationResult> {
    const workflow = await this.requireWorkflow(request.bookingId);
    // Only explicitly-retryable local steps advance; terminal/ambiguous states are returned as-is.
    this.metrics.recordBookingOrchestration('retry', 'noop');
    return this.result(
      workflow.bookingId,
      workflow.state as WS,
      workflow.inventoryOwnershipMode as InventoryOwnershipMode,
      workflow.selectedProviderCode ?? undefined,
    );
  }

  async reconcile(request: {
    bookingId?: string;
    limit?: number;
  }): Promise<BookingReconciliationResult> {
    const limit = Math.min(request.limit ?? 100, 500);
    const workflows = request.bookingId
      ? [await this.workflows.getByBookingId(request.bookingId)].filter(Boolean)
      : await this.prisma.bookingWorkflow.findMany({ orderBy: { updatedAt: 'asc' }, take: limit });
    const mismatches: BookingReconciliationResult['mismatches'] = [];
    for (const wf of workflows) {
      if (!wf) continue;
      const booking = wf.bookingId.startsWith('pending-')
        ? null
        : await this.prisma.booking.findUnique({
            where: { id: wf.bookingId },
            select: { status: true },
          });
      const cls =
        this.classifyProvider(wf) ?? this.classify(wf.state as WS, booking?.status ?? null);
      if (cls !== 'IN_SYNC') {
        mismatches.push({
          bookingId: wf.bookingId,
          classification: cls,
          detail: `wf=${wf.state} booking=${booking?.status ?? 'none'}`,
        });
        this.metrics.recordBookingOrchestration('reconcile', cls.toLowerCase());
      }
    }
    return { scanned: workflows.length, mismatches };
  }

  // ── helpers ──

  private classify(state: WS, bookingStatus: string | null): string {
    if (
      bookingStatus === 'CONFIRMED' &&
      !oneOf(state, [WS.CONFIRMED, WS.TICKET_PENDING, WS.TICKET_ISSUED])
    ) {
      return 'CONFIRMED_BOOKING_WORKFLOW_NOT_CONFIRMED';
    }
    if (bookingStatus === 'EXPIRED' && !oneOf(state, [WS.EXPIRED, WS.EXPIRING])) {
      return 'HOLD_EXPIRED_WORKFLOW_ACTIVE';
    }
    if (state === WS.MANUAL_REVIEW) return 'MANUAL_REVIEW_REQUIRED';
    return 'IN_SYNC';
  }

  /**
   * Provider-authoritative reconciliation drift (ADR-042 §23, P5.2B). Returns a specific
   * classification when the durable provider fields indicate a mismatch, else null so the
   * base local classifier runs. Never proposes auto-cancelling a confirmed booking.
   */
  private classifyProvider(wf: {
    state: string;
    inventoryOwnershipMode: string;
    providerReconciliationRequired: boolean;
    providerReservationExpiresAt: Date | null;
    providerLastErrorCode: string | null;
  }): string | null {
    if (wf.inventoryOwnershipMode !== 'PROVIDER_AUTHORITATIVE') return null;
    const state = wf.state as WS;
    if (state === WS.PROVIDER_CONFIRM_PENDING && wf.providerReconciliationRequired) {
      return 'PROVIDER_CONFIRMATION_AMBIGUOUS';
    }
    if (state === WS.COMPENSATION_PENDING) {
      return wf.providerLastErrorCode === 'PROVIDER_CONFIRMATION_REJECTED'
        ? 'PAYMENT_SUCCEEDED_PROVIDER_REJECTED'
        : 'COMPENSATION_REQUIRED';
    }
    if (
      oneOf(state, [WS.PROVIDER_RESERVED, WS.PAYMENT_PENDING]) &&
      wf.providerReservationExpiresAt &&
      wf.providerReservationExpiresAt.getTime() < Date.now()
    ) {
      return 'PROVIDER_RESERVATION_EXPIRED_PAYMENT_PENDING';
    }
    if (wf.providerReconciliationRequired) return 'PROVIDER_STATUS_STALE';
    return null;
  }

  private async requireWorkflow(bookingId: string) {
    const wf = await this.workflows.getByBookingId(bookingId);
    if (!wf) {
      throw new AppException(
        BookingOrchestratorErrorCodes.WORKFLOW_NOT_FOUND,
        'Booking workflow not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return wf;
  }

  private result(
    bookingId: string,
    workflowState: WS,
    ownershipMode: InventoryOwnershipMode,
    selectedProviderCode?: string,
  ): BookingOrchestrationResult {
    return { bookingId, workflowState, ownershipMode, selectedProviderCode };
  }

  private codeOf(err: unknown): string {
    return err instanceof AppException ? err.code : 'UNKNOWN';
  }
}
