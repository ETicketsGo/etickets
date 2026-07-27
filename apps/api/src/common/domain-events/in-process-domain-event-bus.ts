import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import type { DomainEvent } from './domain-event';
import { DOMAIN_EVENT_BUS, type DomainEventBus, type SubscribeOptions } from './domain-event-bus';
import { handlerIdentity, type DomainEventHandler } from './domain-event-handler';
import { assertValidDomainEvent } from './domain-event.factory';
import { DuplicateSubscriptionError } from './domain-event.errors';

interface Registration {
  handler: DomainEventHandler;
  name: string;
  versions?: readonly number[];
}

/** Publish outcomes recorded to metrics (never any payload/PII). */
type PublishResult = 'ok' | 'no_handler' | 'disabled' | 'invalid';
type HandlerResult = 'ok' | 'error' | 'skipped';

/**
 * Synchronous, in-process {@link DomainEventBus} (ADR-038).
 *
 * Handlers for an event type run SEQUENTIALLY in registration order — deterministic
 * by design, not maximally concurrent. Each handler is isolated: a throw or a timeout
 * is caught, logged (PII-free) and counted, and the remaining handlers still run;
 * publish never rejects on a handler fault, so a post-commit publish can never undo a
 * committed transaction. Only a malformed event (producer bug) rejects publish.
 *
 * When `DOMAIN_EVENTS_ENABLED` is off, publish is a no-op (recorded as `disabled`):
 * subscriptions are still accepted, but no handler runs, so core flows are unaffected.
 */
@Injectable()
export class InProcessDomainEventBus implements DomainEventBus {
  private readonly logger = new Logger('DomainEventBus');
  private readonly registrations = new Map<string, Registration[]>();

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  subscribe<TEvent extends DomainEvent>(
    eventType: string,
    handler: DomainEventHandler<TEvent>,
    options?: SubscribeOptions,
  ): void {
    const list = this.registrations.get(eventType) ?? [];
    const name = handlerIdentity(handler as DomainEventHandler);
    if (list.some((r) => r.name === name)) {
      throw new DuplicateSubscriptionError(
        `Handler '${name}' is already subscribed to '${eventType}'.`,
        { eventType, handler: name },
      );
    }
    list.push({
      handler: handler as DomainEventHandler,
      name,
      versions: options?.versions ?? handler.supportedVersions,
    });
    this.registrations.set(eventType, list);
    this.logger.log(`subscribed '${name}' to '${eventType}'`);
  }

  async publishMany(events: DomainEvent[]): Promise<void> {
    // Sequential so ordering is deterministic (events[0] fully dispatched first).
    for (const event of events) {
      await this.publish(event);
    }
  }

  async publish(event: DomainEvent): Promise<void> {
    if (!this.enabled) {
      this.record(event, 'disabled');
      return;
    }
    try {
      assertValidDomainEvent(event);
    } catch (err) {
      this.record(event, 'invalid');
      throw err; // producer bug — surface it, do not swallow
    }

    const handlers = this.registrations.get(event.eventType) ?? [];
    if (handlers.length === 0) {
      this.logger.debug?.(`no handler for '${event.eventType}' (${event.eventId})`);
      this.record(event, 'no_handler');
      return;
    }

    for (const reg of handlers) {
      await this.runHandler(event, reg);
    }
    this.record(event, 'ok');
  }

  /** Stable handler identities registered for an event type (for durable delivery). */
  handlersFor(eventType: string): string[] {
    return (this.registrations.get(eventType) ?? []).map((r) => r.name);
  }

  /**
   * Execute ONE named handler for an event with the same version gate + timeout +
   * observation as the in-process path, returning a durable result (ADR-041). The
   * outbox durable-delivery adapter uses this to run each handler under per-handler
   * idempotency; unlike `publish`, this surfaces success/failure to the caller.
   */
  async executeHandler(
    eventType: string,
    handlerName: string,
    event: DomainEvent,
  ): Promise<{ ok: boolean; skipped: boolean; errorMessage?: string }> {
    const reg = (this.registrations.get(eventType) ?? []).find((r) => r.name === handlerName);
    if (!reg) return { ok: false, skipped: true, errorMessage: 'handler_not_registered' };
    if (reg.versions && !reg.versions.includes(event.eventVersion)) {
      this.metrics.recordDomainEventHandler(eventType, handlerName, 'skipped', 0);
      return { ok: true, skipped: true };
    }
    const startedAt = Date.now();
    try {
      await this.withTimeout(reg.handler.handle(event), reg.name, event);
      this.observe(event, reg.name, 'ok', startedAt);
      return { ok: true, skipped: false };
    } catch (err) {
      this.observe(event, reg.name, 'error', startedAt);
      return {
        ok: false,
        skipped: false,
        errorMessage: err instanceof Error ? err.message : 'unknown',
      };
    }
  }

  private async runHandler(event: DomainEvent, reg: Registration): Promise<void> {
    // Version gate: a handler that declared supported versions never receives an
    // unknown version — it is skipped visibly (warn + metric), never silently.
    if (reg.versions && !reg.versions.includes(event.eventVersion)) {
      this.logger.warn(
        `handler '${reg.name}' skips '${event.eventType}' v${event.eventVersion} (supports ${reg.versions.join(',')})`,
      );
      this.metrics.recordDomainEventHandler(event.eventType, reg.name, 'skipped', 0);
      return;
    }

    const startedAt = Date.now();
    try {
      await this.withTimeout(reg.handler.handle(event), reg.name, event);
      this.observe(event, reg.name, 'ok', startedAt);
    } catch (err) {
      this.observe(event, reg.name, 'error', startedAt);
      // Isolated + observable: log identity + message only (never the payload).
      this.logger.error(
        `handler '${reg.name}' failed for '${event.eventType}' (${event.eventId}): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  private withTimeout<T>(work: Promise<T>, handlerName: string, event: DomainEvent): Promise<T> {
    const ms = this.timeoutMs;
    if (!ms || ms <= 0) return work;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`handler '${handlerName}' timed out after ${ms}ms on '${event.eventType}'`),
        );
      }, ms);
      timer.unref?.();
      work.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private observe(
    event: DomainEvent,
    handlerName: string,
    result: HandlerResult,
    startedAt: number,
  ): void {
    this.metrics.recordDomainEventHandler(
      event.eventType,
      handlerName,
      result,
      (Date.now() - startedAt) / 1000,
    );
  }

  private record(event: DomainEvent, result: PublishResult): void {
    this.metrics.recordDomainEventPublished(event.eventType, result);
  }

  private get enabled(): boolean {
    return this.config.get<boolean>('DOMAIN_EVENTS_ENABLED') === true;
  }

  private get timeoutMs(): number {
    return Number(this.config.get<number>('DOMAIN_EVENT_HANDLER_TIMEOUT_MS') ?? 5000);
  }
}

/** Provider wiring so consumers inject the DOMAIN_EVENT_BUS token → this class. */
export const domainEventBusProvider = {
  provide: DOMAIN_EVENT_BUS,
  useExisting: InProcessDomainEventBus,
};
