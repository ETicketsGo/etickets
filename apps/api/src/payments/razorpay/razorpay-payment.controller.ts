import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { razorpayVerifySchema, type RazorpayVerifyInput } from '@eticketsgo/validation';
import { RazorpayOrderService } from './razorpay-order.service';
import { CurrentUser, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('bookings/:bookingId/payments/razorpay')
export class RazorpayPaymentController {
  constructor(private readonly orders: RazorpayOrderService) {}

  @Post('verify')
  @ApiOperation({
    summary: 'Verify a Razorpay Checkout signature (synchronous integrity check).',
    description:
      'Verifies order/payment signature and records the attempt. Does NOT issue tickets — ' +
      'the signed webhook is the authoritative confirmation.',
  })
  verify(
    @CurrentUser() user: RequestUser,
    @Param('bookingId') bookingId: string,
    @Body(new ZodValidationPipe(razorpayVerifySchema)) body: RazorpayVerifyInput,
  ) {
    return this.orders.verify(bookingId, body, user);
  }
}
