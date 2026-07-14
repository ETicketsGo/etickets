import { Logger } from '@nestjs/common';

const logger = new Logger('Tracing');
let started = false;

/**
 * Optional OpenTelemetry tracing — a complete no-op unless
 * OTEL_EXPORTER_OTLP_ENDPOINT is set. When set, we lazily load the OTel SDK and
 * start it; the OTel packages are an OPTIONAL dependency, so if they are not
 * installed we log once and continue (the app is never destabilised for tracing).
 *
 * To activate, set the endpoint AND install the collector packages:
 *   npm i -w @eticketsgo/api @opentelemetry/sdk-node \
 *     @opentelemetry/auto-instrumentations-node \
 *     @opentelemetry/exporter-trace-otlp-http
 *
 * Env:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  e.g. http://localhost:4318
 *   OTEL_SERVICE_NAME            defaults to "eticketsgo-api"
 *
 * Auto-instrumentations cover HTTP/Express/Nest, Prisma, IORedis and BullMQ, so
 * the booking→payment→confirm→ticket path and worker jobs are traced end-to-end.
 * Must be called as early as possible (before other modules load) to patch libs.
 */
export function startTracing(): boolean {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || started) return started;
  try {
    // Lazy, guarded require — avoids a hard dependency on the OTel packages.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

    const sdk = new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'eticketsgo-api',
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
      instrumentations: [getNodeAutoInstrumentations()],
    });
    sdk.start();
    started = true;
    logger.log(`OpenTelemetry tracing started → ${endpoint}`);
    const shutdown = () => sdk.shutdown().catch(() => undefined);
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (err) {
    // TODO(tracing): install the @opentelemetry/* packages listed above to enable.
    logger.warn(
      `OTEL_EXPORTER_OTLP_ENDPOINT is set but tracing could not start ` +
        `(are the @opentelemetry/* packages installed?): ${(err as Error).message}`,
    );
  }
  return started;
}
