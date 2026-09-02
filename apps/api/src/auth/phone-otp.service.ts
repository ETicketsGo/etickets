import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { SmsChannel } from '../notifications/channels/sms.channel';
import { normalisePhone } from './phone';

/**
 * Signing in with a mobile number and a one-time code.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Every platform an Indian buyer already uses to book a film — BookMyShow, District,
 * PhonePe — signs them in with a phone number and an OTP. This platform asked for an email
 * address and a password, for a purchase that is usually impulsive, often one-off, and made
 * on a phone. That is a conversion problem before it is anything else, and it also means the
 * one identifier the ticket most naturally travels to was never collected.
 *
 * ── THE FOUR THINGS THAT MAKE THIS SAFE ────────────────────────────────────────────
 * A six-digit code is a small secret, so the protections are not optional:
 *
 *   1. The code is HASHED at rest. Six digits stored in the clear turns one database read
 *      into every live sign-in on the platform, and nobody can rotate a code they never knew.
 *   2. Guesses are counted ON THE ROW. A request throttle counts requests; this counts wrong
 *      answers against one code, so it dies after a handful however the guesses arrive.
 *   3. Requesting a code says the same thing whether or not the number is known. Anything
 *      else turns this endpoint into a "does this person have an account" oracle.
 *   4. Codes are short-lived and single-use, and asking for a new one kills the old.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────────────
 * It does not merge accounts. If a number is already on one account, the code signs you into
 * THAT account; it never attaches the number to a second one. Merging two identities because
 * they share a phone number is a decision with consequences no automated rule should make.
 */

/** Long enough to arrive and be typed, short enough that a stolen code is usually dead. */
const OTP_TTL_MINUTES = 10;

/**
 * How many wrong guesses one code survives.
 *
 * Five of a million is not a meaningful chance; the point is that the number is small and
 * fixed, so no amount of parallelism turns a six-digit code into a guessable one.
 */
const MAX_ATTEMPTS = 5;

/** Codes requested per number per window, so this cannot be used to bill somebody's SMS. */
const MAX_SENDS_PER_HOUR = 5;

@Injectable()
export class PhoneOtpService {
  private readonly logger = new Logger(PhoneOtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    /*
      The SMS channel DIRECTLY, not the notification service.

      `NotificationService.send()` writes a `Notification` row carrying the payload, which
      would put the live code in a queryable table and in whatever ships that table onward.
      An OTP is a credential with a ten-minute life; it belongs in exactly one place — the
      message — and in a hash we can compare against. So this bypasses the templating and
      persistence layer deliberately, and that is the reason.
    */
    private readonly sms: SmsChannel,
    private readonly config: ConfigService,
  ) {}

