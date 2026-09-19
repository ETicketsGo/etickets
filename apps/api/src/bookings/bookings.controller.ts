import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createBookingSchema,
  paginationSchema,
  quoteBookingSchema,
  type CreateBookingInput,
  type QuoteBookingInput,
} from '@eticketsgo/validation';
import { BookingsService } from './bookings.service';
import { BookingExecutionRouter } from './orchestration/booking-execution-router.service';
import { GuestBookingService } from './guest-booking.service';
import { CurrentUser, Public, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * What somebody may type into the "find my booking" form, and how often.
 *
 * ── WHY NOT THE GLOBAL LIMIT ───────────────────────────────────────────────────────
 * The global guard is 120 requests a minute, which is right for browsing and wrong for a form
 * that takes a reference and an address and either mails a credential or does not. At 120/min
 * somebody can walk a list of leaked addresses against a reference, or mail the same stranger
 * two thousand times an hour from one address. The route deliberately reveals nothing in its
 * response, and a rate that permits thousands of attempts makes the timing and the volume the
 * answer instead. So it gets the auth routes' allowance: enough for a person who mistypes their
 * reference twice, nowhere near enough to enumerate.
 *
 * Env-overridable ONLY so an e2e run that exercises the form several times in a minute does
 * not trip it. Production leaves it unset and keeps 10.
 */
const GUEST_LOOKUP_THROTTLE = {
  default: { limit: Number(process.env.AUTH_THROTTLE_LIMIT ?? 10), ttl: 60_000 },
};

const guestLookupSchema = z.object({
  reference: z.string().trim().min(1).max(60),
  email: z.string().trim().email().max(320),
});

/**
 * The second proof on a guest money/paperwork route: the address the booking was paid with.
 *
 * ── WHY `.trim()` IS BEFORE `.email()` AND NOT AFTER ───────────────────────────────
 * Because a trailing space makes `.email()` fail, and this address arrives from a clipboard on
 * a phone. Validated after trimming, it is a valid address and the route behaves as the person
 * expects. Case is left exactly as typed — `guestEmailMatches` lower-cases both sides when it
 * compares, and the comparison is the only place that may decide what counts as equal.
 */
export const guestProvenEmail = z.string().trim().email().max(320);

const guestProvenEmailSchema = z.object({
  email: guestProvenEmail,
  /** The language the page is in, when it knows. Falls back to `accept-language`. */
  locale: z.string().max(20).optional(),
});

const guestRefundSchema = z.object({
  email: guestProvenEmail,
  reason: z.string().trim().max(500).optional(),
});

const guestClaimSchema = z.object({
  /**
   * An emailed access token, for the buyer who is signing in on a different device from the one
   * that bought. The other accepted proof is the `x-anon-session` header.
   */
  accessToken: z.string().trim().max(200).optional(),
});

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

  @Post('quote')
  @Public()
  @ApiOperation({ summary: 'Price a cart without creating a booking or holding seats.' })
  quote(@Body(new ZodValidationPipe(quoteBookingSchema)) body: QuoteBookingInput) {
    return this.bookings.quote(body);
  }

  @Get('offers/:eventSessionId')
  @Public()
  @ApiOperation({ summary: 'Discount codes an organizer has published for this session.' })
  offers(@Param('eventSessionId') eventSessionId: string) {
    return this.bookings.publicOffers(eventSessionId);
  }

  @Post(':id/coupon')
  @ApiOperation({ summary: 'Apply or clear a discount code on an unpaid booking.' })
  applyCoupon(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ code: z.string().trim().max(60).nullable() })))
    body: { code: string | null },
  ) {
    return this.bookings.applyCoupon(user, id, body.code);
  }

  @Post(':id/extend-hold')
  @ApiOperation({ summary: 'Give the buyer more time on a hold that has not expired.' })
  extendHold(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    /*
      No body. WCAG 2.2.1 asks for a SIMPLE ACTION to extend a time limit — its own example
      is pressing the space bar — so this takes nothing to get wrong and nothing to validate.
    */
    return this.bookings.extendHold(user, id);
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
  constructor(
    private readonly router: BookingExecutionRouter,
    // Reading back a guest booking is not a mode-sensitive write, so it does not belong on the
    // execution router: it is its own authorisation story (a session token or an emailed link).
    private readonly guests: GuestBookingService,
  ) {}

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

  /*
    ── THE THREE WAYS BACK IN ────────────────────────────────────────────────────────
    A guest could pay and then had no way to reach the ticket: every read path wanted an
    account. These are the session still in the browser, a link emailed to the address that
    paid, and the request that mints a fresh link when both are gone.

    `guest/access/:token` cannot be mistaken for `guest/:id` and `guest/lookup` cannot be
    mistaken for `guest/:id/pay`: they differ in segment count, not in registration order.
  */

  @Public()
  @Post('guest/lookup')
  @Throttle(GUEST_LOOKUP_THROTTLE)
  @ApiOperation({
    summary: 'Email a fresh access link for a guest booking. Answers the same either way.',
  })
  lookupGuest(
    @Body(new ZodValidationPipe(guestLookupSchema)) body: { reference: string; email: string },
  ) {
    return this.guests.requestAccessLink(body);
  }

  @Public()
  @Get('guest/access/:token')
  @ApiOperation({ summary: 'Open a guest booking with an emailed access link.' })
  getGuestByAccessToken(@Param('token') token: string) {
    return this.guests.viewByAccessToken(token);
  }

  /*
    ── AND THE THREE THINGS A LINK ALONE IS NOT ENOUGH FOR ───────────────────────────
    The link is forwardable on purpose: it shows somebody where to sit, and the buyer's address
    is masked precisely so it does not show who bought the seat. That makes it the wrong and
    only credential for an invoice with the buyer's name on it, for a request that moves money
    off their card, and for attaching the booking to an account.

    So each of the two guest routes below asks for one more thing — the address the booking was
    PAID with, compared in constant time — and the claim route asks for a signed-in account plus
    a proof that the caller controls the booking. Both `receipt` and `refund` carry the lookup
    form's throttle: the address is the whole secret on those routes, and a route somebody can
    call a hundred times a minute is a route where two masked characters and a domain become a
    guessing game.
  */

  @Public()
  @Post('guest/access/:token/receipt')
  @Throttle(GUEST_LOOKUP_THROTTLE)
  @ApiOperation({
    summary: "A guest booking's receipts and invoices. Needs the address that paid.",
  })
  guestReceipts(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(guestProvenEmailSchema)) body: { email: string; locale?: string },
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.guests.receiptsByAccessToken(token, {
      email: body.email,
      locale: body.locale ?? null,
      acceptLanguage: acceptLanguage ?? null,
    });
  }

  @Public()
  @Post('guest/access/:token/refund')
  @Throttle(GUEST_LOOKUP_THROTTLE)
  @ApiOperation({
    summary: 'Request a refund on a guest booking. Needs the address that paid.',
  })
  guestRefund(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(guestRefundSchema)) body: { email: string; reason?: string },
  ) {
    return this.guests.requestRefundByAccessToken(token, body);
  }

  /*
    Authenticated, and the ONLY route on this controller that is. There is no `@Public()` here
    because the whole point is the account the booking is being attached to: without a signed-in
    caller there is no answer to "attached to whom", and a guest route that took a user id from
    a body would be a route for giving somebody else's tickets to yourself.
  */
  @Post('guest/:id/claim')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Attach a guest booking to the signed-in account (proof required).' })
  claimGuest(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(guestClaimSchema)) body: { accessToken?: string },
    @Headers('x-anon-session') anonymousToken?: string,
  ) {
    return this.guests.claim({
      bookingId: id,
      user,
      accessToken: body.accessToken ?? null,
      anonymousToken: anonymousToken ?? null,
    });
  }

  @Public()
  @Get('guest/:id')
  @ApiOperation({ summary: 'Read a guest booking (requires the guest checkout session).' })
  getGuest(@Param('id') id: string, @Headers('x-anon-session') anonymousToken?: string) {
    return this.guests.viewBySession(id, anonymousToken);
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
