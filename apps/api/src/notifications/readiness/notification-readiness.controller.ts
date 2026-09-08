import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, NotificationType, Role, SendKind } from '@eticketsgo/shared-types';
import { CurrentUser, RequiresAdmin, Roles, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { NotificationReadinessService } from './notification-readiness.service';
import { MarketCertificationService } from './market-certification.service';
import { NotificationDiagnosticsService } from './notification-diagnostics.service';
import { CertificationEvidenceService } from './certification-evidence.service';
import { TemplateReportService } from '../templates/template-report.service';
import { NotificationRateService } from '../cost/notification-rate.service';
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
const certifySchema = z.object({
  provider: z.string().trim().min(1).max(40),
  channel: z.enum(['email', 'sms', 'whatsapp', 'push']),
  market: z.string().trim().min(1).max(8),
  /** A ticket reference or what was checked. Never a credential -- see the model comment. */
  notes: z.string().trim().max(1000).optional(),
});

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
    private readonly diagnostics: NotificationDiagnosticsService,
    private readonly evidence: CertificationEvidenceService,
    private readonly templates: TemplateReportService,
    private readonly rates: NotificationRateService,
  ) {}

  @Get('configuration')
  @RequiresAdmin(AdminPermission.OPS_READ)
  @ApiOperation({
    summary:
      'Per market/channel/provider: config, template, webhook, rate and certification state. ' +
      'Never returns secrets.',
  })
  configuration() {
    return this.diagnostics.report();
  }

  @Get('templates/sms')
  @RequiresAdmin(AdminPermission.OPS_READ)
  @ApiOperation({
    summary:
      'Rendered length, encoding and segment count per SMS template — what a DLT submission ' +
      'will cost to send, before it is submitted.',
  })
  smsTemplates(@Query('locales') locales?: string) {
    const list = locales
      ? locales
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean)
      : undefined;
    return this.templates.smsReport(list);
  }

  @Get('templates/whatsapp')
  @RequiresAdmin(AdminPermission.OPS_READ)
  @ApiOperation({
    summary: 'Which WhatsApp templates need approval, their variables, consent and rate state.',
  })
  whatsAppTemplates() {
    /*
      The rate lookup is injected rather than done inside the report, so the report stays a
      pure function of policy and bindings and can be unit-tested without a database.
    */
    return this.templates.whatsAppReport((provider) =>
      this.rates.hasActiveRate(provider, 'whatsapp'),
    );
  }

  @Get('certifications')
  @RequiresAdmin(AdminPermission.OPS_READ)
  @ApiOperation({ summary: 'The certification record per provider/channel/market.' })
  certifications() {
    return this.evidence.list();
  }

  /**
   * A person asserts that a provider has been proven to work.
   *
   * `PLATFORM_CONFIG` and audited, because this is the record other people will rely on when
   * deciding to open a market. It still refuses without delivery evidence -- an assertion is
   * necessary and never sufficient.
   */
  @Post('certifications')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: 'Certify a provider/channel/market. Requires real delivery evidence.' })
  recordCertification(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(certifySchema)) body: z.infer<typeof certifySchema>,
  ) {
    return this.evidence.certify(
      user.id,
      { provider: body.provider, channel: body.channel, market: body.market },
      body.notes,
    );
  }

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
