import { Injectable } from '@nestjs/common';
import type { DeliveryState, SuppressionReason } from '@eticketsgo/shared-types';
import type { DestinationRef } from './suppression.service';

/** A verified provider event about a message that is NOT a notification delivery. */
export interface ProviderEventInput {
  provider: string;
  providerMessageId: string;
  /** The provider's own id for this event (`<messageId>:<type>[:n]`). The idempotency key. */
  eventId?: string | null;
  state: DeliveryState;
  providerStatus?: string | null;
  failureCode?: string | null;
  failureReason?: string | null;
  destination?: string | null;
  destinationRef?: DestinationRef | null;
  suppressionReason?: SuppressionReason | null;
  occurredAt?: Date;
}

export type SinkOutcome = 'applied' | 'ignored' | 'unknown';

export interface ProviderEventSink {
  /** 'unknown' means "not one of mine": the next sink, or the caller, decides. */
  apply(input: ProviderEventInput): Promise<SinkOutcome>;
}

/**
 * Other senders that share the provider's event stream.
 *
 * SES publishes every event of a configuration set to one SNS topic, and the webhook verifies
 * and records each one once. A message the notification tables do not know may belong to
 * another sender - today, organizer campaigns. Rather than the notification code knowing about
 * campaigns (a dependency the wrong way round), a sender registers a sink here at start-up, and
 * `DeliveryRecorderService` asks the sinks before it calls an event unknown.
 *
 * The webhook's own ledger (`WebhookEvent`, unique per provider event id) already makes a
 * redelivery a no-op before any sink is asked.
 */
@Injectable()
export class ProviderEventSinks {
  private readonly sinks: ProviderEventSink[] = [];

  register(sink: ProviderEventSink): void {
    if (!this.sinks.includes(sink)) this.sinks.push(sink);
  }

  async apply(input: ProviderEventInput): Promise<SinkOutcome> {
    for (const sink of this.sinks) {
      const outcome = await sink.apply(input);
      if (outcome !== 'unknown') return outcome;
    }
    return 'unknown';
  }
}
