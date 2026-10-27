import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { throttlerOptions } from './common/throttle';
import { RedisService } from './redis/redis.service';
import { loadConfig } from './config/configuration';
import { MfaGuard } from './auth/mfa/mfa.guard';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { SecretsModule } from './secrets/secrets.module';
import { RedisModule } from './redis/redis.module';
import { CacheModule } from './cache/cache.module';
import { AuditModule } from './audit/audit.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { HumanCheckModule } from './human-check/human-check.module';
import { PricingModule } from './pricing/pricing.module';
import { NotificationsModule } from './notifications/notifications.module';
import { NotificationFeedModule } from './notifications/feed/notification-feed.module';
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
import { CounterModule } from './counter/counter.module';
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
import { CrmModule } from './crm/crm.module';
import { BillingModule } from './billing/billing.module';
import { OpsModule } from './ops/ops.module';
import { OpsAlertsModule } from './ops/alerts/ops-alerts.module';
import { PilotModule } from './pilot/pilot.module';
import { ReviewsModule } from './reviews/reviews.module';
import { EngagementModule } from './engagement/engagement.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { SupportModule } from './support/support.module';
import { AiModule } from './ai/ai.module';
import { AiGrowthModule } from './ai-growth/ai-growth.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { RecommendationsModule } from './recommendations/recommendations.module';
import { InventorySourcingModule } from './inventory/sourcing/inventory-sourcing.module';
import { DomainEventsModule } from './common/domain-events/domain-events.module';
import { InventoryLockingModule } from './inventory/locking/inventory-locking.module';
import { InventorySyncModule } from './inventory/sync/inventory-sync.module';
import { InventorySandboxModule } from './inventory/sandbox/inventory-sandbox.module';
import { BookingOrchestrationModule } from './bookings/orchestration/booking-orchestration.module';
import { BookingConfirmationBridgeModule } from './bookings/orchestration/booking-confirmation-bridge';
import { BookingProvidersModule } from './bookings/providers/booking-providers.module';
import { CompensationModule } from './bookings/compensation/compensation.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { OrganizerOnlyGuard } from './tenancy/organizer-only.guard';
import { RolesGuard } from './auth/roles.guard';
import { AdminPermissionGuard } from './auth/admin-permission.guard';
import { MaintenanceGuard } from './ops/maintenance.guard';
import { LoggingInterceptor } from './common/logging.interceptor';
import { HttpObservationService } from './common/http-observation.service';
import { HttpObservationMiddleware } from './common/http-observation.middleware';

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
    /*
      ── WHERE THE COUNTERS LIVE, AND WHOSE THEY ARE ────────────────────────────────
      Assembled in `common/throttle.ts`: Redis-backed counters in every deployed environment
      (shared between replicas, kept across a restart, per-process memory if Redis is away),
      keyed on the visitor's address rather than on the Railway edge node that carried the
      request. `common/client-ip.ts` has the QA evidence that the old key counted edge nodes.
    */
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [ConfigService, RedisService],
      useFactory: (config: ConfigService, redis: RedisService) => throttlerOptions(config, redis),
    }),
    PrismaModule,
    StorageModule,
    SecretsModule,
    RedisModule,
    CacheModule,
    AuditModule,
    MetricsModule,
    HumanCheckModule,
    TenancyModule,
    NotificationsModule,
    PricingModule,
    AuthModule,
    UsersModule,
    HealthModule,
    OrganizationsModule,
    VenuesModule,
    EventsModule,
    NotificationFeedModule,
    CouponsModule,
    CommerceModule,
    MoviesModule,
    CinemasModule,
    ShowsModule,
    BookingsModule,
    PaymentsModule,
    CounterModule,
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
    CrmModule,
    BillingModule,
    OpsModule,
    OpsAlertsModule,
    PilotModule,
    ReviewsModule,
    EngagementModule,
    CampaignsModule,
    SupportModule,
    AiModule,
    AiGrowthModule,
    DiscoveryModule,
    RecommendationsModule,
    InventorySourcingModule,
    DomainEventsModule,
    InventoryLockingModule,
    InventorySyncModule,
    InventorySandboxModule,
    BookingConfirmationBridgeModule,
    BookingProvidersModule,
    BookingOrchestrationModule,
    CompensationModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    HttpObservationService,
    HttpObservationMiddleware,
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    // MaintenanceGuard runs FIRST so non-exempt routes get a clean 503 during
    // maintenance (before auth challenges). OFF by default + fail-open, so this
    // is a near-zero-cost pass-through in normal operation.
    { provide: APP_GUARD, useClass: MaintenanceGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Straight after authentication and before ANY authorization guard: a back-office session
    // that has not passed the second factor is refused here, on every route, before a role or a
    // capability is even looked at. See mfa.guard.ts.
    { provide: APP_GUARD, useClass: MfaGuard },
    // Before RolesGuard, so platform staff refused an organizer-only money or identity route
    // are refused WITH an audit row, not lost as a plain role mismatch. See the guard.
    { provide: APP_GUARD, useClass: OrganizerOnlyGuard },
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
    /*
      Observation runs on every request, matched or not. An interceptor only runs once Nest
      has matched a handler, so a request to a path that matches nothing produced a 404 for
      the client and nothing at all in the request log or the metrics -- which is the shape of
      scanner traffic, and the traffic most worth counting.

      Applied AFTER the correlation-ID middleware so a recorded line carries the same id as
      everything else said about that request. It records nothing itself; it arms a service
      that latches on the request, so the interceptor arming the same request later is a
      no-op and a matched request is still recorded exactly once.
    */
    consumer.apply(HttpObservationMiddleware).forRoutes('{*path}');
  }
}
