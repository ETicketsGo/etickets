import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { loadConfig } from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { SecretsModule } from './secrets/secrets.module';
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
import { CouponsModule } from './coupons/coupons.module';
import { CommerceModule } from './commerce/commerce.module';
import { MoviesModule } from './movies/movies.module';
import { CinemasModule } from './cinemas/cinemas.module';
import { ShowsModule } from './shows/shows.module';
import { BookingsModule } from './bookings/bookings.module';
import { PaymentsModule } from './payments/payments.module';
import { TicketsModule } from './tickets/tickets.module';
import { WalletModule } from './wallet/wallet.module';
import { AttendeesModule } from './attendees/attendees.module';
import { SharingModule } from './sharing/sharing.module';
import { CheckinsModule } from './checkins/checkins.module';
import { OfflineCheckinModule } from './checkins/offline/offline-checkin.module';
import { RefundsModule } from './refunds/refunds.module';
import { ReceiptsModule } from './receipts/receipts.module';
import { PayoutsModule } from './payouts/payouts.module';
import { ReportsModule } from './reports/reports.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AdminModule } from './admin/admin.module';
import { OpsModule } from './ops/ops.module';
import { ReviewsModule } from './reviews/reviews.module';
import { SupportModule } from './support/support.module';
import { AiModule } from './ai/ai.module';
import { AiGrowthModule } from './ai-growth/ai-growth.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { RecommendationsModule } from './recommendations/recommendations.module';
import { InventorySourcingModule } from './inventory/sourcing/inventory-sourcing.module';
import { DomainEventsModule } from './common/domain-events/domain-events.module';
import { InventoryLockingModule } from './inventory/locking/inventory-locking.module';
import { InventorySyncModule } from './inventory/sync/inventory-sync.module';
import { BookingOrchestrationModule } from './bookings/orchestration/booking-orchestration.module';
import { BookingConfirmationBridgeModule } from './bookings/orchestration/booking-confirmation-bridge';
import { BookingProvidersModule } from './bookings/providers/booking-providers.module';
import { CompensationModule } from './bookings/compensation/compensation.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { AdminPermissionGuard } from './auth/admin-permission.guard';
import { MaintenanceGuard } from './ops/maintenance.guard';
import { LoggingInterceptor } from './common/logging.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: () => loadConfig(),
    }),
    /*
      Per-IP request ceiling. The DEFAULT IS UNCHANGED at 120/minute — this only makes it
      configurable.

      The end-to-end suite drives four apps from a single IP, so every browser and every
      fixture shares one client's budget. Past roughly eighty scenarios it exhausts the
      production ceiling and unrelated specs start failing with a bare UNAUTHORIZED, which
      looks like a product fault and is not one.

      Raising it in the e2e environment is not weakening the limit: a test runner is one
      machine standing in for many users, which is precisely the case the limit is not aimed
      at. Deployments that set nothing keep the production value.
    */
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
        limit: Number(process.env.THROTTLE_LIMIT ?? 120),
      },
    ]),
    PrismaModule,
    SecretsModule,
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
    CouponsModule,
    CommerceModule,
    MoviesModule,
    CinemasModule,
    ShowsModule,
    BookingsModule,
    PaymentsModule,
    TicketsModule,
    WalletModule,
    AttendeesModule,
    SharingModule,
    CheckinsModule,
    OfflineCheckinModule,
    RefundsModule,
    ReceiptsModule,
    PayoutsModule,
    ReportsModule,
    AnalyticsModule,
    AdminModule,
    OpsModule,
    ReviewsModule,
    SupportModule,
    AiModule,
    AiGrowthModule,
    DiscoveryModule,
    RecommendationsModule,
    InventorySourcingModule,
    DomainEventsModule,
    InventoryLockingModule,
    InventorySyncModule,
    BookingConfirmationBridgeModule,
    BookingProvidersModule,
    BookingOrchestrationModule,
    CompensationModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    // MaintenanceGuard runs FIRST so non-exempt routes get a clean 503 during
    // maintenance (before auth challenges). OFF by default + fail-open, so this
    // is a near-zero-cost pass-through in normal operation.
    { provide: APP_GUARD, useClass: MaintenanceGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Runs after RolesGuard: a route is first checked for "are you staff at all", then for
    // "may you do this specific thing". Both must pass.
    { provide: APP_GUARD, useClass: AdminPermissionGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Express 5 / path-to-regexp v8 require a named wildcard; '*' is no longer a valid path token
    // (NestJS auto-converts it with a deprecation warning). '{*path}' matches every route exactly
    // as the old '*' did, so the correlation-ID middleware still runs on all requests.
    consumer.apply(CorrelationIdMiddleware).forRoutes('{*path}');
  }
}
