import { Body, Controller, Inject, Param, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { PaymentsService } from './payments.service';
import { PAYMENT_PROVIDER } from './provider/payment-provider.interface';
import type { PaymentProvider } from './provider/payment-provider.interface';
import { WebhookRouter } from './webhooks/webhook-router.service';
import { CurrentUser, Public, Roles, type RequestUser } from '../common/decorators';
import { Role } from '@eticketsgo/shared-types';
import { OrgAccessService } from '../tenancy/org-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { HttpStatus } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly webhookRouter: WebhookRouter,
    private readonly access: OrgAccessService,
    private readonly prisma: PrismaService,
  ) {}

  /*
    Taking the money at the counter.

    Open to CHECKIN_STAFF as well as owners and managers, because at a single-screen cinema
    the person on the door IS the person with the cash tin. Membership of the booking's own
    organization is asserted separately — a role alone would let staff at one venue confirm
    another venue's takings.
  */
  @Roles(
    Role.ORGANIZER_OWNER,
    Role.ORGANIZER_MANAGER,
    Role.CHECKIN_STAFF,
    Role.ADMIN,
    Role.SUPER_ADMIN,
  )
  @Post(':bookingId/collect-cash')
  @ApiOperation({ summary: 'Record cash handed over at the venue, and confirm the booking.' })
  async collectCash(@CurrentUser() user: RequestUser, @Param('bookingId') bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { organizationId: true },
    });
    if (!booking) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, booking.organizationId);
    return this.payments.collectCash(bookingId, user.id);
  }

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
