import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { NotificationType } from '@eticketsgo/shared-types';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { NotificationPreferencesService } from './notification-preferences.service';
import { PrismaService } from '../prisma/prisma.service';
import { SuppressionService } from './delivery/suppression.service';
import { policyFor } from './policy/notification-policy';
import type { ChannelKey } from './channels/notification-channel.interface';

/**
 * The message types a customer is offered control over.
 *
 * ── WHY NOT EVERY TYPE ─────────────────────────────────────────────────────────────
 * There are twenty-odd notification types and most of them are one-offs a person will
 * receive once — a password reset, a share notice, an organizer approval. Listing them all
 * produces a settings page nobody reads, and a page nobody reads is a page where somebody
 * switches off the wrong thing.
 *
 * These six are the ones a customer actually has an opinion about: what happens to their
 * booking, and whether they want reminding.
 */
const CUSTOMER_TYPES: NotificationType[] = [
  NotificationType.BOOKING_CONFIRMED,
  NotificationType.SHOW_CANCELLED,
  NotificationType.SHOW_CHANGED,
  NotificationType.BOOKING_CANCELLED,
  NotificationType.REFUND_COMPLETED,
  NotificationType.EVENT_REMINDER,
];

const updateSchema = z.object({
  type: z.enum(CUSTOMER_TYPES as [NotificationType, ...NotificationType[]]),
  channel: z.enum(['email', 'sms', 'whatsapp', 'push', 'in_app']),
  enabled: z.boolean(),
});

/**
 * What a customer can and cannot switch off.
 *
 * ── WHY THE RESPONSE CARRIES `guaranteed` ──────────────────────────────────────────
 * Because a toggle that does nothing is worse than no toggle. Policy guarantees some channels
 * — the inbox always, and email for anything about a booking — so that nobody can configure
 * themselves into a state where a cancelled show reaches them nowhere. A settings screen that
 * offers those as switches would be lying twice over: once by implying the message can be
 * stopped, and again when it arrives anyway.
 *
 * So the API says which channels are required and the UI is expected to show them as such.
 * The alternative — hiding them — would leave a customer unable to see that we will email
 * them about their booking, which is exactly the thing a privacy-minded person came here to
 * find out.
 *
 * ── WHY THIS EXTENDS THE EXISTING SERVICE ──────────────────────────────────────────
 * `NotificationPreferencesService` has existed since ADR-020 and is what the policy resolver
 * reads on every send. There is one preference model; this is its HTTP surface, which simply
 * had never been written.
 */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me/notification-preferences')
export class NotificationPreferencesController {
  constructor(
    private readonly preferences: NotificationPreferencesService,
    private readonly prisma: PrismaService,
    private readonly suppression: SuppressionService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Notification preferences, and which channels policy requires.' })
  async get(@CurrentUser() user: RequestUser) {
    const [rows, destinations] = await Promise.all([
      this.preferences.list(user.id),
      this.destinations(user),
    ]);
    const disabled = new Set(rows.filter((r) => !r.enabled).map((r) => `${r.type}:${r.channel}`));

    return {
      /*
        Whether each channel has anywhere to go.

        Reported here rather than left for the UI to infer from a profile, because this is the
        API that knows what a destination IS -- the account's own phone number, not a payload
        field, and an email that a provider may have told us is dead. A settings screen that
        offers a WhatsApp switch to somebody with no phone number is offering a switch that
        cannot work, and the honest thing is to say why and point at the fix.
      */
      destinations,
      types: CUSTOMER_TYPES.map((type) => {
        const policy = policyFor(type);
        return {
          type,
          urgency: policy.urgency,
          channels: policy.channels
            // The inbox is the notification centre itself, not a delivery preference. Showing
            // it as a toggle invites somebody to switch off the page they are looking at.
            .filter((c) => c !== 'in_app')
            .map((channel: ChannelKey) => ({
              channel,
              enabled: !disabled.has(`${type}:${channel}`),
              /*
                Required channels are reported, not hidden. A customer is entitled to know we
                will email them about their booking whatever they choose — and a switch that
                silently does nothing is the worse of the two ways to handle it.
              */
              required: policy.guaranteed.includes(channel),
              /*
                A channel policy holds back for a fallback is not something a customer opts
                into: it opens only when nothing else reached them. Marked so the UI can
                explain it rather than presenting it as an ordinary choice.
              */
              deferred: policy.fallback?.to === channel,
            })),
        };
      }),
    };
  }

  /**
   * Can each channel actually reach this person?
   *
   * `phone` is the authoritative account number — the same one the SMS and WhatsApp channels
   * resolve at send time — so the answer here is the answer there. `emailUsable` is false when
   * a provider has told us the address bounces: the customer can then see why their
   * confirmations stopped arriving, which is otherwise completely invisible to them.
   */
  private async destinations(user: RequestUser) {
    const account = await this.prisma.user
      .findUnique({ where: { id: user.id }, select: { phone: true, phoneVerifiedAt: true } })
      .catch(() => null);

    return {
      hasPhone: Boolean(account?.phone),
      /*
        Reported, not enforced. Holding a number and having proved you hold it are different
        facts, and only the second may sign you in — but somebody who typed their number into
        their profile and never finished verifying still wants their ticket, so this is
        information for the UI rather than a gate on delivery.
      */
      phoneVerified: Boolean(account?.phoneVerifiedAt),
      emailUsable: !(await this.suppression.isSuppressed('email', user.email)),
    };
  }

  @Put()
  @ApiOperation({ summary: 'Turn one channel on or off for one type of message.' })
  async update(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    /*
      A required channel is accepted and stored rather than refused.

      Refusing would mean an error message for a switch the UI should not have offered, and
      would lose the customer's stated wish entirely. Storing it keeps the record — if policy
      later stops guaranteeing that channel, their preference is already there and is honoured
      from that moment. The resolver is what enforces the floor, in one place, on every send.
    */
    await this.preferences.setPreference(user.id, body.type, body.channel, body.enabled);
    return this.get(user);
  }
}
