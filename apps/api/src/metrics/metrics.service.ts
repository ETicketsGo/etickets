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

  /** Metrics must never break a request or a business flow. Swallow everything. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* metrics are best-effort */
    }
  }
}
