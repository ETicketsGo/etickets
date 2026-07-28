import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BookingWorkflow } from '@prisma/client';
import { AppException, ErrorCodes } from '../../common/errors';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestUser } from '../../common/decorators';
import { BookingsService } from '../bookings.service';
import { PaymentsService } from '../../payments/payments.service';
import { InventoryLockService } from '../../inventory/locking/inventory-lock.service';
import { BookingWorkflowRepository } from './booking-workflow.repository';
import { BookingOwnerResolver } from './booking-owner';
import {
  BookingConfirmationBridge,
  type PreConfirmResult,
  type VerifiedPaymentFact,
} from './booking-confirmation-bridge';
import { BookingWorkflowState as WS } from './booking-workflow-state';
import { toPublicBookingStatus } from './booking-status.mapping';
import {
  ExternalBookingProviderRegistry,
  selectProviderSequence,
} from '../providers/external-booking-provider.registry';
import {
  ExternalBookingException,
  ExternalBookingFailure,
} from '../providers/external-booking.errors';
import type { ExternalBookingProvider } from '../providers/external-booking-provider.interface';
import type {
  BookingOrchestrationResult,
  BookingPaymentResult,
  InitiateBookingRequest,
  BeginBookingPaymentRequest,
} from './booking-orchestrator.contract';

const oneOf = (state: WS, states: readonly WS[]): boolean => states.includes(state);

/**
 * Provider-authoritative booking flow (ADR-042 §5–§14, P5.2B Slice 3). The EXTERNAL provider
 * owns final inventory truth: a local PostgreSQL hold is coordination-only, and the booking
 * can only become CONFIRMED after the provider confirms. Composes the existing seams — the
 * external booking provider (reserve/confirm/status), Redis lock, BookingsService (local
 * coordination hold), PaymentsService (payment + the SAME atomic local confirm), the workflow
 * repository, and P4 ProviderMapping — without duplicating any of them. Entirely gated behind
 * `BOOKING_PROVIDER_CONFIRMATION_ENABLED`; unsupported when off, with no fake success.
 *
 * Sequence: DRAFT→INVENTORY_RESOLVED→LOCK_PENDING→LOCKED→PROVIDER_RESERVATION_PENDING→
 * PROVIDER_RESERVED (initiate) → PAYMENT_PENDING (beginPayment) → PAYMENT_AUTHORIZED→
 * PROVIDER_CONFIRM_PENDING→PROVIDER_CONFIRMED→CONFIRMING→CONFIRMED (on verified payment).
 */
@Injectable()
export class ProviderAuthoritativeStrategy implements OnModuleInit {
  private readonly logger = new Logger('ProviderAuthoritativeBooking');

  constructor(
    private readonly registry: ExternalBookingProviderRegistry,
    private readonly locks: InventoryLockService,
    private readonly bookings: BookingsService,
    private readonly payments: PaymentsService,
    private readonly workflows: BookingWorkflowRepository,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly owners: BookingOwnerResolver,
    private readonly bridge: BookingConfirmationBridge,
  ) {}

  onModuleInit(): void {
    // Own confirmation for provider-authoritative bookings (provider-confirm before local).
    this.bridge.registerPreConfirm((fact) => this.handlePaymentConfirmed(fact));
  }

  get enabled(): boolean {
    return this.config.get<boolean>('BOOKING_PROVIDER_CONFIRMATION_ENABLED') === true;
  }

  private get ttlSafetySeconds(): number {
    return this.config.get<number>('BOOKING_PROVIDER_RESERVATION_TTL_SAFETY_SECONDS') ?? 60;
  }

  private get activeLocks(): boolean {
    return (
      this.config.get<boolean>('INVENTORY_LOCKS_ENABLED') === true &&
      this.config.get<string>('INVENTORY_LOCKS_MODE') === 'active'
    );
  }

  /** Resolve the external booking provider for a session via its P4 ProviderMapping. */
  private async resolveProvider(eventId: string): Promise<{
    provider: ExternalBookingProvider;
    providerInventoryRef: string;
    providerCode: string;
  }> {
    const mapping = await this.prisma.providerMapping.findFirst({
      where: { internalEntityType: 'event', internalEntityId: eventId, status: 'ACTIVE' },
    });
    if (!mapping) {
      throw new ExternalBookingException(ExternalBookingFailure.PROVIDER_MAPPING_MISSING, {
        eventId,
      });
    }
    const provider = this.registry.require(mapping.providerCode); // throws PROVIDER_MAPPING_MISSING if unregistered
    const health = await provider.health().catch(() => ({ healthy: false }));
    if (!health.healthy) {
      throw new ExternalBookingException(ExternalBookingFailure.PROVIDER_TEMPORARILY_UNAVAILABLE, {
        provider: mapping.providerCode,
      });
    }
    return {
      provider,
      providerInventoryRef: mapping.externalEntityId,
      providerCode: mapping.providerCode,
    };
  }

