import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Owns a private Prometheus registry (default process metrics + ETicketsGo
 * domain/HTTP metrics). All record helpers are side-effect-free w.r.t. business
 * logic: they never throw, so a metrics failure can never break a request or a
 * domain flow. Using a dedicated registry (rather than the global one) keeps
 * instances isolated, which is what lets tests construct the service freely.
 */
@Injectable()
export class MetricsService {
  readonly registry: Registry;

  private readonly bookingsCreated: Counter;
  private readonly bookingsConfirmed: Counter;
  private readonly refundsCompleted: Counter;
  private readonly checkins: Counter;
  private readonly paymentsFailed: Counter;
  private readonly paymentsSucceeded: Counter;
  private readonly gmvMinor: Counter;
  private readonly qrCheckinSuccess: Counter;
  private readonly qrCheckinFailure: Counter;
  private readonly httpRequests: Counter<'method' | 'status_class'>;
  private readonly httpDuration: Histogram<'method' | 'status_class'>;
  private readonly dbQueryDuration: Histogram;
  private readonly slowQueries: Counter;
  private readonly paymentWebhooks: Counter<'provider' | 'result'>;
  private readonly paymentReconciliations: Counter<'result'>;
  private readonly domainEventsPublished: Counter<'event_type' | 'result'>;
  private readonly domainEventHandlerDuration: Histogram<'event_type' | 'handler' | 'result'>;
  private readonly inventoryLockOps: Counter<'op' | 'outcome'>;
  private readonly inventoryLockLatency: Histogram<'op'>;
  private readonly inventoryLockContention: Counter<'inventory_type' | 'scope'>;
  private readonly inventoryLockReconcile: Counter<'result'>;
  private readonly syncIngest: Counter<'provider' | 'outcome'>;
  private readonly syncApply: Counter<'provider' | 'outcome'>;
  private readonly syncProcess: Counter<'provider' | 'outcome'>;
  private readonly syncProcessingDuration: Histogram;
  private readonly syncPoll: Counter<'provider' | 'outcome'>;
  private readonly syncReconcile: Counter<'outcome'>;
  private readonly providerHealth: Counter<'provider' | 'state'>;
  private readonly outboxCreated: Counter<'outcome'>;
  private readonly outboxDelivery: Counter<'event_type' | 'outcome'>;
  private readonly outboxHandlerReplay: Counter<'event_type' | 'handler'>;
  private readonly outboxDeliveryLatency: Histogram;
  private readonly outboxPollDuration: Histogram;
  private readonly outboxOps: Counter<'op'>;
  private readonly bookingOrchestration: Counter<'op' | 'outcome'>;
  private readonly bookingOrchestrationDuration: Histogram<'op'>;
  private readonly bookingShadow: Counter<'outcome' | 'provider'>;
  private readonly bookingShadowMismatch: Counter<'category'>;
  private readonly bookingApi: Counter<'op' | 'mode' | 'owner_type'>;
  private readonly bookingOwnerRejection: Counter<'op' | 'reason'>;
  private readonly bookingLegacyFallback: Counter<'op'>;
  private readonly providerBooking: Counter<'op' | 'outcome' | 'provider'>;
  private readonly providerBookingDuration: Histogram<'op' | 'provider'>;
  private readonly allocationValidation: Counter<'outcome' | 'inventory_type'>;
  private readonly compensationPlans: Counter<'classification' | 'disposition'>;
  private readonly compensationOperations: Counter<'type' | 'outcome'>;
  private readonly compensationBacklog: Gauge<'state'>;
  private readonly compensationOldestReadyAge: Gauge<string>;
  private readonly paymentVoid: Counter<'provider' | 'outcome'>;
  private readonly paymentVoidDuration: Histogram<'provider'>;
  private readonly paymentStatusRecovery: Counter<'provider' | 'status'>;
  private readonly paymentRefund: Counter<'provider' | 'outcome'>;
  private readonly paymentRefundDuration: Histogram<'provider'>;
  private readonly refundStatusRecovery: Counter<'provider' | 'status'>;
  private readonly refundPolicyDecision: Counter<'mode' | 'reason'>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });
    this.paymentWebhooks = new Counter({
      name: 'etg_payment_webhooks_total',
      help: 'Payment webhooks received, labelled by provider and result.',
      labelNames: ['provider', 'result'],
      registers: [this.registry],
    });
    this.paymentReconciliations = new Counter({
      name: 'etg_payment_reconciliations_total',
      help: 'Payments checked during reconciliation, labelled by result.',
      labelNames: ['result'],
      registers: [this.registry],
    });

    this.bookingsCreated = new Counter({
      name: 'etg_bookings_created_total',
      help: 'Total bookings created (PENDING_PAYMENT holds successfully placed).',
      registers: [this.registry],
    });
    this.bookingsConfirmed = new Counter({
      name: 'etg_bookings_confirmed_total',
      help: 'Total bookings confirmed after successful payment.',
      registers: [this.registry],
    });
    this.refundsCompleted = new Counter({
      name: 'etg_refunds_completed_total',
      help: 'Total refunds fully processed (approved, money + tickets settled).',
      registers: [this.registry],
    });
    this.checkins = new Counter({
      name: 'etg_checkins_total',
      help: 'Total successful ticket check-ins.',
      registers: [this.registry],
    });
    this.paymentsFailed = new Counter({
      name: 'etg_payments_failed_total',
      help: 'Total payments that failed at the provider webhook.',
      registers: [this.registry],
    });
    this.paymentsSucceeded = new Counter({
      name: 'etg_payments_succeeded_total',
      help: 'Total payments that succeeded at the provider webhook (booking confirmed).',
      registers: [this.registry],
    });
    this.gmvMinor = new Counter({
      name: 'etg_gmv_minor_total',
      help: 'Gross merchandise value in currency minor units (e.g. paise), summed on booking confirm.',
      registers: [this.registry],
    });
    this.qrCheckinSuccess = new Counter({
      name: 'etg_qr_checkin_success_total',
      help: 'Total QR check-in scans that resulted in a successful check-in.',
      registers: [this.registry],
    });
    this.qrCheckinFailure = new Counter({
      name: 'etg_qr_checkin_failure_total',
      help: 'Total QR check-in scans that did NOT succeed (invalid, duplicate, cancelled, wrong session).',
      registers: [this.registry],
    });

    this.httpRequests = new Counter({
      name: 'etg_http_requests_total',
      help: 'Total HTTP requests handled, labelled by method and status class.',
      labelNames: ['method', 'status_class'],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: 'etg_http_request_duration_seconds',
      help: 'HTTP request duration in seconds, labelled by method and status class.',
      labelNames: ['method', 'status_class'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.dbQueryDuration = new Histogram({
      name: 'etg_db_query_duration_seconds',
      help: 'Prisma database query duration in seconds (no query text/params — duration only).',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.slowQueries = new Counter({
      name: 'etg_slow_queries_total',
      help: 'Total Prisma queries whose duration exceeded SLOW_QUERY_MS.',
      registers: [this.registry],
    });

    this.domainEventsPublished = new Counter({
      name: 'etg_domain_events_published_total',
      help: 'Domain events published, by event type and outcome (ADR-038).',
      labelNames: ['event_type', 'result'],
      registers: [this.registry],
    });
    this.domainEventHandlerDuration = new Histogram({
      name: 'etg_domain_event_handler_duration_seconds',
      help: 'Domain event handler execution duration in seconds, by event type, handler and result.',
      labelNames: ['event_type', 'handler', 'result'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });

    this.inventoryLockOps = new Counter({
      name: 'etg_inventory_lock_ops_total',
      help: 'Inventory-lock operations by op (acquire|renew|release|confirm|validate|reconcile|redis) and outcome (ADR-039).',
      labelNames: ['op', 'outcome'],
      registers: [this.registry],
    });
    this.inventoryLockLatency = new Histogram({
      name: 'etg_inventory_lock_op_duration_seconds',
      help: 'Inventory-lock operation duration in seconds, by op.',
      labelNames: ['op'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });
    this.inventoryLockContention = new Counter({
      name: 'etg_inventory_lock_contention_total',
      help: 'Seat/quantity lock contention (conflict/capacity) by inventory type and safe scope id.',
      labelNames: ['inventory_type', 'scope'],
      registers: [this.registry],
    });
    this.inventoryLockReconcile = new Counter({
      name: 'etg_inventory_lock_reconcile_total',
      help: 'Reconciliation outcomes: mismatch | repaired | manual_review.',
      labelNames: ['result'],
      registers: [this.registry],
    });

    // External inventory sync (ADR-040). Labels are LOW-CARDINALITY: provider code +
    // bounded outcome/state — never external/event/seat/customer ids.
    this.syncIngest = new Counter({
      name: 'etg_inventory_sync_ingest_total',
      help: 'Webhook ingestion outcomes (accepted|duplicate|too_large|verify_*) by provider.',
      labelNames: ['provider', 'outcome'],
      registers: [this.registry],
    });
    this.syncApply = new Counter({
      name: 'etg_inventory_sync_apply_total',
      help: 'Canonical-change apply outcomes (applied|stale|ordering_conflict|local_authoritative_ignored|cache_invalidation_failed).',
      labelNames: ['provider', 'outcome'],
      registers: [this.registry],
    });
    this.syncProcess = new Counter({
      name: 'etg_inventory_sync_process_total',
      help: 'Async processing outcomes (processed|fail_*) by provider.',
      labelNames: ['provider', 'outcome'],
      registers: [this.registry],
    });
    this.syncProcessingDuration = new Histogram({
      name: 'etg_inventory_sync_processing_duration_seconds',
      help: 'Async sync-event processing duration in seconds.',
      buckets: [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.syncPoll = new Counter({
      name: 'etg_inventory_sync_poll_total',
      help: 'Polling outcomes (ok|skipped_lease|rate_limited|circuit_open|error) by provider.',
      labelNames: ['provider', 'outcome'],
      registers: [this.registry],
    });
    this.syncReconcile = new Counter({
      name: 'etg_inventory_sync_reconcile_total',
      help: 'Sync reconciliation outcomes (in_sync|mismatch|auto_repaired|manual_review).',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.providerHealth = new Counter({
      name: 'etg_inventory_sync_provider_health_total',
      help: 'Provider health-state transitions by provider and state.',
      labelNames: ['provider', 'state'],
      registers: [this.registry],
    });

    // Transactional outbox (ADR-041). Low-cardinality labels only (bounded event
    // catalogue + handler registry + outcome) — never event/aggregate/booking/user ids.
    this.outboxCreated = new Counter({
      name: 'etg_outbox_created_total',
      help: 'Outbox rows created (outcome: created | duplicate).',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.outboxDelivery = new Counter({
      name: 'etg_outbox_delivery_total',
      help: 'Outbox delivery outcomes by event type (delivered|retryable_failure|dead_lettered|manual_review|claimed|stale_recovered|no_work).',
      labelNames: ['event_type', 'outcome'],
      registers: [this.registry],
    });
    this.outboxHandlerReplay = new Counter({
      name: 'etg_outbox_handler_replay_total',
      help: 'Idempotent handler replays skipped by durable idempotency, by event type + handler.',
      labelNames: ['event_type', 'handler'],
      registers: [this.registry],
    });
    this.outboxDeliveryLatency = new Histogram({
      name: 'etg_outbox_delivery_latency_seconds',
      help: 'Outbox event delivery latency in seconds.',
      buckets: [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.outboxPollDuration = new Histogram({
      name: 'etg_outbox_poll_duration_seconds',
      help: 'Outbox dispatcher poll+batch duration in seconds.',
      buckets: [0.001, 0.01, 0.05, 0.25, 1, 5],
      registers: [this.registry],
    });
    this.outboxOps = new Counter({
      name: 'etg_outbox_ops_total',
      help: 'Outbox operational events (op: stale_recovery | retry | cancel | manual_review | purge).',
      labelNames: ['op'],
      registers: [this.registry],
    });

    // Booking orchestration (ADR-042). Bounded labels only — op + outcome + safe provider
    // code + mismatch category; never booking/user/lock/payment ids.
    this.bookingOrchestration = new Counter({
      name: 'etg_booking_orchestration_total',
      help: 'Booking orchestration operations by op (initiate|begin_payment|confirm|cancel|expire|retry|reconcile) and outcome.',
      labelNames: ['op', 'outcome'],
      registers: [this.registry],
    });
    this.bookingOrchestrationDuration = new Histogram({
      name: 'etg_booking_orchestration_duration_seconds',
      help: 'Booking orchestration op duration in seconds, by op.',
      labelNames: ['op'],
      buckets: [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.bookingShadow = new Counter({
      name: 'etg_booking_shadow_total',
      help: 'Shadow booking observations by outcome and selected provider code.',
      labelNames: ['outcome', 'provider'],
      registers: [this.registry],
    });
    this.bookingShadowMismatch = new Counter({
      name: 'etg_booking_shadow_mismatch_total',
      help: 'Shadow booking divergences by category (ADR-042).',
      labelNames: ['category'],
      registers: [this.registry],
    });
    // Booking API routing (ADR-042 P5.2A). Bounded labels: op, orchestration mode, and a
    // coarse owner type (user|anonymous) — never any id.
    this.bookingApi = new Counter({
      name: 'etg_booking_api_total',
      help: 'Booking API calls by op (initiate|begin_payment|status|cancel), orchestration mode, and owner type.',
      labelNames: ['op', 'mode', 'owner_type'],
      registers: [this.registry],
    });
    this.bookingOwnerRejection = new Counter({
      name: 'etg_booking_owner_rejection_total',
      help: 'Rejected booking operations by op and reason (ownership/idempotency).',
      labelNames: ['op', 'reason'],
      registers: [this.registry],
    });
    this.bookingLegacyFallback = new Counter({
      name: 'etg_booking_legacy_fallback_total',
      help: 'Legacy path selections before any active workflow began, by op (never a mid-flow fallback).',
      labelNames: ['op'],
      registers: [this.registry],
    });
    // Provider-authoritative booking (ADR-042 P5.2B). Bounded labels: op, normalized outcome,
    // and provider code from the registry — never reservation/booking/user/seat ids.
    this.providerBooking = new Counter({
      name: 'etg_provider_booking_total',
      help: 'Provider-authoritative booking ops (reserve|confirm|status_recovery|begin_payment|...) by outcome and provider.',
      labelNames: ['op', 'outcome', 'provider'],
      registers: [this.registry],
    });
    this.providerBookingDuration = new Histogram({
      name: 'etg_provider_booking_duration_seconds',
      help: 'Provider-authoritative booking op latency, by op and provider.',
      labelNames: ['op', 'provider'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.allocationValidation = new Counter({
      name: 'etg_booking_allocation_validation_total',
      help: 'Allocated-inventory boundary validations by outcome and inventory type.',
      labelNames: ['outcome', 'inventory_type'],
      registers: [this.registry],
    });
    // Booking compensation (ADR-043). Bounded labels — classification/type/outcome only,
    // never booking/payment/reservation/user ids.
    this.compensationPlans = new Counter({
      name: 'etg_booking_compensation_plans_total',
      help: 'Compensation plans produced, by classification and disposition (auto|review).',
      labelNames: ['classification', 'disposition'],
      registers: [this.registry],
    });
    this.compensationOperations = new Counter({
      name: 'etg_booking_compensation_operations_total',
      help: 'Compensation action executions by type and outcome.',
      labelNames: ['type', 'outcome'],
      registers: [this.registry],
    });
    this.compensationBacklog = new Gauge({
      name: 'etg_booking_compensation_backlog',
      help: 'Compensation records by state (bounded label; no ids).',
      labelNames: ['state'],
      registers: [this.registry],
    });
    this.compensationOldestReadyAge = new Gauge({
      name: 'etg_booking_compensation_oldest_ready_age_seconds',
      help: 'Age of the oldest READY compensation, in seconds.',
      registers: [this.registry],
    });
    // Payment void (ADR-043 Phase 5). Bounded labels — provider code + normalized outcome/status;
    // never booking/payment/user/idempotency ids.
    this.paymentVoid = new Counter({
      name: 'etg_booking_payment_void_total',
      help: 'Payment void executions by provider and outcome.',
      labelNames: ['provider', 'outcome'],
      registers: [this.registry],
    });
    this.paymentVoidDuration = new Histogram({
      name: 'etg_booking_payment_void_duration_seconds',
      help: 'Payment void execution latency, by provider.',
      labelNames: ['provider'],
      buckets: [0.05, 0.1, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.paymentStatusRecovery = new Counter({
      name: 'etg_booking_payment_status_recovery_total',
      help: 'Payment status-query recoveries by provider and normalized status.',
      labelNames: ['provider', 'status'],
      registers: [this.registry],
    });
    // Payment refund (ADR-043 Phase 6). Bounded labels — provider/outcome/status/policy mode.
    this.paymentRefund = new Counter({
      name: 'etg_booking_payment_refund_total',
      help: 'Payment refund executions by provider and outcome.',
      labelNames: ['provider', 'outcome'],
      registers: [this.registry],
    });
    this.paymentRefundDuration = new Histogram({
      name: 'etg_booking_payment_refund_duration_seconds',
      help: 'Payment refund execution latency, by provider.',
      labelNames: ['provider'],
      buckets: [0.05, 0.1, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.refundStatusRecovery = new Counter({
      name: 'etg_booking_refund_status_recovery_total',
      help: 'Refund status-query recoveries by provider and normalized status.',
      labelNames: ['provider', 'status'],
      registers: [this.registry],
    });
    this.refundPolicyDecision = new Counter({
      name: 'etg_booking_refund_policy_decision_total',
      help: 'Refund policy decisions by mode and reason code.',
      labelNames: ['mode', 'reason'],
      registers: [this.registry],
    });
  }

  /** Prometheus exposition text for the /metrics endpoint. */
  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  /** Content type Prometheus expects for the exposition format. */
  get contentType(): string {
    return this.registry.contentType;
  }

  recordBookingCreated(): void {
    this.safe(() => this.bookingsCreated.inc());
  }

  recordBookingConfirmed(): void {
    this.safe(() => this.bookingsConfirmed.inc());
  }

  recordRefundCompleted(): void {
    this.safe(() => this.refundsCompleted.inc());
  }

  recordCheckin(): void {
    this.safe(() => this.checkins.inc());
  }

  recordPaymentFailed(): void {
    this.safe(() => this.paymentsFailed.inc());
  }

  recordPaymentSucceeded(): void {
    this.safe(() => this.paymentsSucceeded.inc());
  }

  /** Add a booking's total (minor units) to gross merchandise value on confirm. */
  recordGmv(amountMinor: number): void {
    this.safe(() => {
      if (Number.isFinite(amountMinor) && amountMinor > 0) {
        this.gmvMinor.inc(amountMinor);
      }
    });
  }

  /** Record a routed payment webhook (result: verified | rejected | processed | failed). */
  recordPaymentWebhook(provider: string, result: string): void {
    this.safe(() => this.paymentWebhooks.inc({ provider, result }));
  }

  /** Record reconciliation outcomes for a run (matched, mismatched, unverifiable counts). */
  recordReconciliation(matched: number, mismatched: number, unverifiable: number): void {
    this.safe(() => {
      if (matched > 0) this.paymentReconciliations.inc({ result: 'matched' }, matched);
      if (mismatched > 0) this.paymentReconciliations.inc({ result: 'mismatched' }, mismatched);
      if (unverifiable > 0)
        this.paymentReconciliations.inc({ result: 'unverifiable' }, unverifiable);
    });
  }

  /** Record a QR check-in scan result: success bumps success, anything else failure. */
  recordQrCheckin(success: boolean): void {
    this.safe(() => (success ? this.qrCheckinSuccess.inc() : this.qrCheckinFailure.inc()));
  }

  /**
   * Record one Prisma query's duration (seconds). Always observes the histogram;
   * when over the slow threshold it also bumps the slow-query counter.
   */
  observeDbQuery(durationSeconds: number, slow: boolean): void {
    this.safe(() => {
      this.dbQueryDuration.observe(durationSeconds);
      if (slow) this.slowQueries.inc();
    });
  }

  /** Record one finished HTTP request (counter + duration histogram). */
  observeHttp(method: string, status: number, durationSeconds: number): void {
    this.safe(() => {
      const labels = { method, status_class: `${Math.floor(status / 100)}xx` };
      this.httpRequests.inc(labels);
      this.httpDuration.observe(labels, durationSeconds);
    });
  }

  /**
   * Record a domain event publication outcome (ADR-038). `result` is one of
   * ok | no_handler | disabled | invalid — never any event payload/PII.
   */
  recordDomainEventPublished(eventType: string, result: string): void {
    this.safe(() => this.domainEventsPublished.inc({ event_type: eventType, result }));
  }

  /** Record one domain event handler run: duration (seconds) + result (ok|error|skipped). */
  recordDomainEventHandler(
    eventType: string,
    handler: string,
    result: string,
    durationSeconds: number,
  ): void {
    this.safe(() =>
      this.domainEventHandlerDuration.observe(
        { event_type: eventType, handler, result },
        durationSeconds,
      ),
    );
  }

  /** Record one inventory-lock operation outcome (ADR-039). Labels are PII-free. */
  recordInventoryLockOp(op: string, outcome: string): void {
    this.safe(() => this.inventoryLockOps.inc({ op, outcome }));
  }

  /** Record inventory-lock operation latency (seconds), by op. */
  observeInventoryLockLatency(op: string, durationSeconds: number): void {
    this.safe(() => this.inventoryLockLatency.observe({ op }, durationSeconds));
  }

  /** Record lock contention (conflict/capacity) for a safe inventory scope id. */
  recordInventoryLockContention(inventoryType: string, scope: string): void {
    this.safe(() => this.inventoryLockContention.inc({ inventory_type: inventoryType, scope }));
  }

  /** Record a reconciliation outcome: mismatch | repaired | manual_review. */
  recordInventoryLockReconcile(result: string, count = 1): void {
    this.safe(() => {
      if (count > 0) this.inventoryLockReconcile.inc({ result }, count);
    });
  }

  // ─── External inventory sync (ADR-040) — all labels PII-free + low-cardinality ───
  recordSyncIngest(provider: string, outcome: string): void {
    this.safe(() => this.syncIngest.inc({ provider, outcome }));
  }
  recordSyncApply(provider: string, outcome: string): void {
    this.safe(() => this.syncApply.inc({ provider, outcome }));
  }
  recordSyncProcess(provider: string, outcome: string): void {
    this.safe(() => this.syncProcess.inc({ provider, outcome }));
  }
  observeSyncProcessing(durationSeconds: number): void {
    this.safe(() => this.syncProcessingDuration.observe(durationSeconds));
  }
  recordSyncPoll(provider: string, outcome: string): void {
    this.safe(() => this.syncPoll.inc({ provider, outcome }));
  }
  recordSyncReconcile(outcome: string, count = 1): void {
    this.safe(() => {
      if (count > 0) this.syncReconcile.inc({ outcome }, count);
    });
  }
  recordProviderHealth(provider: string, state: string): void {
    this.safe(() => this.providerHealth.inc({ provider, state }));
  }

  // ─── Transactional outbox (ADR-041) ───
  recordOutboxCreated(count: number): void {
    this.safe(() => count > 0 && this.outboxCreated.inc({ outcome: 'created' }, count));
  }
  recordOutboxDuplicateInsert(count: number): void {
    this.safe(() => count > 0 && this.outboxCreated.inc({ outcome: 'duplicate' }, count));
  }
  recordOutboxClaimed(count: number): void {
    this.safe(
      () =>
        count > 0 && this.outboxDelivery.inc({ event_type: '_batch', outcome: 'claimed' }, count),
    );
  }
  recordOutboxDelivery(eventType: string, outcome: string): void {
    this.safe(() => this.outboxDelivery.inc({ event_type: eventType, outcome }));
  }
  recordOutboxHandlerReplay(eventType: string, handler: string): void {
    this.safe(() => this.outboxHandlerReplay.inc({ event_type: eventType, handler }));
  }
  observeOutboxDeliveryLatency(seconds: number): void {
    this.safe(() => this.outboxDeliveryLatency.observe(seconds));
  }
  observeOutboxPoll(seconds: number): void {
    this.safe(() => this.outboxPollDuration.observe(seconds));
  }
  recordOutboxNoWorkPoll(): void {
    this.safe(() => this.outboxDelivery.inc({ event_type: '_batch', outcome: 'no_work' }));
  }
  recordOutboxStaleRecovery(count: number): void {
    this.safe(() => count > 0 && this.outboxOps.inc({ op: 'stale_recovery' }, count));
  }
  recordOutboxOp(op: string, count = 1): void {
    this.safe(() => count > 0 && this.outboxOps.inc({ op }, count));
  }

  // ─── Booking orchestration (ADR-042) ───
  recordBookingOrchestration(op: string, outcome: string): void {
    this.safe(() => this.bookingOrchestration.inc({ op, outcome }));
  }
  observeBookingOrchestration(op: string, seconds: number): void {
    this.safe(() => this.bookingOrchestrationDuration.observe({ op }, seconds));
  }
  recordBookingShadow(outcome: string, provider: string): void {
    this.safe(() => this.bookingShadow.inc({ outcome, provider }));
  }
  recordBookingShadowMismatch(category: string): void {
    this.safe(() => this.bookingShadowMismatch.inc({ category }));
  }
  recordBookingApi(op: string, mode: string, ownerType: string): void {
    this.safe(() => this.bookingApi.inc({ op, mode, owner_type: ownerType }));
  }
  recordBookingOwnerRejection(op: string, reason: string): void {
    this.safe(() => this.bookingOwnerRejection.inc({ op, reason }));
  }
  recordBookingLegacyFallback(op: string): void {
    this.safe(() => this.bookingLegacyFallback.inc({ op }));
  }
  recordProviderBooking(op: string, outcome: string, provider: string): void {
    this.safe(() => this.providerBooking.inc({ op, outcome, provider }));
  }
  observeProviderBooking(op: string, seconds: number, provider: string): void {
    this.safe(() => this.providerBookingDuration.observe({ op, provider }, seconds));
  }
  recordAllocationValidation(outcome: string, inventoryType: string): void {
    this.safe(() => this.allocationValidation.inc({ outcome, inventory_type: inventoryType }));
  }
  recordCompensationPlan(classification: string, disposition: string): void {
    this.safe(() => this.compensationPlans.inc({ classification, disposition }));
  }
  recordCompensationOperation(type: string, outcome: string): void {
    this.safe(() => this.compensationOperations.inc({ type, outcome }));
  }
  setCompensationBacklog(state: string, n: number): void {
    this.safe(() => this.compensationBacklog.set({ state }, n));
  }
  setCompensationOldestReadyAge(seconds: number): void {
    this.safe(() => this.compensationOldestReadyAge.set(seconds));
  }
  recordPaymentVoid(provider: string, outcome: string): void {
    this.safe(() => this.paymentVoid.inc({ provider, outcome }));
  }
  observePaymentVoid(provider: string, seconds: number): void {
    this.safe(() => this.paymentVoidDuration.observe({ provider }, seconds));
  }
  recordPaymentStatusRecovery(provider: string, status: string): void {
    this.safe(() => this.paymentStatusRecovery.inc({ provider, status }));
  }
  recordPaymentRefund(provider: string, outcome: string): void {
    this.safe(() => this.paymentRefund.inc({ provider, outcome }));
  }
  observePaymentRefund(provider: string, seconds: number): void {
    this.safe(() => this.paymentRefundDuration.observe({ provider }, seconds));
  }
  recordRefundStatusRecovery(provider: string, status: string): void {
    this.safe(() => this.refundStatusRecovery.inc({ provider, status }));
  }
  recordRefundPolicyDecision(mode: string, reason: string): void {
    this.safe(() => this.refundPolicyDecision.inc({ mode, reason }));
  }

  /** Metrics must never break a request or a business flow. Swallow everything. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* metrics are best-effort */
    }
  }
}
