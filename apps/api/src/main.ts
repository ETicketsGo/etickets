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

  const port = config.get<number>('API_PORT', 4000);
  await app.listen(port);
  logger.log(`ETicketsGo API listening on http://localhost:${port}/${prefix}`);
  logger.log(`Swagger docs at http://localhost:${port}/${prefix}/docs`);
}

void bootstrap();
