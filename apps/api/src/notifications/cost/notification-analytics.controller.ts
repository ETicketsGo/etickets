import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, BillingUnit, Role } from '@eticketsgo/shared-types';
import { RequiresAdmin, Roles } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  NotificationAnalyticsService,
  type AnalyticsWindow,
} from './notification-analytics.service';
import { NotificationRateService } from './notification-rate.service';

/**
 * A rate, as an operator writes one.
 *
 * ── WHY THE PRICE IS IN MICROS AND SAYS SO ─────────────────────────────────────────
 * Because the alternative is somebody typing 0.0001 into a field and a float turning it into
 * 0.00009999999999999999. The unit is stated in the field name so a number entered here
 * cannot be mistaken for cents — which, for SES at a hundredth of a cent per email, would be
 * out by a factor of ten thousand.
 */
const rateSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  channel: z.enum(['email', 'sms', 'whatsapp', 'push', 'in_app']),
  country: z.string().trim().max(40).optional(),
  category: z.string().trim().max(40).optional(),
  /** Millionths of one currency unit. 100 = $0.0001. Integer; never a decimal. */
  unitPriceMicro: z.number().int().min(0),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code.'),
  billingUnit: z.enum([
    'PER_MESSAGE',
    'PER_SEGMENT',
    'PER_CONVERSATION',
    'PER_TEMPLATE_MESSAGE',
    'PER_1000',
    'PER_REQUEST',
  ]),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().nullable().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  /** Written inactive by default: a rate is reviewed before it applies to money. */
  active: z.boolean().optional(),
  source: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(1000).optional(),
});

/**
 * Notification cost and provider-health reporting.
 *
 * ── WHY THIS SITS ON THE EXISTING ADMIN SURFACE ────────────────────────────────────
 * It is the same audience, the same RBAC and the same conventions as the delivery ops
 * endpoints beside it. A separate analytics domain would mean a second permission model to
 * keep in step and a second place to look when a number disagrees with the operational view.
 *
 * Reads need `FINANCE_READ` — this is money, and the existing permission for "see revenue,
 * settlements, payouts and reconciliation" is exactly the right audience. Writing a RATE is
 * `PLATFORM_CONFIG`, because a number entered here reprices every message that follows it.
 *
 * Nothing here returns a destination, a payload or a message body. A cost report is about
 * aggregates; it has no business carrying somebody's phone number.
 */
@ApiTags('admin:notifications')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.FINANCE_READ)
@Controller('admin/notifications/analytics')
export class NotificationAnalyticsController {
  constructor(
    private readonly analytics: NotificationAnalyticsService,
    private readonly rates: NotificationRateService,
  ) {}

  private window(q: Record<string, string | undefined>): AnalyticsWindow {
    /*
      Thirty days by default. An unbounded window on a table that grows with every message is
      the difference between a report and an incident, and a caller who wants a year should
      have to say so.
    */
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
    return {
      from,
      to,
      provider: q.provider,
      channel: q.channel,
      eventType: q.eventType,
      country: q.country,
      organizationId: q.tenant,
    };
  }

  @Get('summary')
  @ApiOperation({ summary: 'Attempts, outcomes and cost per currency for a window.' })
  summary(@Query() q: Record<string, string | undefined>) {
    return this.analytics.summary(this.window(q));
  }

  @Get('costs')
  @ApiOperation({ summary: 'Cost by provider, channel, send kind, country or event.' })
  async costs(@Query() q: Record<string, string | undefined>) {
    const w = this.window(q);
    const by = q.by ?? 'provider';
    if (by === 'country') return this.analytics.byCountry(w);
    if (by === 'event') return this.analytics.byEvent(w);
    if (by === 'booking') return this.analytics.costPerBooking(w);
    return this.analytics.costs(
      w,
      by === 'channel' ? 'channel' : by === 'sendKind' ? 'sendKind' : 'provider',
    );
  }

  @Get('providers')
  @ApiOperation({ summary: 'Provider health, over denominators that are only the provider.' })
  providers(@Query() q: Record<string, string | undefined>) {
    return this.analytics.providerHealth(this.window(q));
  }

  @Get('events')
  @ApiOperation({ summary: 'Which notification types drive the spend, split by send kind.' })
  events(@Query() q: Record<string, string | undefined>) {
    return this.analytics.byEvent(this.window(q));
  }

  @Get('rates')
  @ApiOperation({ summary: 'Configured provider rates, current and superseded.' })
  listRates(@Query() q: Record<string, string | undefined>) {
    return this.rates.list({
      provider: q.provider,
      channel: q.channel,
      activeOnly: q.active === 'true',
    });
  }

  @Post('rates')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: 'Record a provider rate. Refuses an overlapping active period.' })
  createRate(@Body(new ZodValidationPipe(rateSchema)) body: z.infer<typeof rateSchema>) {
    return this.rates.create({ ...body, billingUnit: body.billingUnit as BillingUnit });
  }

  @Post('rates/:id/supersede')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: 'End a rate now. Never a delete — past reports stay reproducible.' })
  supersede(@Query('id') id: string, @Body() body: { at?: string } = {}) {
    return this.rates.supersede(id, body?.at ? new Date(body.at) : new Date());
  }
}
