import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createBookingSchema,
  paginationSchema,
  type CreateBookingInput,
} from '@eticketsgo/validation';
import { BookingsService } from './bookings.service';
import { PaymentsService } from '../payments/payments.service';
import { CurrentUser, Public, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly payments: PaymentsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a booking with a time-limited inventory hold.' })
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createBookingSchema)) body: CreateBookingInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.bookings.create(user, body, idempotencyKey);
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
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.bookings.getForUser(user, id);
  }

  @Post(':id/pay')
  @ApiOperation({ summary: 'Create a payment intent for a booking.' })
  pay(@Param('id') id: string) {
    return this.payments.createIntent(id);
  }
}

@ApiTags('bookings')
@Controller('bookings')
export class GuestBookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Public()
  @Post('guest')
  @ApiOperation({ summary: 'Create a guest booking (no account required).' })
  createGuest(@Body(new ZodValidationPipe(createBookingSchema)) body: CreateBookingInput) {
    return this.bookings.create(null, body);
  }
}
