import { DeliveryState, advancesDelivery } from '@eticketsgo/shared-types';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ProviderEventSinks,
  type ProviderEventInput,
  type ProviderEventSink,
  type SinkOutcome,
} from '../notifications/delivery/provider-event-sinks';

/** Once a code has reached the phone, a later report cannot say otherwise. */
const DELIVERED_STATES: readonly string[] = [DeliveryState.DELIVERED, DeliveryState.READ];

/**
 * The delivery report for a sign-in code's text message.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * `PhoneOtpService` sends the code through the SMS channel directly, so the code never lands
 * in a Notification row. That also meant no NotificationDelivery row, so MSG91's report for
 * the text matched nothing and stayed AWAITING_CORRELATION. The provider's message id is now
 * kept on the PhoneOtp row, and this sink - registered the same way campaigns register
 * theirs - matches the report to it. The webhook and the worker's replay of held reports both
 * reach it through `DeliveryRecorderService.applyProviderEvent`.
 *
 * ── WHAT IT RECORDS ────────────────────────────────────────────────────────────────
 * A status and a time. Never the code, never the number: neither is in the event and neither
 * is logged here.
 *
 * ── ORDER AND DUPLICATES ───────────────────────────────────────────────────────────
 * Status only moves forward by the shared delivery rank, and DELIVERED (or READ) is final:
 * a late failure report cannot unsay that the code arrived. A repeat of the same report is
 * 'ignored'. The update is conditional on the status it moves from, so two reports racing
 * each other cannot both win.
 */
@Injectable()
export class PhoneOtpDeliverySink implements ProviderEventSink, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sinks: ProviderEventSinks,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
  }

  async apply(input: ProviderEventInput): Promise<SinkOutcome> {
    if (!input.provider || !input.providerMessageId) return 'unknown';
    const otp = await this.prisma.phoneOtp.findFirst({
      where: { provider: input.provider, providerMessageId: input.providerMessageId },
      select: { id: true, deliveryStatus: true, deliveredAt: true },
    });
    if (!otp) return 'unknown';

    // Every status this report may move the row FROM. Empty means it is late or a repeat.
    const from = Object.values(DeliveryState).filter(
      (s) => advancesDelivery(s, input.state) && !DELIVERED_STATES.includes(s),
    );
    const current = otp.deliveryStatus;
    const movable = current === null || (from as string[]).includes(current);
    if (!movable) return 'ignored';

    const at = input.occurredAt ?? new Date();
    const delivered = DELIVERED_STATES.includes(input.state);
    const moved = await this.prisma.phoneOtp.updateMany({
      where: {
        id: otp.id,
        OR: [{ deliveryStatus: null }, { deliveryStatus: { in: from } }],
      },
      data: {
        deliveryStatus: input.state,
        ...(delivered ? { deliveredAt: otp.deliveredAt ?? at } : {}),
      },
    });
    return moved.count === 1 ? 'applied' : 'ignored';
  }
}