  /**
   * Send a code to a number.
   *
   * The response is identical whether the number belongs to an account, so this cannot be
   * used to discover who is registered. It is the same reasoning the password-reset endpoint
   * already applies, and for the same reason.
   */
  async requestCode(
    rawPhone: string,
    ip?: string,
  ): Promise<{ sent: true; expiresInMinutes: number }> {
    const phone = normalisePhone(rawPhone);

    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await this.prisma.phoneOtp.count({
      where: { phone, createdAt: { gte: anHourAgo } },
    });
    if (recent >= MAX_SENDS_PER_HOUR) {
      /*
        Refused loudly rather than silently dropped.

        This limit protects a person from being SMS-bombed and protects us from paying for
        it, and both are worth telling the caller about — a silent success here would have
        somebody waiting for a message that is never coming.
      */
      throw new AppException(
        ErrorCodes.RATE_LIMITED,
        'Too many codes requested for this number. Try again in an hour.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // A new code invalidates the old one: two live codes double an attacker's odds for no
    // benefit to anybody who simply pressed the button twice.
    await this.prisma.phoneOtp.updateMany({
      where: { phone, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    // `randomInt` is CSPRNG-backed. `Math.random()` is not, and a predictable OTP is not an
    // OTP.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.phoneOtp.create({
      data: {
        phone,
        codeHash: await bcrypt.hash(code, 10),
        expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
        requestedIp: ip ?? null,
      },
    });

    /*
      The body comes from configuration, because in India it is not ours to write.

      TRAI requires the text to match a template registered on a DLT portal, and an operator
      silently drops anything that differs from the approved wording. A hardcoded string
      would mean every compliance correction is a code change and a deploy.
    */
    const template =
      this.config.get<string>('OTP_SMS_TEMPLATE') ??
      '{code} is your ETicketsGo sign-in code. It expires in {minutes} minutes. Never share it with anyone.';
    const body = template.replace('{code}', code).replace('{minutes}', String(OTP_TTL_MINUTES));
    await this.sms.deliver({
      type: 'ACCOUNT_SECURITY' as never,
      channel: 'sms',
      locale: 'en',
      subject: 'Your sign-in code',
      body,
      // The transport reads the recipient from `payload.phone`.
      payload: { phone },
    });

    /*
      In local development the SMS provider is `log`, which writes the body to the console —
      that is how a developer signs in without a Twilio account. Outside LOCAL/DEV the code
      is never written anywhere it could be read: not the log, not the response, not an audit
      row. A code in a log file is a code in whatever ships that log file.
    */
    const appEnv = this.config.get<string>('APP_ENV') ?? 'LOCAL';
    if (['LOCAL', 'DEV'].includes(appEnv)) {
      this.logger.debug(`[dev only] OTP for ${phone} is ${code}`);
    }

    return { sent: true, expiresInMinutes: OTP_TTL_MINUTES };
  }

  /**
   * Check a code and return the user it signs in, creating one if the number is new.
   *
   * Returns the user rather than tokens: minting a session is the auth service's job, and
   * keeping it there means phone sign-in produces exactly the same session as every other
   * route rather than a second, subtly different one.
   */
  async verifyCode(rawPhone: string, code: string): Promise<{ id: string; isNewAccount: boolean }> {
    const phone = normalisePhone(rawPhone);

    const otp = await this.prisma.phoneOtp.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    /*
      One message for "no code", "expired code" and "wrong code".

      Distinguishing them tells an attacker whether a number has a code outstanding, which is
      a small leak on its own and a useful signal in bulk. The person who genuinely mistyped
      is told to ask for a new code either way, which is the action in every case.
    */
    const rejected = () =>
      new AppException(
        ErrorCodes.INVALID_CREDENTIALS,
        'That code is not valid. Ask for a new one.',
        HttpStatus.UNAUTHORIZED,
      );
    if (!otp) throw rejected();

    if (otp.attempts >= MAX_ATTEMPTS) {
      await this.prisma.phoneOtp.update({
        where: { id: otp.id },
        data: { consumedAt: new Date() },
      });
      throw rejected();
    }

    if (!(await bcrypt.compare(code, otp.codeHash))) {
      // Counted before the answer is returned, so a guess costs an attempt whatever the
      // caller does next.
      await this.prisma.phoneOtp.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw rejected();
    }

    await this.prisma.phoneOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });

    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) {
      // Re-stamped on every successful sign-in: the number is proven again, right now.
      await this.prisma.user.update({
        where: { id: existing.id },
        data: { phoneVerifiedAt: new Date() },
      });
      return { id: existing.id, isNewAccount: false };
    }

    /*
      A brand-new account, with no password and no email.

      `email` is unique and required, so a placeholder is derived from the number — it is
      never shown and never written to. `passwordHash` gets the same unsignable placeholder
      the invite flow uses: an account nobody can log into with a password, only with a code,
      until the person sets one.
    */
    const created = await this.prisma.user.create({
      data: {
        email: `phone+${phone.replace(/\D/g, '')}@users.eticketsgo.internal`,
        phone,
        phoneVerifiedAt: new Date(),
        passwordHash: `phone-only$${await bcrypt.hash(`${phone}:${Date.now()}`, 10)}`,
        fullName: '',
        roles: ['CUSTOMER'],
      },
    });
    return { id: created.id, isNewAccount: true };
  }
}
