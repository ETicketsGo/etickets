import { Controller, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { StripeWebhookService } from './stripe-webhook.service';
import { Public } from '../../../common/decorators';

/**
 * Dedicated Stripe webhook endpoint. Public (Stripe is unauthenticated) but every
 * event is signature-verified against the raw body before acceptance.
 */
@ApiTags('payments')
@Controller('payments/webhooks')
export class StripeWebhookController {
  constructor(private readonly webhooks: StripeWebhookService) {}

  @Public()
  @Post('stripe')
  @ApiOperation({ summary: 'Signed Stripe webhook (durable, idempotent, async).' })
  async stripe(@Req() req: RawBodyRequest<Request>) {
    // Stripe requires the EXACT raw bytes for signature verification.
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    const signature = req.header('stripe-signature') ?? '';
    return this.webhooks.ingest(rawBody, signature);
  }
}
