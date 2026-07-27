import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

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

  /** Metrics must never break a request or a business flow. Swallow everything. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* metrics are best-effort */
    }
  }
}
