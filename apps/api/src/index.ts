// Library entry so sibling apps (e.g. the worker) can reuse the module graph
// and domain services without duplicating business logic.
export { AppModule } from './app.module';
export { BookingsService } from './bookings/bookings.service';
export { LocalBookingOrchestrator } from './bookings/orchestration/local-booking-orchestrator.service';
export { EventsService } from './events/events.service';
// The worker sweeps for listings that became unsellable after they were published.
export { EventSellabilitySweepService } from './events/event-sellability-sweep.service';
export { PrismaService } from './prisma/prisma.service';
export { NotificationService } from './notifications/notification.service';
export { NotificationFallbackService } from './notifications/policy/fallback.service';
export { ShowCancellationFanoutService } from './notifications/producers/show-cancellation-fanout.service';
export { ShowReminderService } from './notifications/producers/show-reminder.service';
export { AuthService } from './auth/auth.service';
export { FinanceReconciliationService } from './payments/finance/finance-reconciliation.service';
export { StripeWebhookProcessor } from './payments/webhooks/stripe/stripe-webhook.processor';
export { RazorpayWebhookProcessor } from './payments/razorpay/razorpay-webhook.processor';
export { SettlementService } from './payments/settlement/settlement.service';
// Exposed for the worker's expiry tick — see apps/worker/src/main.ts.
export { SeatOverridesService } from './shows/seat-overrides.service';
export { SyncEventProcessor } from './inventory/sync/sync-event.processor';
export { SyncPollingService } from './inventory/sync/sync-polling.service';
export { OutboxDispatcher } from './common/domain-events/outbox/outbox-dispatcher.service';
export { OutboxRetentionService } from './common/domain-events/outbox/outbox-retention.service';
export {
  bullConnectionFromUrl,
  bullPrefix,
  cacheKeyPrefix,
  opsKeyPrefix,
  redisEnvRoot,
} from './common/redis-namespace';
export type { BullConnectionOptions } from './common/redis-namespace';
