import { Controller, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RazorpayWebhookService } from './razorpay-webhook.service';
import { Public } from '../../common/decorators';

/**
 * Dedicated Razorpay webhook endpoint. Public (Razorpay is unauthenticated) but every
 * event is HMAC-verified against the raw body (X-Razorpay-Signature) before acceptance.
 */
@ApiTags('payments')
@Controller('payments/webhooks')
export class RazorpayWebhookController {
  constructor(private readonly webhooks: RazorpayWebhookService) {}

  @Public()
  @Post('razorpay')
  @ApiOperation({ summary: 'Signed Razorpay webhook (durable, idempotent, async).' })
  async razorpay(@Req() req: RawBodyRequest<Request>) {
    // Razorpay signs the EXACT raw bytes.
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    const signature = req.header('x-razorpay-signature') ?? '';
    const eventId = req.header('x-razorpay-event-id') ?? undefined;
    return this.webhooks.ingest(rawBody, signature, eventId);
  }
}
