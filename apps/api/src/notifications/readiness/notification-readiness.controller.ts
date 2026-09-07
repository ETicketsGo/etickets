import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, NotificationType, Role, SendKind } from '@eticketsgo/shared-types';
import { CurrentUser, RequiresAdmin, Roles, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { NotificationReadinessService } from './notification-readiness.service';
import { MarketCertificationService } from './market-certification.service';
import { NotificationService } from '../notification.service';
import { AuditService } from '../../audit/audit.service';

/**
 * A test send.
 *
 * ── WHY THE DESTINATION IS EXPLICIT AND NOT A CUSTOMER ─────────────────────────────
 * The obvious way to test a channel is to resend a real booking's confirmation, and it is the
 * wrong way twice over: it messages somebody who did not ask to be a test subject, and it
 * makes their delivery history contain an event that never really happened to them. So a test
 * send names its own destination, and the operator types it.
 */
const testSendSchema = z.object({
  channel: z.enum(['email', 'sms', 'whatsapp', 'push']),
  /** An address or E.164 number the operator controls. Never resolved from a customer. */
  to: z.string().trim().min(3).max(200),
  market: z.string().trim().max(40).optional(),
});

/**
 * Whether the platform can send, and a controlled way to prove it.
 *
 * ── WHY READINESS IS `OPS_READ` AND A TEST SEND IS `PLATFORM_CONFIG` ───────────────
 * Reading configuration state is operational; spending money and putting a message on
 * somebody's phone is not. The split follows the one already drawn for resends and
 * suppression lifts.
 */
@ApiTags('admin:notifications')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.OPS_READ)
@Controller('admin/notifications/readiness')
export class NotificationReadinessController {
  constructor(
    private readonly readiness: NotificationReadinessService,
    private readonly certification: MarketCertificationService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Per-market provider, rate and callback configuration. Never returns secrets.',
  })
  report(@Query('markets') markets?: string) {
    const list = markets
      ? markets
          .split(',')
          .map((m) => m.trim().toUpperCase())
          .filter(Boolean)
      : undefined;
    return this.readiness.report(list);
  }

  @Get('certification')
  @ApiOperation({
    summary: 'Per-market certification, judged on delivery evidence rather than on configuration.',
  })
  certify(@Query('markets') markets?: string) {
    const list = markets
      ? markets
          .split(',')
          .map((m) => m.trim().toUpperCase())
          .filter(Boolean)
      : undefined;
    return this.certification.report(list);
  }

  @Post('test-send')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: 'Send one test message to a destination the operator names. Audited.' })
  async testSend(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(testSendSchema)) body: z.infer<typeof testSendSchema>,
  ) {
    /*
      A real send through the real path — the same policy, the same suppression check, the
      same provider routing, the same cost record. A test that bypassed any of those would
      prove the bypass works rather than the platform.

      It goes out as PASSWORD_CHANGED because that type is transactional, customer-directed,
      and permitted on every channel a test might want; inventing a TEST notification type
      would mean a template, a policy row and a classification for something no customer will
      ever receive.
    */
    await this.notifications.send({
      type: NotificationType.PASSWORD_CHANGED,
      userId: null,
      toEmail: body.channel === 'email' ? body.to : null,
      // Named by the operator, and only reachable because there is no account to be
      // authoritative about — the same door the sign-in code path uses.
      payload: { phone: body.channel === 'email' ? undefined : body.to, test: true },
      channels: [body.channel],
      country: body.market,
      /*
        TEST, not MANUAL_RESEND. A resend is support acting for a real customer about a real
        booking; this is an engineer proving a provider works, to a destination they own.
        Filed as a resend, every certification run would inflate the support figure and a
        quiet month of testing would read as a support incident.

        The COST is still counted -- a WhatsApp test in India is real money -- it is the
        attribution that would be wrong.
      */
      sendReason: SendKind.TEST,
      intentKey: `admin-test:${user.id}:${body.channel}:${Date.now()}`,
    });

    await this.audit.record({
      actorUserId: user.id,
      action: 'NOTIFICATION_TEST_SEND',
      entityType: 'Notification',
      entityId: body.channel,
      // The destination is deliberately NOT recorded in full: an audit row is long-lived and
      // widely readable, and the operator already knows what they typed.
      metadata: { channel: body.channel, market: body.market ?? null },
    });

    return { queued: true, channel: body.channel };
  }
}
