import { FailureClass, parseEnabledMarkets, phoneOnlyEmail } from '@eticketsgo/shared-types';
import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { SmsChannel } from '../notifications/channels/sms.channel';
import { TransportError } from '../notifications/channels/transports/transport-http';
import { messageContentLoggable } from '../notifications/channels/transports/content-logging';
import { MetricsService } from '../metrics/metrics.service';
import { maskPhone, normalisePhone } from './phone';
import { otpDestination } from './otp-destination';
import { OtpSmsGuard, type OtpSendRefusal } from './otp-sms-guard';

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
const OTP_TTL_MINUTES = 5;

/**
 * How many wrong guesses one code survives.
 *
 * Five of a million is not a meaningful chance; the point is that the number is small and
 * fixed, so no amount of parallelism turns a six-digit code into a guessable one.
 */
const MAX_ATTEMPTS = 5;

/*
  How many codes one number (and the whole platform) may be sent lives in `otp-sms-guard.ts`,
  configurable: a 60-second resend cooldown, 5 an hour and 10 a day per number, and a daily
  budget in total and per market.
*/

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
    /*
      Optional only so a test can build this service by hand. Without one, the guard is built
      with no Redis and every send is decided by its Postgres fallback - still atomic, still
      limited - never by no rule at all.
    */
    @Optional() guard?: OtpSmsGuard,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.guard = guard ?? new OtpSmsGuard(config);
  }

  private readonly guard: OtpSmsGuard;

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
    // Declared off: answer before writing a code nobody can receive.
    if (this.config.get<string>('SMS_ENABLED') === 'false') {
      throw new AppException(
        ErrorCodes.SMS_UNAVAILABLE,
        "We can't send sign-in codes by text message right now. Please sign in with your email address instead.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const phone = normalisePhone(rawPhone);

    /*
      ── WHERE A CODE MAY GO, BEFORE ANYTHING ELSE ──────────────────────────────────────
      Checked before any limit, any database read and any account lookup, so a refused number
      costs nothing and reveals nothing: the answer depends only on the digits typed, never on
      whether somebody has an account. See `otp-destination.ts` for the rule and why.

      The answer is the one already given for a number a provider refuses, because to the
      person it is the same fact - this number cannot be texted - and the way forward is the
      same: email.
    */
    const destination = otpDestination(
      phone,
      parseEnabledMarkets(this.config.get<string>('NOTIFICATION_MARKETS')),
    );
    if (!destination.ok) {
      this.metrics?.recordOtpSms(destination.market ?? 'other', 'refused_destination');
      this.logger.warn(
        `sign-in code refused for ${maskPhone(phone)}: destination not allowed ` +
          `[${destination.reason}]`,
      );
      throw new AppException(
        ErrorCodes.SMS_UNDELIVERABLE,
        "We can't send a text message to this number. Check it, or sign in with your email address.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const market = destination.market;

    // `randomInt` is CSPRNG-backed. `Math.random()` is not, and a predictable OTP is not an
    // OTP.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const row = (codeHash: string) => ({
      phone,
      codeHash,
      expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
      requestedIp: ip ?? null,
    });

    /*
      ── COUNTED BEFORE IT IS SENT, ATOMICALLY ──────────────────────────────────────────
      Per-number cooldown, hourly and daily caps, and the platform's daily budget, all in one
      atomic step (see `otp-sms-guard.ts`). This used to be a COUNT followed by a separate
      INSERT, so twenty requests fired at once all read "none sent yet" and all twenty were
      texted.
    */
    const reservation = await this.guard.reserve(phone, market);
    if (reservation.status === 'refused') throw this.refusal(market, reservation);

    if (reservation.status === 'allowed') {
      // A new code invalidates the old one: two live codes double an attacker's odds for no
      // benefit to anybody who simply pressed the button twice.
      await this.prisma.phoneOtp.updateMany({
        where: { phone, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await this.prisma.phoneOtp.create({ data: row(await bcrypt.hash(code, 10)) });
    } else {
      /*
        Redis could not be asked. The same limits are decided in Postgres instead, and the
        decision and the new row are ONE transaction under an advisory lock, so the fallback is
        as atomic as the script it stands in for. Hashed first, so the lock is held for three
        quick queries rather than for a bcrypt round.
      */
      const data = row(await bcrypt.hash(code, 10));
      const fallback = await this.prisma.$transaction(async (tx) => {
        const decided = await this.guard.reserveInTransaction(tx, phone);
        if (decided.status !== 'allowed') return decided;
        await tx.phoneOtp.updateMany({
          where: { phone, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        await tx.phoneOtp.create({ data });
        return decided;
      });
      if (fallback.status === 'refused') throw this.refusal(market, fallback);
    }

    /*
      The body comes from configuration, because in India it is not ours to write.

      TRAI requires the text to match a template registered on a DLT portal, and an operator
      silently drops anything that differs from the approved wording. A hardcoded string
      would mean every compliance correction is a code change and a deploy.
    */
    const template =
      this.config.get<string>('OTP_SMS_TEMPLATE') ??
      'Your ETicketsGo verification code is {code}. Valid for 5 minutes. Do not share this code.';
    const body = template.replace('{code}', code).replace('{minutes}', String(OTP_TTL_MINUTES));
    let outcome;
    try {
      outcome = await this.sms.deliver({
        type: 'ACCOUNT_SECURITY' as never,
        channel: 'sms',
        locale: 'en',
        subject: 'Your sign-in code',
        body,
        // The transport reads the recipient from `payload.phone`.
        payload: { phone },
      });
    } catch (err) {
      // A code nobody received must not stay redeemable.
      await this.prisma.phoneOtp
        .updateMany({ where: { phone, consumedAt: null }, data: { consumedAt: new Date() } })
        .catch(() => undefined);
      this.metrics?.recordOtpSms(market, 'provider_failed');
      throw this.sendFailure(phone, err);
    }

    /*
      A LOG-MODE SEND IS NOT A SEND.

      `SmsLogTransport` writes a line and returns success, which is indistinguishable from a
      real delivery to everything above it. In production that turned the whole sign-in into
      a lie somebody could not detect: the API answered 201, the screen said "Code sent to
      +1...", the person waited for a text that was never going to arrive, and the code sat
      in the database redeemable by nobody. Observed on production on 2026-10-07.

      The same rule as `messageContentLoggable`, deliberately, so the two cannot disagree: in
      LOCAL and DEV the console IS the delivery channel and a developer signs in from it;
      anywhere else, log mode means undelivered and must say so. The code is consumed first,
      because a code nobody received must not stay redeemable.
    */
    /*
      Fail CLOSED on anything that is not a recognisable successful send, including a
      transport that returns nothing at all. "We could not confirm this was delivered" and
      "we delivered it" must not collapse into the same answer, and an unreadable outcome is
      the first of those - not a reason to reach into it and throw a 500.
    */
    const provider = outcome?.provider;
    const undelivered = !provider || outcome?.skipped === true || provider === 'log';
    if (undelivered && !messageContentLoggable(this.config)) {
      this.metrics?.recordOtpSms(market, 'provider_failed');
      await this.prisma.phoneOtp
        .updateMany({ where: { phone, consumedAt: null }, data: { consumedAt: new Date() } })
        .catch(() => undefined);
      this.logger.error(
        `sign-in code NOT DELIVERED for ${maskPhone(phone)}: SMS provider is ` +
          `'${provider ?? 'unknown'}'. No text message was sent. Configure a real SMS provider.`,
      );
      throw new AppException(
        ErrorCodes.SMS_UNAVAILABLE,
        "We can't send sign-in codes by text message right now. Please sign in with your email address instead.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    /*
      In local development the SMS provider is `log`, which writes the body to the console —
      that is how a developer signs in without a provider account. Outside LOCAL/DEV the code
      is never written anywhere it could be read: not the log, not the response, not an audit
      row. A code in a log file is a code in whatever ships that log file. The rule is the
      same one the log transport applies, so the two cannot disagree.
    */
    if (messageContentLoggable(this.config)) {
      this.logger.debug(`[dev only] OTP for ${phone} is ${code}`);
    }

    this.metrics?.recordOtpSms(market, 'sent');
    return { sent: true, expiresInMinutes: OTP_TTL_MINUTES };
  }

  /**
   * What the caller is told when a limit refuses a send.
   *
   * Refused loudly rather than silently dropped. A per-number limit protects a person from
   * being SMS-bombed and protects us from paying for it, and both are worth telling the caller
   * about - a silent success would have somebody waiting for a message that is never coming.
   *
   * A spent BUDGET is answered exactly as "text messages are off" is answered, because that is
   * what it is for the person: phone sign-in is unavailable, email works. It must not say
   * "budget" or "limit": the caller is quite possibly the attacker, and the less this tells
   * them about where the line is, the better.
   */
  private refusal(
    market: string,
    reservation: { refusal: OtpSendRefusal; retryAfterSeconds: number },
  ): AppException {
    const budget =
      reservation.refusal === 'budget_total' || reservation.refusal === 'budget_market';
    this.metrics?.recordOtpSms(market, budget ? 'budget_tripped' : 'rate_limited');
    if (budget) {
      return new AppException(
        ErrorCodes.SMS_UNAVAILABLE,
        "We can't send sign-in codes by text message right now. Please sign in with your email address instead.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const message =
      reservation.refusal === 'daily'
        ? 'Too many codes requested for this number today. Try again tomorrow, or sign in with your email address.'
        : reservation.refusal === 'hourly'
          ? 'Too many codes requested for this number. Try again in an hour.'
          : `A code was sent a moment ago. Wait ${reservation.retryAfterSeconds} seconds before asking for another one.`;
    return new AppException(ErrorCodes.RATE_LIMITED, message, HttpStatus.TOO_MANY_REQUESTS);
  }

  /**
   * What the caller is told when the code could not be sent.
   *
   * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
   * The SMS provider's error used to escape this method unhandled. The person got a 500, and
   * the exception filter logged the stack and reported it to Sentry -- carrying the provider's
   * own message, which names the number it refused. A provider outage became a server error
   * with a phone number attached.
   *
   * ── WHAT IT SAYS, AND WHAT IT DOES NOT ─────────────────────────────────────────────
   * Two answers only. The number cannot be texted -- not a reachable mobile, or its owner opted
   * out -- which is worth telling the person because retrying will not help. Or texting is not
   * working right now. Neither names a provider, an error code or a reason beyond that: the
   * response goes to whoever typed the number, who is not necessarily its owner, and "this
   * number has opted out" is a fact about somebody else.
   *
   * The log keeps the class, the provider's code and a masked number -- enough to act on.
   */
  private sendFailure(phone: string, err: unknown): AppException {
    const transport = err instanceof TransportError ? err : null;
    const failureClass = transport?.failureClass ?? FailureClass.UNKNOWN_PROVIDER_ERROR;
    this.logger.warn(
      `sign-in code not sent to ${maskPhone(phone)} [${failureClass}` +
        `${transport?.providerCode ? ` ${transport.providerCode}` : ''}]`,
    );

    const numberCannotBeTexted =
      failureClass === FailureClass.INVALID_DESTINATION || Boolean(transport?.suppression);
    if (numberCannotBeTexted) {
      return new AppException(
        ErrorCodes.SMS_UNDELIVERABLE,
        "We can't send a text message to this number. Check it, or sign in with your email address.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return new AppException(
      ErrorCodes.SMS_UNAVAILABLE,
      "We couldn't send a sign-in code just now. Try again in a few minutes, or sign in with your email address.",
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  /**
   * Check a code and return the user it signs in, creating one if the number is new.
   *
   * Returns the user rather than tokens: minting a session is the auth service's job, and
   * keeping it there means phone sign-in produces exactly the same session as every other
   * route rather than a second, subtly different one.
   */
  /**
   * Prove a code, burn it, and answer with the number it proved.
   *
   * ── WHY THIS IS ITS OWN METHOD ─────────────────────────────────────────────────────
   * Two callers now need a proven number: signing in, and attaching a number to an account
   * somebody is already signed into. What they do afterwards is completely different; how the
   * code is checked must be identical, because that is where the single-use guarantee, the
   * attempt budget and the constant answer live. A second copy of this would be a second place
   * for those to drift, and the drift would be silent.
   */
  private async consumeCode(rawPhone: string, code: string): Promise<string> {
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

    /*
      ── THE GUESS IS PAID FOR BEFORE IT IS CHECKED ─────────────────────────────────────
      This used to read `attempts`, compare the code, and only then increment. Every request
      that arrived before the first increment landed saw the same count, so twenty guesses
      fired at once were all compared against a limit of five: the limit was a property of how
      fast somebody sent requests, not of the code.

      So the attempt is claimed FIRST, by a conditional update the database applies atomically —
      it increments only while the count is still under the limit, and reports how many rows it
      changed. Zero means the budget was already spent, by this caller or a concurrent one, and
      the code is compared against nothing. A correct code costs an attempt too, which changes
      nothing anybody sees: a success spends the row anyway.
    */
    const claimed = await this.prisma.phoneOtp.updateMany({
      where: { id: otp.id, consumedAt: null, attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      // Out of guesses, or spent meanwhile. Burned rather than left to be ground down further.
      await this.prisma.phoneOtp.updateMany({
        where: { id: otp.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      throw rejected();
    }

    if (!(await bcrypt.compare(code, otp.codeHash))) throw rejected();

    /*
      Spent conditionally for the same reason: two correct submissions racing each other must
      not both sign in on one single-use code. The loser is told what everybody else is told.
    */
    const spent = await this.prisma.phoneOtp.updateMany({
      where: { id: otp.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (spent.count === 0) throw rejected();

    return phone;
  }

  /**
   * Attach a proven number to the account somebody is already signed into.
   *
   * ── WHY THIS IS NOT verifyCode ────────────────────────────────────────────────────
   * `verifyCode` answers "whose account is this number?" and will CREATE one if the answer is
   * nobody. That is right for signing in and wrong here: the account already exists, the person
   * is already in it, and a second account must never appear because somebody added a phone
   * number to their profile.
   *
   * ── THE DEAD END THIS FIXES ───────────────────────────────────────────────────────
   * Notification settings offers WhatsApp for booking updates and disables the switch until the
   * account has a phone number, with a line reading "Add a phone number to receive WhatsApp
   * updates" that links to the profile. The profile had no phone field and no way to add one, so
   * the link went to a page that could not do the thing it promised, and the switch could never
   * be turned on by anybody.
   *
   * ── ONE NUMBER, ONE ACCOUNT ───────────────────────────────────────────────────────
   * Refused if the number is already on someone else's account. Not merged, not transferred:
   * a number proves who you are here, and moving one between accounts on the strength of a
   * single code is how an account is taken over. The person is told plainly and sent to support,
   * because the legitimate version of this - somebody changing their number - is rare and worth
   * a human looking at.
   */
  async attachToAccount(
    userId: string,
    rawPhone: string,
    code: string,
  ): Promise<{ phone: string }> {
    const phone = await this.consumeCode(rawPhone, code);

    const holder = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (holder && holder.id !== userId) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'That number is already on another account. Contact support if it is yours.',
        HttpStatus.CONFLICT,
      );
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { phone, phoneVerifiedAt: new Date() },
    });
    return { phone };
  }

  async verifyCode(
    rawPhone: string,
    code: string,
    /**
     * What the request knew about where it came from. Written only onto an account this call
     * CREATES (never onto an existing one), labelled with its source.
     */
    signup: { detectedCountry?: string | null } = {},
  ): Promise<{ id: string; isNewAccount: boolean }> {
    const phone = await this.consumeCode(rawPhone, code);

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
    let created: { id: string };
    try {
      created = await this.prisma.user.create({
        data: {
          email: phoneOnlyEmail(phone),
          phone,
          phoneVerifiedAt: new Date(),
          passwordHash: `phone-only$${await bcrypt.hash(`${phone}:${Date.now()}`, 10)}`,
          fullName: '',
          roles: ['CUSTOMER'],
          ...(signup.detectedCountry
            ? { detectedCountry: signup.detectedCountry, detectedCountrySource: 'network' }
            : {}),
        },
        select: { id: true },
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code !== 'P2002') throw err;
      /*
        ── ONE NUMBER, ONE ACCOUNT, EVEN WHEN TWO REQUESTS ARRIVE TOGETHER ─────────────
        Two verifications for the same brand-new number — a double tap, two devices — both
        find no account and both try to make one. The unique index stops the second, which
        used to surface as a 500 to a person who had just typed a correct code. The winner's
        account is theirs too: they proved the same number.
      */
      const winner = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } });
      if (winner) return { id: winner.id, isNewAccount: false };
      // The collision was on the placeholder address, not the number: a row nobody should have
      // been able to create. Said plainly rather than as a server error.
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This number cannot be used to sign in right now. Contact support.',
        HttpStatus.CONFLICT,
      );
    }
    return { id: created.id, isNewAccount: true };
  }
}
