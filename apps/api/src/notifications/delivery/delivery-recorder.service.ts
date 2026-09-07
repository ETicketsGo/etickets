import { Injectable } from '@nestjs/common';
import {
  CostSource,
  DeliveryState,
  OutcomeClass,
  SendKind,
  advancesDelivery,
  resolveDeliveryState,
  suppressionFor,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { SuppressionService } from './suppression.service';
import { NotificationRateService } from '../cost/notification-rate.service';

/**
 * The record of what a provider did with one message.
 *
 * ── THE CRASH WINDOW THIS IS SHAPED AROUND ─────────────────────────────────────────
 * A send has three steps that are not atomic: write down that we are about to send, call the
 * provider, write down what it said. A process that dies between the second and third leaves
 * a message the provider has ACCEPTED and charged for, and a database that has no idea.
 *
 * There is no way to close that window from this side. None of the providers this platform
 * uses — Twilio, MSG91, Meta Cloud, SES — accepts an idempotency key on a send, so a retry
 * is a genuinely new message to them. What CAN be done is make the ambiguity visible: the
 * attempt row is written as ATTEMPTING *before* the provider call, so a crash leaves an
 * ATTEMPTING row that says, truthfully, "we do not know whether this went out".
 *
 * See ADR-046: exactly-once intent creation, at-least-once delivery execution, and no
 * exactly-once claim about the provider, because there is nothing to base one on.
 */
@Injectable()
export class DeliveryRecorderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly suppression: SuppressionService,
    private readonly metrics?: MetricsService,
    /*
      Optional so the many suites that construct this recorder directly keep working. Without
      it every attempt is priced UNKNOWN, which is the honest answer when nothing can quote a
      rate -- and is exactly what a deployment with no rates configured records anyway.
    */
    private readonly rates?: NotificationRateService,
  ) {}

  /**
   * Open an attempt BEFORE the provider is called.
   *
   * The order is the point. Written afterwards, a crash mid-call leaves no trace at all and
   * the next sweep sends again believing it is the first attempt. Written first, the row is
   * evidence — and `attemptNumber` is unique per notification, so two workers racing the same
   * row cannot both open attempt 3.
   */
  async open(input: {
    notificationId: string;
    provider: string;
    channel: string;
    attemptNumber: number;
    /** PRIMARY | RETRY | FALLBACK | MANUAL_RESEND. Defaults from the attempt number. */
    sendKind?: SendKind;
  }): Promise<string | null> {
    const created = await this.prisma.notificationDelivery
      .createMany({
        data: [
          {
            notificationId: input.notificationId,
            provider: input.provider,
            channel: input.channel,
            attemptNumber: input.attemptNumber,
            status: DeliveryState.ATTEMPTING,
            /*
              A second attempt on the same notification is a RETRY unless the caller says
              otherwise -- which the fallback service and an operator resend both do. Derived
              rather than assumed, so an attempt cannot be silently miscategorised into the
              cheap bucket.
            */
            sendKind:
              input.sendKind ?? (input.attemptNumber > 1 ? SendKind.RETRY : SendKind.PRIMARY),
          },
        ],
        // A duplicate means another worker already claimed this attempt number. Skipping is
        // correct and, crucially, does not raise -- a unique violation here would poison the
        // transaction the sweep is running in.
        skipDuplicates: true,
      })
      .catch(() => ({ count: 0 }));
    if (created.count === 0) return null;

    const row = await this.prisma.notificationDelivery.findUnique({
      where: {
        notificationId_attemptNumber: {
          notificationId: input.notificationId,
          attemptNumber: input.attemptNumber,
        },
      },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * The provider took it and gave a reference. Acceptance, explicitly not delivery — and the
   * moment a charge becomes possible.
   *
   * ── WHY COST IS RECORDED HERE AND NEVER REMOVED LATER ──────────────────────────────
   * Acceptance is what a provider bills for. A message that is accepted and then comes back
   * UNDELIVERED, or bounces, or earns a spam complaint, was still carried and still costs the
   * same. Deleting the cost when the outcome turns bad would produce a total that shrinks as
   * things go wrong — the exact opposite of what an operator needs to see. Delivery outcome
   * and money are separate facts and are stored as separate facts.
   */
  async accepted(
    deliveryId: string,
    provider: string,
    providerMessageId: string | null,
    context: { country?: string | null; category?: string | null; body?: string } = {},
  ): Promise<void> {
    const at = new Date();
    const row = await this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      select: { channel: true },
    });

    const cost = this.rates
      ? await this.rates
          .estimate({
            provider,
            channel: row?.channel ?? 'unknown',
            country: context.country,
            category: context.category,
            body: context.body,
            at,
          })
          .catch(() => null)
      : null;

    await this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: DeliveryState.ACCEPTED,
        outcomeClass: OutcomeClass.PROVIDER_ACCEPTED,
        provider,
        providerMessageId,
        acceptedAt: at,
        // No rate configured leaves the row UNKNOWN. Never zero: see CostSource.
        costMicro: cost?.costMicro ?? null,
        costCurrency: cost?.costCurrency ?? null,
        costSource: cost?.costSource ?? CostSource.UNKNOWN,
        billedUnits: cost?.billedUnits ?? null,
        costCalculatedAt: cost ? at : null,
      },
    });

    if (cost) {
      this.metrics?.recordNotificationCost(
        row?.channel ?? 'unknown',
        provider,
        cost.costCurrency,
        cost.costMicro,
        cost.costSource,
      );
    }
  }

  /**
   * There was nowhere to send to, or we refused to.
   *
   * Neither is a provider failure and neither costs anything: the provider was never called.
   * Recording them as attempts anyway is what lets a report answer "how many messages did we
   * choose not to send, and why" without a second table — and `outcomeClass` is what keeps
   * them out of the provider's failure rate.
   */
  async notAttempted(
    deliveryId: string,
    outcome: 'POLICY_SUPPRESSED' | 'NO_DESTINATION',
    reason: string,
  ): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: DeliveryState.REJECTED,
        outcomeClass: outcome,
        provider: 'none',
        failureCode: reason,
        failedAt: new Date(),
        // Explicitly not CONFIGURED_FREE: nothing was sent, so there is no price to quote.
        costSource: CostSource.UNKNOWN,
      },
    });
  }

  /**
   * There was nowhere to deliver to. Not a failure, never retried, and never a charge.
   *
   * Kept as its own name because that is what the channels call it; it is
   * {@link notAttempted} with the outcome that says the destination was missing rather than
   * blocked.
   */
  async skipped(deliveryId: string, _provider: string, reason: string): Promise<void> {
    await this.notAttempted(deliveryId, OutcomeClass.NO_DESTINATION, reason);
  }

  /** The send itself failed — nothing reached the provider, so nobody received anything. */
  async failed(deliveryId: string, provider: string, message: string): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: DeliveryState.FAILED,
        /*
          A send that never reached a provider. Nobody received anything and nobody was
          charged -- which is why this is UNAVAILABLE rather than REJECTED, and why no cost
          is written: the attempt is real, the charge is not.
        */
        outcomeClass: OutcomeClass.PROVIDER_UNAVAILABLE,
        provider,
        // Truncated: a provider's error body can be a page long and this column is read in
        // a list view. It never contains the message or the destination.
        failureReason: message.slice(0, 500),
        failedAt: new Date(),
      },
    });
  }

  /**
   * Apply what a provider's callback said.
   *
   * ── WHY IT CANNOT SIMPLY OVERWRITE ─────────────────────────────────────────────────
   * Callbacks do not arrive in order. Twilio's `sent` and `delivered` are two HTTP requests
   * racing across the internet, and WhatsApp routinely reports `read` before `delivered`.
   * Overwriting would let a late `sent` tell an operator that a message which reached
   * somebody is still in flight — and, far worse, let a late `delivered` overwrite a bounce
   * and un-suppress a dead address.
   *
   * So state only ever moves forward, by rank. A late or duplicate event is recorded as
   * having been seen and changes nothing.
   */
  async applyProviderEvent(input: {
    provider: string;
    providerMessageId: string;
    state: DeliveryState;
    providerStatus?: string | null;
    failureCode?: string | null;
    failureReason?: string | null;
    /** The destination, for suppression. Hashed immediately; never stored in the clear. */
    destination?: string | null;
    occurredAt?: Date;
  }): Promise<'applied' | 'ignored' | 'unknown'> {
    const delivery = await this.prisma.notificationDelivery.findFirst({
      where: { provider: input.provider, providerMessageId: input.providerMessageId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, channel: true, deliveredAt: true },
    });

    if (!delivery) {
      /*
        A callback for something this platform has no record of. Not an error, and certainly
        not a crash: it happens after a database restore, for a message sent by a different
        environment sharing a provider account, or for an event type nobody subscribed to.
        Counted so a flood of them is visible, and acknowledged so the provider stops
        redelivering an event we will never be able to use.
      */
      this.metrics?.recordNotificationWebhook(input.provider, 'unknown_message');
      return 'unknown';
    }

    const current = delivery.status as DeliveryState;
    if (!advancesDelivery(current, input.state)) {
      this.metrics?.recordNotificationWebhook(input.provider, 'out_of_order');
      return 'ignored';
    }

    const next = resolveDeliveryState(current, input.state);
    const at = input.occurredAt ?? new Date();
    /*
      A provider refusing is theirs; a message it carried and could not deliver is usually the
      destination's. Neither touches `costMicro` -- the provider carried it and charged for it
      whatever came back afterwards.
    */
    const outcome =
      next === DeliveryState.REJECTED
        ? OutcomeClass.PROVIDER_REJECTED
        : next === DeliveryState.DELIVERED || next === DeliveryState.READ
          ? OutcomeClass.PROVIDER_ACCEPTED
          : OutcomeClass.UNDELIVERABLE_DESTINATION;
    await this.prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: next,
        outcomeClass: outcome,
        providerStatus: input.providerStatus ?? undefined,
        failureCode: input.failureCode ?? undefined,
        failureReason: input.failureReason?.slice(0, 500) ?? undefined,
        /*
          Each timestamp records ITS OWN fact, and none of them overwrites another.

          `deliveredAt` previously took the read time too, so a WhatsApp message that was
          delivered and then opened lost the moment it actually arrived -- replaced by a
          later fact about the same message. And a DELIVERED that is later COMPLAINED must
          keep its delivery time: `undefined` means "leave it alone" to Prisma, which is what
          preserves the history without needing an event table to hold it.
        */
        deliveredAt: next === DeliveryState.DELIVERED && !delivery.deliveredAt ? at : undefined,
        readAt: next === DeliveryState.READ ? at : undefined,
        failedAt: suppressionFor(next) || next === DeliveryState.UNDELIVERED ? at : undefined,
      },
    });

    /*
      The notification itself follows the attempt into a terminal failure, and only into one.
      An operator looking at the inbox row must not see SENT for a message that bounced --
      that was the original defect. It is NOT moved back on a DELIVERED, because SENT already
      means "handed over successfully" and there is nothing more truthful to say.
    */
    const terminal = suppressionFor(next);
    if (terminal) {
      await this.prisma.notification
        .update({
          where: { id: (await this.notificationIdFor(delivery.id)) ?? '' },
          data: { status: 'FAILED', lastError: `${input.provider}: ${next}` },
        })
        .catch(() => undefined);
    }

    this.metrics?.recordNotificationDelivery(input.provider, delivery.channel, next);

    if (terminal && input.destination) {
      await this.suppression.suppress({
        channel: delivery.channel,
        destination: input.destination,
        reason: terminal,
        provider: input.provider,
        sourceDeliveryId: delivery.id,
      });
    }
    return 'applied';
  }

  private async notificationIdFor(deliveryId: string): Promise<string | null> {
    const row = await this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      select: { notificationId: true },
    });
    return row?.notificationId ?? null;
  }
}
