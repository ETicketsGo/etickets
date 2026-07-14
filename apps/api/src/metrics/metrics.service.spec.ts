import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('exposes metrics() text including every custom metric name + default process metrics', async () => {
    const m = new MetricsService();
    m.recordBookingCreated();
    m.recordBookingConfirmed();
    m.recordRefundCompleted();
    m.recordCheckin();
    m.recordPaymentFailed();
    m.observeHttp('GET', 200, 0.01);

    const text = await m.metrics();
    for (const name of [
      'etg_bookings_created_total',
      'etg_bookings_confirmed_total',
      'etg_refunds_completed_total',
      'etg_checkins_total',
      'etg_payments_failed_total',
      'etg_http_requests_total',
      'etg_http_request_duration_seconds',
    ]) {
      expect(text).toContain(name);
    }
    // collectDefaultMetrics registered process metrics on the same registry.
    expect(text).toContain('process_cpu_user_seconds_total');
  });

  it('increments a domain counter and reflects the value in the exposition', async () => {
    const m = new MetricsService();
    m.recordBookingCreated();
    m.recordBookingCreated();
    const text = await m.metrics();
    expect(text).toMatch(/etg_bookings_created_total 2/);
  });

  it('labels http metrics by method and status class', async () => {
    const m = new MetricsService();
    m.observeHttp('POST', 503, 0.2);
    const text = await m.metrics();
    expect(text).toMatch(/etg_http_requests_total\{method="POST",status_class="5xx"\} 1/);
    expect(text).toContain('etg_http_request_duration_seconds_bucket');
  });

  it('reports the Prometheus exposition content type', () => {
    const m = new MetricsService();
    expect(m.contentType).toContain('text/plain');
  });

  it('never throws from record helpers', () => {
    const m = new MetricsService();
    expect(() => {
      m.recordBookingCreated();
      m.recordBookingConfirmed();
      m.recordRefundCompleted();
      m.recordCheckin();
      m.recordPaymentFailed();
      m.observeHttp('GET', 200, 0.01);
    }).not.toThrow();
  });
});
