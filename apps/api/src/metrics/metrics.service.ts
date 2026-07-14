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
  private readonly httpRequests: Counter<'method' | 'status_class'>;
  private readonly httpDuration: Histogram<'method' | 'status_class'>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

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
