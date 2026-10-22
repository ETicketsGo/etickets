import { z } from 'zod';
import { isReservedEmail } from '@eticketsgo/shared-types';
import { Body, Controller, Get, Optional, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  registerSchema,
  resetPasswordSchema,
  type LoginInput,
  type RefreshInput,
  type ForgotPasswordInput,
  type RegisterInput,
  type ResetPasswordInput,
} from '@eticketsgo/validation';
import { AuthService } from './auth.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PhoneOtpService } from './phone-otp.service';

/*
  Kept loose on purpose: `normalisePhone` is the authority on what a number is, and a second
  pattern here would be a second place to be wrong about it — and the one that rejects a real
  customer before the real validator ever sees their number.
*/
const phoneRequestSchema = z.object({ phone: z.string().trim().min(6).max(20) });
const phoneVerifySchema = z.object({
  phone: z.string().trim().min(6).max(20),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'The code is six digits.'),
  /*
    Sign-UP by mobile sends what the email form sends: a name and, for a US number, the
    text-message agreement. Both optional, so sign-IN is the same request it always was.

    The name is applied only to an account that has none (see `applyPhoneSignup`) - typing a
    name on the sign-up tab with a number that already has an account must not rename it.
  */
  fullName: z.string().trim().min(2, 'Please enter your name.').max(120).optional(),
  smsConsent: z.literal(true).optional(),
  /** The market whose disclosure was shown. The VERSION is resolved server-side. */
  country: z.string().trim().max(40).optional(),
});
type PhoneVerifyBody = z.infer<typeof phoneVerifySchema>;
import { AllowMfaPending, CurrentUser, Public, type RequestUser } from '../common/decorators';
import { AUTH_THROTTLE } from '../common/throttle';
import { RequiresHumanCheck } from '../human-check/human-check.guard';
import { clientIpFor, requestClientIp, resolveClientIpHeader } from '../common/client-ip';

/*
  The CLIENT's address, not `req.ip`: behind Railway `req.ip` is the edge node, so every audit row
  and every session row named one of a handful of proxies (see common/client-ip.ts).
*/
function meta(req: Request) {
  return { userAgent: req.header('user-agent') ?? undefined, ip: requestClientIp(req) };
}

/*
  The address a sign-in code request is recorded against (`PhoneOtp.requestedIp`, kept for
  abuse investigation). It used to be `req.ip`, which behind Railway is the EDGE NODE that
  carried the request, so every row named one of a handful of Railway proxies and an
  investigation could not tell one attacker from ten thousand customers. The throttler had
  already been moved to `clientIpFor` for the same reason; this records what it counts.

  A function rather than a method so it is not mistaken for a route handler (auth-throttle.spec
  enumerates the controller's prototype).
*/
export function requesterIp(req: Request, header: string | null): string {
  return clientIpFor(req, header);
}

