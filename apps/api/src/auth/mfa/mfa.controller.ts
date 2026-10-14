import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService } from '../auth.service';
import { MfaService } from './mfa.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  AllowMfaPending,
  CurrentUser,
  Public,
  RequiresRecentMfa,
  type RequestUser,
} from '../../common/decorators';
import { AppException, ErrorCodes } from '../../common/errors';
import { AUTH_THROTTLE } from '../../common/throttle';

const code = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'The code is six digits.');
const recoveryCode = z.string().trim().min(10).max(14);

/** Exactly one of a TOTP code or a recovery code. */
const proof = z
  .object({ code: code.optional(), recoveryCode: recoveryCode.optional() })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'Send either an authenticator code or a recovery code.',
  });

const verifySchema = z
  .object({
    challengeToken: z.string().min(20).max(2000),
    code: code.optional(),
    recoveryCode: recoveryCode.optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'Send either an authenticator code or a recovery code.',
  });
const enrollStartSchema = z.object({ password: z.string().min(1).max(200) });
const enrollConfirmSchema = z.object({ code });

function meta(req: Request) {
  return { ip: req.ip, userAgent: req.header('user-agent') ?? undefined };
}

// Same per-client ceiling as every credential route (AUTH_THROTTLE, 10/min by default); the
// per-account lockout inside MfaService is the control that actually bounds guessing.

/**
 * Back-office second factor. See docs/security/ADMIN-MFA.md.
 *
 * Which of these a session may call BEFORE it has passed MFA is declared per route with
 * `@AllowMfaPending()`; everything else is refused by MfaGuard like any other admin route.
 */
@ApiTags('auth')
@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('verify')
  @ApiOperation({ summary: 'Exchange a sign-in challenge plus a code for a session.' })
  async verify(
    @Body(new ZodValidationPipe(verifySchema)) body: z.infer<typeof verifySchema>,
    @Req() req: Request,
  ) {
    const userId = await this.mfa.readChallenge(body.challengeToken);
    const binding = await this.mfa.verify(
      userId,
      { code: body.code, recoveryCode: body.recoveryCode },
      meta(req),
    );
    return this.auth.issueMfaSession(userId, meta(req), binding);
  }

  @ApiBearerAuth()
  @AllowMfaPending()
  @Get('status')
  @ApiOperation({
    summary: 'Whether this account has an authenticator, and how many codes are left.',
  })
  async status(@CurrentUser() user: RequestUser) {
    return { ...(await this.mfa.status(user.id)), verified: user.mfa?.verified ?? false };
  }

  @ApiBearerAuth()
  @AllowMfaPending()
  @Throttle(AUTH_THROTTLE)
  @Post('enroll/start')
  @ApiOperation({ summary: 'Start enrolling an authenticator. Needs the account password.' })
  async enrollStart(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(enrollStartSchema)) body: z.infer<typeof enrollStartSchema>,
    @Req() req: Request,
  ) {
    const row = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { id: true, email: true, passwordHash: true, roles: true },
    });
    return this.mfa.startEnrollment(row, body.password, meta(req));
  }

  @ApiBearerAuth()
  @AllowMfaPending()
  @Throttle(AUTH_THROTTLE)
  @Post('enroll/confirm')
  @ApiOperation({
    summary:
      'Finish enrolling with the first code. Returns a session and the recovery codes, once.',
  })
  async enrollConfirm(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(enrollConfirmSchema)) body: z.infer<typeof enrollConfirmSchema>,
    @Req() req: Request,
  ) {
    const { binding, recoveryCodes } = await this.mfa.confirmEnrollment(
      user.id,
      body.code,
      meta(req),
    );
    const tokens = await this.auth.issueMfaSession(user.id, meta(req), binding);
    return { ...tokens, recoveryCodes };
  }

  @ApiBearerAuth()
  @Throttle(AUTH_THROTTLE)
  @Post('step-up')
  @ApiOperation({ summary: 'Re-confirm the second factor for a sensitive action.' })
  async stepUp(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(proof)) body: z.infer<typeof proof>,
    @Req() req: Request,
  ) {
    const binding = await this.mfa.verify(user.id, body, meta(req));
    return { accessToken: await this.auth.issueStepUpAccessToken(user.id, binding) };
  }

  @ApiBearerAuth()
  @RequiresRecentMfa()
  @Post('recovery-codes/regenerate')
  @ApiOperation({ summary: 'Replace all recovery codes. The old ones stop working.' })
  async regenerate(@CurrentUser() user: RequestUser, @Req() req: Request) {
    await this.requireEnrolled(user);
    return { recoveryCodes: await this.mfa.regenerateRecoveryCodes(user.id, meta(req)) };
  }

  @ApiBearerAuth()
  @RequiresRecentMfa()
  @Post('replace-device')
  @ApiOperation({
    summary: 'Remove this authenticator and end every session; sign-in then enrolls a new one.',
  })
  async replaceDevice(@CurrentUser() user: RequestUser, @Req() req: Request) {
    await this.requireEnrolled(user);
    await this.mfa.replaceDevice(user.id, meta(req));
    return { success: true };
  }

  private async requireEnrolled(user: RequestUser): Promise<void> {
    if (!(await this.mfa.status(user.id)).enrolled) {
      throw new AppException(ErrorCodes.CONFLICT, 'No authenticator is set up.', 409);
    }
  }
}
