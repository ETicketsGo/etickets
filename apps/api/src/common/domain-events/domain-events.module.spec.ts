import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { DomainEventsModule } from './domain-events.module';
import { DOMAIN_EVENT_BUS, type DomainEventBus } from './domain-event-bus';
import { TransactionalEventPublisher } from './transactional-event-publisher';
import { BookingEventRecorder } from './handlers/booking-event.recorder';
import { bookingConfirmedEvent } from './catalogue/booking-events';

// Stand in for the app's @Global Prisma + Metrics modules so the bus/publisher
// resolve their dependencies exactly as at runtime.
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: {} as PrismaService }, MetricsService],
  exports: [PrismaService, MetricsService],
})
class GlobalDepsModule {}

async function boot(enabled: boolean) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ DOMAIN_EVENTS_ENABLED: enabled, DOMAIN_EVENT_HANDLER_TIMEOUT_MS: 1000 })],
      }),
      GlobalDepsModule,
      DomainEventsModule,
    ],
  }).compile();
  await moduleRef.init(); // fires onModuleInit → subscribes the recorder
  return moduleRef;
}

describe('DomainEventsModule (Nest DI boot)', () => {
  it('resolves the bus + publisher via DI and dispatches to the subscribed proof handler', async () => {
    const moduleRef = await boot(true);
    const bus = moduleRef.get<DomainEventBus>(DOMAIN_EVENT_BUS);
    const publisher = moduleRef.get(TransactionalEventPublisher);
    const recorder = moduleRef.get(BookingEventRecorder);
    const spy = jest.spyOn(recorder, 'handle');

    expect(publisher).toBeInstanceOf(TransactionalEventPublisher);

    await bus.publish(
      bookingConfirmedEvent({
        bookingId: 'bk_1',
        userId: 'user_1',
        experienceId: 'ev_1',
        amount: '150000',
        currency: 'INR',
        ticketCount: 2,
        confirmedAt: new Date().toISOString(),
      }),
    );

    expect(spy).toHaveBeenCalledTimes(1); // proves subscription + dispatch end-to-end
    await moduleRef.close();
  });

  it('does not invoke the proof handler when the flag is off', async () => {
    const moduleRef = await boot(false);
    const bus = moduleRef.get<DomainEventBus>(DOMAIN_EVENT_BUS);
    const recorder = moduleRef.get(BookingEventRecorder);
    const spy = jest.spyOn(recorder, 'handle');

    await bus.publish(
      bookingConfirmedEvent({
        bookingId: 'bk_2',
        userId: 'user_1',
        experienceId: 'ev_1',
        amount: '1000',
        currency: 'INR',
        ticketCount: 1,
        confirmedAt: new Date().toISOString(),
      }),
    );

    expect(spy).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});
