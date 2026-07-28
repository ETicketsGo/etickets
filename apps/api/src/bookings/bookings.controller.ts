import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createBookingSchema,
  paginationSchema,
  type CreateBookingInput,
} from '@eticketsgo/validation';
import { BookingsService } from './bookings.service';
import { BookingExecutionRouter } from './orchestration/booking-execution-router.service';
import { CurrentUser, Public, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('bookings')
export class BookingsController {
  constructor(
    // Legacy read paths (list) stay on the service directly. All mode-sensitive write/read
    // operations route through the single BookingExecutionRouter (ADR-042 §2).
    private readonly bookings: BookingsService,
    private readonly router: BookingExecutionRouter,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a booking with a time-limited inventory hold.' })
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createBookingSchema)) body: CreateBookingInput,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.router.initiate({ user, body, idempotencyKey, correlationId });
  }

  @Get()
  @ApiOperation({ summary: 'List the current user’s bookings.' })
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(paginationSchema)) q: { page: number; pageSize: number },
  ) {
    return this.bookings.listForUser(user, q.page, q.pageSize);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a booking (owner or admin).' })
  get(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.router.getStatus({ user, bookingId: id, correlationId });
  }

  @Post(':id/pay')
  @ApiOperation({ summary: 'Create a payment intent for a booking (owner only).' })
  pay(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Headers('x-anon-session') anonymousToken?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.router.beginPayment({ user, bookingId: id, anonymousToken, correlationId });
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel an unpaid booking (owner only; paid → refund path).' })
  cancel(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Headers('x-anon-session') anonymousToken?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.router.cancel({ user, bookingId: id, anonymousToken, correlationId });
  }
}

@ApiTags('bookings')
@Controller('bookings')
export class GuestBookingsController {
  constructor(private readonly router: BookingExecutionRouter) {}

  @Public()
  @Post('guest')
  @ApiOperation({ summary: 'Create a guest booking (no account required).' })
  createGuest(
    @Body(new ZodValidationPipe(createBookingSchema)) body: CreateBookingInput,
    @Headers('x-anon-session') anonymousToken?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    // Anonymous ownership: in active mode the router issues a server-side session token
    // when the guest presents none, and returns it once as `anonymousSessionToken`.
    return this.router.initiate({ user: null, body, anonymousToken, correlationId });
  }

  @Public()
  @Post('guest/:id/pay')
  @ApiOperation({
    summary: 'Create a payment intent for a guest booking (requires the guest session).',
  })
  payGuest(
    @Param('id') id: string,
    @Headers('x-anon-session') anonymousToken?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    // Owner-safe guest payment: the anonymous session token is mandatory and validated
    // against the durable workflow owner (active mode). Server routes provider/amount/
    // currency — none is accepted from the client.
    return this.router.beginPayment({
      user: null,
      bookingId: id,
      anonymousToken,
      correlationId,
      requireAnonymousToken: true,
    });
  }

  @Public()
  @Post('guest/:id/cancel')
  @ApiOperation({ summary: 'Cancel an unpaid guest booking (requires the guest session).' })
  cancelGuest(
    @Param('id') id: string,
    @Headers('x-anon-session') anonymousToken?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.router.cancel({ user: null, bookingId: id, anonymousToken, correlationId });
  }
}
