import { Body, Controller, Param, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { PaymentsService } from './payments.service';
import { Public } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

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
    const signature = req.header('x-payment-signature') ?? '';
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body);
    return this.payments.handleWebhook({ rawBody, signature });
  }
}
