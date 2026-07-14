import { Body, Controller, Inject, Param, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { PaymentsService } from './payments.service';
import { PAYMENT_PROVIDER } from './provider/payment-provider.interface';
import type { PaymentProvider } from './provider/payment-provider.interface';
import { WebhookRouter } from './webhooks/webhook-router.service';
import { Public } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly webhookRouter: WebhookRouter,
  ) {}

  @Public()
  @Post(':bookingId/mock-pay')
  @ApiOperation({ summary: 'Simulate the provider completing a payment (mock).' })
  mockPay(
    @Param('bookingId') bookingId: string,
    @Body(
      new ZodValidationPipe(
        z.object({ outcome: z.enum(['succeeded', 'failed']).default('succeeded') }),
      ),
    )
    body: { outcome: 'succeeded' | 'failed' },
  ) {
    return this.payments.mockPay(bookingId, body.outcome);
  }

  @Public()
  @Post('webhook')
  @ApiOperation({ summary: 'Signed payment webhook (provider → platform).' })
  webhook(@Req() req: RawBodyRequest<Request>, @Body() body: unknown) {
    // Read the signature from the ACTIVE provider's header (mock →
    // x-payment-signature, stripe → stripe-signature, razorpay → x-razorpay-signature),
    // falling back to the mock header so existing behaviour is unchanged.
    const headerName = this.provider.webhookSignatureHeader ?? 'x-payment-signature';
    const signature = req.header(headerName) ?? '';
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body);
    return this.payments.handleWebhook({ rawBody, signature });
  }

  @Public()
  @Post('webhook/:provider')
  @ApiOperation({
    summary: 'Signed payment webhook routed to a named provider (multi-provider).',
  })
  routedWebhook(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
  ) {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body);
    // Pass all request headers (lower-cased by Node) so the router can assemble
    // whichever signature material the provider's verification scheme needs.
    const headers = req.headers as Record<string, string | undefined>;
    return this.webhookRouter.route(provider, rawBody, headers);
  }
}