  async initiate(
    request: InitiateBookingRequest,
    session: { id: string; eventId: string; organizationId: string | null },
  ): Promise<BookingOrchestrationResult> {
    const started = Date.now();
    if (!this.enabled) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Provider-authoritative booking is not enabled.',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
    const { provider, providerInventoryRef, providerCode } = await this.resolveProvider(
      session.eventId,
    );
    // Capability-driven sequencing — fails BEFORE any payment for unsupported providers.
    selectProviderSequence(provider.capabilities());

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
      inventoryOwnershipMode: 'PROVIDER_AUTHORITATIVE',
      selectedProviderCode: providerCode,
      ownerType: request.requestOwner?.ownerType,
      ownerId: request.requestOwner?.ownerId,
      tenantId: request.tenantId ?? session.organizationId ?? undefined,
      organizerId: request.organizerId ?? session.organizationId ?? undefined,
    });
    if (!created && request.requestOwner) this.owners.assertOwner(workflow, request.requestOwner);
    if (!created && !workflow.bookingId.startsWith('pending-')) {
      // Idempotent replay — same booking + same provider reservation.
      this.metrics.recordProviderBooking('initiate', 'replay', providerCode);
      return this.result(workflow.bookingId, workflow.state as WS, providerCode);
    }

    let current = (await this.workflows.advance(workflow, WS.INVENTORY_RESOLVED)).workflow;
    current = (await this.workflows.advance(current, WS.LOCK_PENDING)).workflow;

    // ETicketsGo coordination lock (active mode): prevents duplicate local checkout attempts
    // for the same mapped units. Provider truth remains authoritative.
    const seatIds = request.items.flatMap((i) => i.seatIds ?? []);
    const owner = {
      ownerId: request.owner.ownerId,
      anonymousSessionId: request.owner.anonymousSessionId,
    };
    let lockId: string | undefined;
    let fencingToken: number | undefined;
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

    // Local coordination hold (NOT provider confirmation, NOT authoritative sale).
    let booking: { id: string; totalMinor?: number; currency?: string };
    try {
      const user: RequestUser | null = request.owner.ownerId
        ? ({ id: request.owner.ownerId } as RequestUser)
        : null;
      booking = (await this.bookings.create(
        user,
        {
          eventSessionId: request.eventSessionId,
          items: request.items,
          buyerName: request.buyerName ?? '',
          buyerEmail: request.buyerEmail ?? '',
          couponCode: request.couponCode,
        } as never,
        request.idempotencyKey,
      )) as { id: string; totalMinor?: number; currency?: string };
    } catch (err) {
      await this.releaseLock(lockId, owner, fencingToken, workflow.id);
      await this.workflows
        .advance(current, WS.FAILED, { lastErrorCode: this.codeOf(err) })
        .catch(() => undefined);
      throw err;
    }
    await this.workflows.attachBooking(current.id, { bookingId: booking.id, lockId, fencingToken });
    current = (await this.workflows.get(current.id))!;
    current = (await this.workflows.advance(current, WS.PROVIDER_RESERVATION_PENDING)).workflow;

    // External reservation (idempotent). Persist the request key BEFORE reading the result so
    // an ambiguous/lost response is recoverable by key.
    const reserveKey = `wf:${workflow.id}:reserve`;
    await this.workflows.advance(current, current.state as WS, {
      providerRequestIdempotencyKey: reserveKey,
      providerLastAttemptAt: new Date(),
      providerAttemptCount: { increment: 1 },
    });
    const expectedAmountMinor = booking.totalMinor;
    const reservation = await provider.createReservation({
      providerInventoryRef,
      selection:
        seatIds.length > 0
          ? { inventoryType: 'SEAT', seatRefs: seatIds }
          : {
              inventoryType: 'QUANTITY',
              quantity: request.items.reduce((s, i) => s + i.quantity, 0),
            },
      idempotencyKey: reserveKey,
      expectedAmountMinor,
      currency: booking.currency,
      correlationId: request.correlationId,
    });
    this.metrics.recordProviderBooking('reserve', reservation.outcome.toLowerCase(), providerCode);

    if (reservation.outcome === 'SOLD_OUT' || reservation.outcome === 'REJECTED') {
      await this.releaseLock(lockId, owner, fencingToken, workflow.id);
      await this.bookings.releaseExpiredHolds(request.eventSessionId).catch(() => undefined);
      await this.workflows
        .advance(current, WS.FAILED, {
          providerStatus: reservation.outcome,
          providerLastErrorCode: reservation.outcome,
        })
        .catch(() => undefined);
      throw new ExternalBookingException(
        reservation.outcome === 'SOLD_OUT'
          ? ExternalBookingFailure.PROVIDER_SOLD_OUT
          : ExternalBookingFailure.PROVIDER_RESERVATION_REJECTED,
      );
    }
    if (reservation.outcome === 'AMBIGUOUS' || reservation.outcome === 'RETRYABLE') {
      // Do NOT fail — reservation state is unknown; flag for recovery and keep the workflow
      // in PROVIDER_RESERVATION_PENDING. The booking stays pending to the customer.
      await this.workflows.advance(current, current.state as WS, {
        providerReconciliationRequired: true,
        providerLastResponseCategory: reservation.outcome,
      });
      this.metrics.recordProviderBooking('reserve', 'ambiguous', providerCode);
      return this.result(booking.id, WS.PROVIDER_RESERVATION_PENDING, providerCode);
    }

    // Reserved.
    current = (
      await this.workflows.advance(current, WS.PROVIDER_RESERVED, {
        providerReservationId: reservation.providerReservationId ?? null,
        providerReservationExpiresAt: reservation.reservationExpiresAt ?? null,
        providerStatus: 'RESERVED',
        providerReconciliationRequired: false,
      })
    ).workflow;
    this.metrics.observeProviderBooking('reserve', (Date.now() - started) / 1000, providerCode);
    return this.result(booking.id, current.state as WS, providerCode);
  }

  async beginPayment(
    request: BeginBookingPaymentRequest,
    workflow: BookingWorkflow,
  ): Promise<BookingPaymentResult> {
    if (request.requestOwner) this.owners.assertOwner(workflow, request.requestOwner);
    if (!oneOf(workflow.state as WS, [WS.PROVIDER_RESERVED, WS.PAYMENT_PENDING])) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This booking is not ready for payment.',
        HttpStatus.CONFLICT,
        { state: workflow.state },
      );
    }
    // Reservation TTL safety: never collect payment against a near-expired reservation.
    const expiry = workflow.providerReservationExpiresAt;
    if (expiry) {
      const remainingS = (expiry.getTime() - Date.now()) / 1000;
      if (remainingS < this.ttlSafetySeconds) {
        // The mock provider does not support renewal → require a fresh attempt.
        this.metrics.recordProviderBooking(
          'begin_payment',
          'reservation_expired',
          workflow.selectedProviderCode ?? 'unknown',
        );
        throw new ExternalBookingException(ExternalBookingFailure.PROVIDER_RESERVATION_EXPIRED, {
          remainingSeconds: Math.floor(remainingS),
        });
      }
    }
    // Server-authoritative amount from the booking; a provider price change is refused, not charged.
    const booking = await this.prisma.booking.findUnique({
      where: { id: request.bookingId },
      select: { totalMinor: true, currency: true },
    });
    if (!booking)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);

    const user: RequestUser | undefined = request.owner.ownerId
      ? ({ id: request.owner.ownerId } as RequestUser)
      : undefined;
    const payment = await this.payments.createIntent(request.bookingId, user);
    const pp = (payment as { provider?: unknown }).provider;
    if (workflow.state === WS.PROVIDER_RESERVED) {
      await this.workflows.advance(workflow, WS.PAYMENT_PENDING, {
        paymentProvider: typeof pp === 'string' ? pp : null,
      });
    }
    this.metrics.recordProviderBooking(
      'begin_payment',
      'ok',
      workflow.selectedProviderCode ?? 'unknown',
    );
    const after = (await this.workflows.get(workflow.id))!;
    return { bookingId: request.bookingId, workflowState: after.state as WS, payment };
  }

  /**
   * Pre-confirmation hook (ADR-042 §10). Owns confirmation for PROVIDER_AUTHORITATIVE
   * bookings: provider-confirm BEFORE the atomic local confirm. Declines (handled:false) for
   * local/allocated bookings so the standard path is unchanged.
   */
  async handlePaymentConfirmed(fact: VerifiedPaymentFact): Promise<PreConfirmResult> {
    if (!this.enabled) return { handled: false };
    const workflow = await this.workflows.getByBookingId(fact.bookingId).catch(() => null);
    if (!workflow || workflow.inventoryOwnershipMode !== 'PROVIDER_AUTHORITATIVE') {
      return { handled: false };
    }
    const providerCode = workflow.selectedProviderCode ?? 'unknown';
    const provider = this.registry.get(providerCode);
    if (!provider || !workflow.providerReservationId) {
      // Cannot confirm with the provider → do NOT confirm locally; flag for reconciliation.
      await this.markReconcile(workflow, 'PROVIDER_UNAVAILABLE_AT_CONFIRM');
      return { handled: true, result: { status: 'pending', bookingId: fact.bookingId } };
    }
    const reservationId: string = workflow.providerReservationId;
    // Advance to PROVIDER_CONFIRM_PENDING (through PAYMENT_AUTHORIZED) idempotently.
    let w = workflow;
    if (w.state === WS.PAYMENT_PENDING)
      w = (await this.workflows.advance(w, WS.PAYMENT_AUTHORIZED)).workflow;
    if (w.state === WS.PAYMENT_AUTHORIZED)
      w = (await this.workflows.advance(w, WS.PROVIDER_CONFIRM_PENDING)).workflow;

    const confirmKey = `wf:${w.id}:confirm`;
    const confirmation = await provider.confirmReservation({
      providerReservationId: reservationId,
      idempotencyKey: confirmKey,
      correlationId: w.correlationId ?? undefined,
    });
    this.metrics.recordProviderBooking('confirm', confirmation.outcome.toLowerCase(), providerCode);

    if (confirmation.outcome === 'OK') {
      w = (
        await this.workflows.advance(w, WS.PROVIDER_CONFIRMED, {
          providerBookingId: confirmation.providerBookingId ?? null,
          providerStatus: 'CONFIRMED',
          providerConfirmedAt: new Date(),
          providerReconciliationRequired: false,
        })
      ).workflow;
      // Provider confirmed → run the SAME atomic local confirm (inventory + booking + outbox).
      const local = await this.payments.confirmVerifiedLocal({
        type: 'payment.succeeded',
        providerRef: fact.providerRef,
        bookingId: fact.bookingId,
        amountMinor: fact.amountMinor,
      });
      const localOk =
        (local as { status?: string }).status === 'confirmed' ||
        (local as { status?: string }).status === 'already_confirmed';
      if (localOk) {
        if (w.state === WS.PROVIDER_CONFIRMED)
          w = (await this.workflows.advance(w, WS.CONFIRMING)).workflow;
        if (w.state === WS.CONFIRMING) w = (await this.workflows.advance(w, WS.CONFIRMED)).workflow;
        await this.finalizeLock(w, fact.bookingId);
      } else {
        // Provider confirmed but local confirmation failed → manual review, keep evidence.
        await this.markReconcile(
          w,
          ExternalBookingFailure.LOCAL_CONFIRMATION_FAILED_AFTER_PROVIDER_CONFIRM,
          WS.MANUAL_REVIEW,
        );
      }
      return { handled: true, result: local };
    }
    if (
      confirmation.outcome === 'AMBIGUOUS' ||
      confirmation.outcome === 'RETRYABLE' ||
      confirmation.outcome === 'NOT_FOUND'
    ) {
      // Payment succeeded but provider confirmation is unknown — never confirm/fail; recover.
      await this.markReconcile(w, ExternalBookingFailure.PROVIDER_CONFIRMATION_AMBIGUOUS);
      this.metrics.recordProviderBooking('confirm', 'ambiguous', providerCode);
      return { handled: true, result: { status: 'pending', bookingId: fact.bookingId } };
    }
    // REJECTED / SOLD_OUT / EXPIRED after payment → compensation required (P5.3 owns refund).
    await this.markReconcile(
      w,
      ExternalBookingFailure.PROVIDER_CONFIRMATION_REJECTED,
      WS.COMPENSATION_PENDING,
    );
    return { handled: true, result: { status: 'pending', bookingId: fact.bookingId } };
  }

  /**
   * Durable status recovery for an ambiguous provider outcome (ADR-042 §12). Idempotent;
   * queries the provider by reservation reference and resolves the workflow safely. Gated by
   * BOOKING_PROVIDER_STATUS_RECOVERY_ENABLED. Returns the classification acted on.
   */
  async recoverStatus(bookingId: string): Promise<{ classification: string }> {
    if (this.config.get<boolean>('BOOKING_PROVIDER_STATUS_RECOVERY_ENABLED') !== true) {
      return { classification: 'DISABLED' };
    }
    const w = await this.workflows.getByBookingId(bookingId);
    if (!w || w.inventoryOwnershipMode !== 'PROVIDER_AUTHORITATIVE')
      return { classification: 'NOT_APPLICABLE' };
    const provider = this.registry.get(w.selectedProviderCode ?? '');
    if (!provider || !w.providerReservationId)
      return { classification: 'PROVIDER_MAPPING_MISSING' };
    const status = await provider.getBookingStatus({
      providerReservationId: w.providerReservationId,
      providerBookingId: w.providerBookingId ?? undefined,
      idempotencyKey: `wf:${w.id}:status`,
      correlationId: w.correlationId ?? undefined,
    });
    this.metrics.recordProviderBooking(
      'status_recovery',
      status.status.toLowerCase(),
      w.selectedProviderCode ?? 'unknown',
    );
    if (status.status === 'CONFIRMED') {
      // Drive the same confirmation completion the callback would have.
      await this.handlePaymentConfirmed({
        bookingId,
        providerRef: `recovered:${w.id}`,
        amountMinor: 0,
      }).catch(() => undefined);
      return { classification: 'PROVIDER_CONFIRMED_LOCAL_PENDING' };
    }
    if (status.status === 'REJECTED') {
      await this.markReconcile(
        w,
        ExternalBookingFailure.PROVIDER_CONFIRMATION_REJECTED,
        WS.COMPENSATION_PENDING,
      );
      return { classification: 'PAYMENT_SUCCEEDED_PROVIDER_REJECTED' };
    }
    if (status.status === 'EXPIRED') {
      await this.markReconcile(
        w,
        ExternalBookingFailure.PROVIDER_RESERVATION_EXPIRED,
        WS.COMPENSATION_PENDING,
      );
      return { classification: 'PROVIDER_RESERVATION_EXPIRED_PAYMENT_PENDING' };
    }
    if (status.status === 'UNKNOWN') return { classification: 'MANUAL_REVIEW_REQUIRED' };
    return { classification: 'PROVIDER_STATUS_STALE' };
  }

  /** Safe public status for a provider-authoritative workflow (never CONFIRMED until local commit). */
  publicStatus(state: WS): string {
    return toPublicBookingStatus(state);
  }

  // ── helpers ──

  private async markReconcile(
    workflow: BookingWorkflow,
    code: string,
    nextState?: WS,
  ): Promise<void> {
    const patch = {
      providerReconciliationRequired: true,
      providerLastErrorCode: code,
      manualReviewReason: code,
    };
    if (nextState && nextState !== (workflow.state as WS)) {
      await this.workflows.advance(workflow, nextState, patch).catch(() => undefined);
    } else {
      await this.workflows.advance(workflow, workflow.state as WS, patch).catch(() => undefined);
    }
    this.metrics.recordProviderBooking(
      'reconcile_flag',
      code.toLowerCase().slice(0, 40),
      workflow.selectedProviderCode ?? 'unknown',
    );
  }

  private async finalizeLock(workflow: BookingWorkflow, bookingId: string): Promise<void> {
    if (!workflow.lockId) return;
    const raw = await this.locks.getRaw(workflow.lockId).catch(() => null);
    if (raw) {
      await this.locks.markInternal(raw, 'CONFIRMED').catch(() => {
        this.metrics.recordProviderBooking(
          'confirm',
          'redis_cleanup_failed',
          workflow.selectedProviderCode ?? 'unknown',
        );
        this.logger.error(
          `Redis finalize failed after provider confirm for booking=${bookingId}; reconcile`,
        );
      });
    }
  }

  private async releaseLock(
    lockId: string | undefined,
    owner: { ownerId?: string; anonymousSessionId?: string },
    fencingToken: number | undefined,
    wfId: string,
  ): Promise<void> {
    if (!lockId) return;
    await this.locks
      .release({ lockId, owner, fencingToken })
      .catch(() => this.logger.error(`lock release failed for wf=${wfId}`));
  }

  private result(
    bookingId: string,
    workflowState: WS,
    providerCode: string,
  ): BookingOrchestrationResult {
    return {
      bookingId,
      workflowState,
      ownershipMode: 'PROVIDER_AUTHORITATIVE',
      selectedProviderCode: providerCode,
    };
  }

  private codeOf(err: unknown): string {
    return err instanceof AppException ? err.code : 'UNKNOWN';
  }
}
