import 'reflect-metadata';
// Must be the first non-polyfill import: starts tracing/Sentry before other
// modules load. No-op unless OTEL_EXPORTER_OTLP_ENDPOINT / SENTRY_DSN are set.
import './observability/instrument';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false, rawBody: true });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const prefix = config.get<string>('API_GLOBAL_PREFIX', 'api');
  app.setGlobalPrefix(prefix);
  app.use(helmet());

  // Behind a managed load balancer / reverse proxy (Railway, ALB, nginx) the real client IP is in
  // X-Forwarded-For. Trust the first proxy hop so the rate limiter (ThrottlerGuard) and request
  // logs key on the actual client, not the proxy (P6.5). Safe in local dev (no proxy → no-op).
  const trustProxyHops = Number(config.get<string>('TRUST_PROXY_HOPS', '1'));
  app.getHttpAdapter().getInstance().set('trust proxy', trustProxyHops);

  const origins = config
    .get<string>('CORS_ORIGINS', 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  // Swagger publishes the full API surface — keep it out of production unless
  // explicitly enabled (ENABLE_SWAGGER=true) to avoid free reconnaissance.
  const swaggerEnabled =
    config.get<string>('NODE_ENV') !== 'production' ||
    config.get<string>('ENABLE_SWAGGER') === 'true';
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('ETicketsGo API')
      .setDescription('Event operating system — customer, organizer, and admin APIs.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${prefix}/docs`, app, document);
  }

  // Graceful shutdown. Without this, Nest never listens for SIGTERM, so the lifecycle hooks
  // that exist precisely to clean up — PrismaService.onModuleDestroy, RedisService.onModuleDestroy
  // — never run, and the process dies on the signal's default action. That matters on every
  // managed platform: a deploy, a restart, and a scale-down all begin with SIGTERM, so in-flight
  // requests (a checkout mid-payment among them) were being severed rather than drained, and
  // database/Redis connections were left for the server to time out. Enabling the hooks makes
  // `app.close()` stop accepting new connections, finish in-flight ones, then run the module
  // teardown. The worker has always handled its own SIGTERM/SIGINT; this brings the API level.
  app.enableShutdownHooks();

  // Managed platforms (Railway, Heroku, Render…) inject the port to bind as PORT and route the
  // public domain + health check there, so PORT wins when present. API_PORT (4000) remains the
  // default for compose/k8s/local. Bind 0.0.0.0 explicitly: the container must accept traffic
  // from outside its network namespace, and a future Node default of ::1/localhost would make
  // the platform health check fail with no other symptom.
  const port = config.get<number>('PORT') ?? config.get<number>('API_PORT', 4000);
  await app.listen(port, '0.0.0.0');
  logger.log(`ETicketsGo API listening on 0.0.0.0:${port}/${prefix}`);
  if (swaggerEnabled) logger.log(`Swagger docs at /${prefix}/docs`);
}

void bootstrap();
