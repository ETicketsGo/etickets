import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { loadConfig } from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { CacheModule } from './cache/cache.module';
import { AuditModule } from './audit/audit.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { PricingModule } from './pricing/pricing.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { VenuesModule } from './venues/venues.module';
import { EventsModule } from './events/events.module';
import { MoviesModule } from './movies/movies.module';
import { CinemasModule } from './cinemas/cinemas.module';
import { ShowsModule } from './shows/shows.module';
import { BookingsModule } from './bookings/bookings.module';
import { PaymentsModule } from './payments/payments.module';
import { TicketsModule } from './tickets/tickets.module';
import { CheckinsModule } from './checkins/checkins.module';
import { RefundsModule } from './refunds/refunds.module';
import { PayoutsModule } from './payouts/payouts.module';
import { ReportsModule } from './reports/reports.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AdminModule } from './admin/admin.module';
import { ReviewsModule } from './reviews/reviews.module';
import { SupportModule } from './support/support.module';
import { AiModule } from './ai/ai.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { RecommendationsModule } from './recommendations/recommendations.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { LoggingInterceptor } from './common/logging.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: () => loadConfig(),
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    RedisModule,
    CacheModule,
    AuditModule,
    MetricsModule,
    TenancyModule,
    NotificationsModule,
    PricingModule,
    AuthModule,
    UsersModule,
    HealthModule,
    OrganizationsModule,
    VenuesModule,
    EventsModule,
    MoviesModule,
    CinemasModule,
    ShowsModule,
    BookingsModule,
    PaymentsModule,
    TicketsModule,
    CheckinsModule,
    RefundsModule,
    PayoutsModule,
    ReportsModule,
    AnalyticsModule,
    AdminModule,
    ReviewsModule,
    SupportModule,
    AiModule,
    DiscoveryModule,
    RecommendationsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
