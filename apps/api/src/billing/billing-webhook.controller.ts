import { Controller, HttpCode, HttpStatus, Logger, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators';
import { AppException, ErrorCodes } from '../common/errors';
import { BillingProviderEventService } from './billing-provider-events.service';
import { BillingProviderRegistry } from './provider/billing-provider.registry';
import { BILLING_NOT_ENABLED_MESSAGE, type BillingProviderKey } from './provider/billing-provider';

/**
 * Billing webhooks, one endpoint per provider, apart from the ticket payment webhooks
 * (`payments/webhooks/*`) and with their OWN signing secrets (STRIPE_BILLING_WEBHOOK_SECRET,
 * RAZORPAY_BILLING_WEBHOOK_SECRET). A ticket event can never verify here, and a billing event
 * can never verify on the ticket endpoints.
 *
 * Public (providers do not authenticate) but every delivery is verified against the EXACT raw
 * bytes before anything is stored; a bad signature is a 400 and leaves no row. Not throttled,
 * like the ticket webhooks: the signature authenticates, not a request rate.
 *
 * Answers 200 for anything verified - applied, ignored, refused for a reason (recorded FAILED
 * for staff) or deferred for a retry by the worker - so the provider does not hammer a delivery
 * whose outcome a retry cannot change.
 */
@ApiTags('billing')
@SkipThrottle()
@Controller('billing/webhooks')
export class BillingWebhookController {
  private readonly logger = new Logger('BillingWebhooks');

  constructor(
    private readonly registry: BillingProviderRegistry,
    private readonly events: BillingProviderEventService,
  ) {}

  @Public()
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Signed Stripe Billing webhook (organizer plans and credit packs).' })
  stripe(@Req() req: RawBodyRequest<Request>) {
    return this.handle('STRIPE_BILLING', req, ['stripe-signature']);
  }

  @Public()
  @Post('razorpay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Signed Razorpay Subscriptions webhook (organizer plans and packs).' })
  razorpay(@Req() req: RawBodyRequest<Request>) {
    return this.handle('RAZORPAY_BILLING', req, ['x-razorpay-signature', 'x-razorpay-event-id']);
  }

  private async handle(key: BillingProviderKey, req: RawBodyRequest<Request>, names: string[]) {
    const provider = await this.registry.byKey(key);
    if (!provider.enabled || provider.key !== key) {
      throw new AppException(
        ErrorCodes.BILLING_NOT_ENABLED,
        BILLING_NOT_ENABLED_MESSAGE,
        HttpStatus.CONFLICT,
      );
    }
    // The provider signs the exact bytes it sent; a re-serialised body would never verify.
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    const headers = Object.fromEntries(names.map((n) => [n, req.header(n) ?? undefined]));
    let event;
    try {
      event = await provider.verifyWebhook(rawBody, headers);
    } catch (err) {
      this.logger.error(
        `REJECTED a ${key} webhook (${rawBody.length} bytes): the signature did not verify. ` +
          'Check that the billing webhook secret matches the one this endpoint was given.',
      );
      throw err;
    }
    const result = await this.events.receive(provider, event);
    return { received: true, ...result };
  }
}