/*
  Every credential route below carries AUTH_THROTTLE (10 a minute per client, per route) on top
  of the global 120 a minute. Defined once in common/throttle.ts, with the MFA routes, so the
  two controllers cannot drift apart.
*/

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  /** The trusted client-IP header, decided once at boot exactly as the throttler decides it. */
  private readonly clientIpHeader: string | null;

  constructor(
    private readonly auth: AuthService,
    private readonly otp: PhoneOtpService,
    @Optional() config?: ConfigService,
  ) {
    this.clientIpHeader = resolveClientIpHeader({
      THROTTLE_CLIENT_IP_HEADER: config?.get<string>('THROTTLE_CLIENT_IP_HEADER'),
      RAILWAY_ENVIRONMENT_ID: process.env.RAILWAY_ENVIRONMENT_ID,
    });
  }

  /*
    Phone sign-in, in two steps.

    Throttled like every other credential route, and rate-limited a second time PER NUMBER
    inside the service — the edge throttle counts requests from one caller, which is the
    wrong unit when the cost of the request is somebody else's SMS bill.
  */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @RequiresHumanCheck('otp')
  @Post('phone/request-code')
  @ApiOperation({ summary: 'Send a one-time sign-in code to a mobile number.' })
  requestPhoneCode(
    @Body(new ZodValidationPipe(phoneRequestSchema)) body: { phone: string },
    @Req() req: Request,
  ) {
    return this.otp.requestCode(body.phone, requesterIp(req, this.clientIpHeader));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('phone/verify')
  @ApiOperation({ summary: 'Exchange a one-time code for a session, creating the account if new.' })
  async verifyPhoneCode(
    @Body(new ZodValidationPipe(phoneVerifySchema)) body: PhoneVerifyBody,
    @Req() req: Request,
  ) {
    const { id, isNewAccount } = await this.otp.verifyCode(body.phone, body.code);
    /*
      AFTER the code is proven and BEFORE the session is minted: the access token carries the
      name, so applying it afterwards would leave a brand-new account nameless until its first
      refresh. Nothing here runs for a wrong code - `verifyCode` has already thrown.
    */
    await this.auth.applyPhoneSignup(id, {
      fullName: body.fullName,
      smsConsent: body.smsConsent,
      country: body.country,
    });
    const tokens = await this.auth.completePhoneSignIn(id, meta(req));
    // The client uses this to decide whether to ask for a name — a brand-new account has
    // none, and asking an existing customer again would be rude. (A back-office account gets a
    // second-factor challenge here instead of tokens, exactly as on the password route.)
    return { ...tokens, isNewAccount };
  }

  /*
    Adding a number to an account somebody is already signed into.

    Separate from the two routes above, which are `@Public()` and exist to CREATE a session.
    These require one: the account is known from the token, never from the body, so nobody can
    attach a number to an account that is not theirs by naming it.

    Throttled the same way, because the cost of the request is still somebody else's SMS bill.
  */
  @Throttle(AUTH_THROTTLE)
  @RequiresHumanCheck('otp')
  @Post('phone/attach/request-code')
  @ApiOperation({ summary: 'Send a code to a number the signed-in customer wants to add.' })
  requestAttachCode(
    // No @CurrentUser: the account is not needed to SEND a code, only to attach one, and an
    // unused parameter reads as though it were being checked. What makes this route safe is
    // the absence of @Public() - a caller with no session never reaches it.
    @Body(new ZodValidationPipe(phoneRequestSchema)) body: { phone: string },
    @Req() req: Request,
  ) {
    return this.otp.requestCode(body.phone, requesterIp(req, this.clientIpHeader));
  }

  @Throttle(AUTH_THROTTLE)
  @Post('phone/attach/verify')
  @ApiOperation({ summary: 'Prove the code and attach the number to the signed-in account.' })
  attachPhone(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(phoneVerifySchema)) body: { phone: string; code: string },
  ) {
    return this.otp.attachToAccount(user.id, body.phone, body.code);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @RequiresHumanCheck('register')
  @Post('register')
  @ApiOperation({ summary: 'Register a new customer account.' })
  register(@Body(new ZodValidationPipe(registerSchema)) body: RegisterInput, @Req() req: Request) {
    return this.auth.register(body, meta(req));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @RequiresHumanCheck('login')
  @Post('login')
  @ApiOperation({ summary: 'Authenticate and receive access + refresh tokens.' })
  login(@Body(new ZodValidationPipe(loginSchema)) body: LoginInput, @Req() req: Request) {
    return this.auth.login(body, meta(req));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('refresh')
  @ApiOperation({ summary: 'Rotate a refresh token for a new token pair.' })
  refresh(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput, @Req() req: Request) {
    return this.auth.refresh(body.refreshToken, meta(req));
  }

  /*
    Throttled like every other credential route. Reset is the one endpoint an attacker can
    call about somebody ELSE'S address, so the rate limit is doing security work here rather
    than merely protecting capacity.
  */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @RequiresHumanCheck('password_reset')
  @Post('forgot-password')
  @ApiOperation({
    summary: 'Request a password reset link. Always answers the same, known address or not.',
  })
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordSchema)) body: ForgotPasswordInput,
    @Req() req: Request,
  ) {
    await this.auth.requestPasswordReset(body.email, meta(req));
    /*
      One fixed reply. Anything that varied — a different message, a different status, even a
      noticeably different response time — would turn this into an account-enumeration oracle.
    */
    return { message: 'If that address has an account, a reset link is on its way.' };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('reset-password')
  @ApiOperation({ summary: 'Set a new password with a reset token, and end every session.' })
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordInput,
    @Req() req: Request,
  ) {
    await this.auth.resetPassword(body.token, body.password, meta(req));
    return { success: true };
  }

  @Public()
  @Post('logout')
  @ApiOperation({ summary: 'Revoke a refresh token.' })
  async logout(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput) {
    await this.auth.logout(body.refreshToken);
    return { success: true };
  }

  /*
    "Sign out everywhere": every refresh token this account holds, on every device, is revoked.

    Needs a valid access token, and the account is taken from it - never from the body - so
    nobody can sign somebody else out. Access tokens already issued are not revocable (they are
    stateless) and run out within JWT_ACCESS_TTL, 15 minutes by default; no device can renew one.
  */
  @ApiBearerAuth()
  @Post('logout-all')
  @ApiOperation({ summary: 'Sign out on every device: end every session this account has.' })
  async logoutAll(@CurrentUser() user: RequestUser, @Req() req: Request) {
    const revoked = await this.auth.logoutAll(user.id, meta(req));
    return { success: true, revoked };
  }

  @ApiBearerAuth()
  // A back-office session that has not passed MFA still has to learn that, to be sent to enrollment.
  @AllowMfaPending()
  @Get('me')
  @ApiOperation({ summary: 'Return the currently authenticated user.' })
  async me(@CurrentUser() user: RequestUser) {
    /*
      ── WHY THE LAST BUYER REGION TRAVELS WITH THE PROFILE ─────────────────────────
      Indian checkout asks which state the buyer is in, to state the place of supply on the
      invoice. It is optional and it does not change what anybody pays — and it was asked on
      every single purchase, of a customer who had already answered it.

      A question you have already answered, asked again, reads as a form that is not paying
      attention. So the last answer comes back with the profile and prefills the field, which
      stays editable because people move and buy for other people.

      Derived from the most recent booking rather than stored on the User: it is not a fact
      about the person, it is what they said last time. Putting it on the profile would make
      it look like a setting, and settings imply the platform will keep using it — which is
      exactly the promise a place-of-supply field should not make.
    */
    const [lastBuyerRegion, details, permissions] = await Promise.all([
      this.auth.lastBuyerRegion(user.id),
      this.auth.accountDetails(user.id),
      /*
        What this operator may do, so the back office can offer them their own work rather
        than every operator the same twenty-four menu items and a landing page that refuses
        them. It describes what to OFFER; every route still enforces its own guard.
      */
      this.auth.myAdminPermissions(user.id, user.roles),
    ]);
    /*
      A phone-only account's address is a placeholder, never contact information. It is not
      sent to the browser at all, so no screen can show it, prefill a form with it, or put it on
      a booking - `email: null` is the honest answer: this account has no email address yet.
    */
    // A back-office session that has not passed the second factor is told what it is (so the
    // console can send it to enrollment) but not what the account may do.
    const unverifiedStaff = Boolean(user.mfa?.required && !user.mfa.verified);
    return {
      ...user,
      email: isReservedEmail(user.email) ? null : user.email,
      lastBuyerRegion,
      ...details,
      ...permissions,
      ...(unverifiedStaff ? { adminPermissions: [] } : {}),
    };
  }
}
