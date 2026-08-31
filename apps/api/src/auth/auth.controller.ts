import { Body, Controller, Get, Post, Req } from '@nestjs/common';
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
import { CurrentUser, Public, type RequestUser } from '../common/decorators';

function meta(req: Request) {
  return { userAgent: req.header('user-agent') ?? undefined, ip: req.ip };
}

/**
 * Tight per-route throttle for credential/token endpoints. The global guard is
 * 120 req/60s (fine for general browsing); auth endpoints are brute-force and
 * token-replay targets, so they get 10 req/60s per client. Well above what any
 * legitimate login/refresh flow (or the e2e suite's handful of logins) needs.
 */
// Production default is 10/min per IP (brute-force protection). The limit is
// env-overridable ONLY so a login-heavy local/e2e run (many suites in one minute)
// doesn't trip it — production leaves AUTH_THROTTLE_LIMIT unset and keeps 10.
const AUTH_THROTTLE = {
  default: { limit: Number(process.env.AUTH_THROTTLE_LIMIT ?? 10), ttl: 60_000 },
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('register')
  @ApiOperation({ summary: 'Register a new customer account.' })
  register(@Body(new ZodValidationPipe(registerSchema)) body: RegisterInput, @Req() req: Request) {
    return this.auth.register(body, meta(req));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
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

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Return the currently authenticated user.' })
  me(@CurrentUser() user: RequestUser) {
    return user;
  }
}
