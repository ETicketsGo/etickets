import type { AddressInfo } from 'node:net';
import { Controller, Get, HttpStatus, Logger, Module, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { LoggingInterceptor } from './logging.interceptor';
import { HttpObservationService } from './http-observation.service';
import { AppException, ErrorCodes } from './errors';
import { MetricsService } from '../metrics/metrics.service';

/**
 * The secret never reaches a log line — proven at the wire, not at the helper.
 *
 * ── WHY THIS IS SEPARATE FROM `request-path.spec.ts` ───────────────────────────────
 * That suite proves the sanitizer redacts. It cannot prove the sanitizer is REACHED. The
 * defect was never that redaction was wrong; it was that three separate call sites each
 * derived their own path and none of them redacted. A unit test of the helper would have
 * passed on the broken code.
 *
 * So this boots a real server with the real interceptor and the real exception filter, makes
 * real requests, captures every line those two emit, and asserts the configured secret appears
 * in none of them — including on the error paths, which is where the leak was first seen
 * locally (a 500 whose log line carried the whole URL).
 */

const SECRET = 'k9Vx2pQ7-Rj4LmN8sT1wY6bZ0cH3dF5gA';

/** Stands in for the two real webhook controllers; only the ROUTE SHAPE matters here. */
@Controller('notifications/webhooks')
class WebhookProbeController {
  @Post('ses/:secret')
  ses() {
    return { received: true };
  }

  @Post('msg91/:secret')
  msg91() {
    return { received: true };
  }

  /** Refused the way the real webhook refuses an unverified caller. */
  @Post('ses/:secret/refuse')
  refuse(): never {
    throw new AppException(ErrorCodes.UNAUTHORIZED, 'nope', HttpStatus.UNAUTHORIZED);
  }

  /** The 500 path, which is exactly where this leak was first noticed. */
  @Post('ses/:secret/explode')
  explode(): never {
    throw new Error('boom');
  }
}

/**
 * The link-token routes, shaped like the real invitation, share and attendee-invite routes.
 *
 * Mostly refusals, because that is where these tokens were seen: an expired or spent link is
 * the common case, and the exception filter's 4xx line carried the whole path.
 */
@Controller()
class LinkTokenProbeController {
  @Get('public/invitations/:token')
  describeInvitation(): never {
    throw new AppException(ErrorCodes.NOT_FOUND, 'No longer valid.', HttpStatus.NOT_FOUND);
  }

  @Post('public/invitations/:token/accept')
  acceptInvitation() {
    return { ok: true };
  }

  @Post('public/share/:token')
  resolveShare(): never {
    throw new AppException(ErrorCodes.CONFLICT, 'This share has expired.', HttpStatus.CONFLICT);
  }

  @Post('attendee-invites/:token/accept')
  acceptAttendeeInvite(): never {
    throw new AppException(ErrorCodes.UNAUTHORIZED, 'Sign in first.', HttpStatus.UNAUTHORIZED);
  }

  @Post('attendee-invites/:token/decline')
  declineAttendeeInvite() {
    return { ok: true };
  }

  /** Takes an invite ID, not a token — the negative control for this controller. */
  @Post('attendee-invites/:id/resend')
  resend() {
    return { ok: true };
  }
}

/** The negative control: an ordinary route that must keep logging its full path. */
@Controller('bookings')
class OrdinaryController {
  @Get(':reference')
  get() {
    return { ok: true };
  }
}

@Module({
  controllers: [WebhookProbeController, LinkTokenProbeController, OrdinaryController],
  providers: [
    {
      provide: MetricsService,
      useValue: { observeHttp: jest.fn(), recordNotificationWebhook: jest.fn() },
    },
    HttpObservationService,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
class ProbeModule {}

describe('no request log line ever carries a webhook secret', () => {
  let app: INestApplication;
  let base: string;
  let emitted: string[];
  let spies: jest.SpyInstance[];

  beforeEach(async () => {
    emitted = [];
    // Every level, because the interceptor logs at `log`, the filter warns on 4xx and errors
    // on 5xx — and the leak only showed up on one of them.
    spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        emitted.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }),
    );

    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    if (app) await app.close();
    spies.forEach((s) => s.mockRestore());
  });

  const all = () => emitted.join('\n');

  it('redacts on the SES webhook success path', async () => {
    const res = await fetch(`${base}/notifications/webhooks/ses/${SECRET}`, { method: 'POST' });
    expect(res.status).toBeLessThan(300);
    expect(emitted.length).toBeGreaterThan(0); // else the assertion below is vacuous
    expect(all()).not.toContain(SECRET);
    expect(all()).toContain('notifications/webhooks/ses/[REDACTED]');
  });

  it('redacts on the MSG91 webhook, whose secret is its only authentication', async () => {
    const res = await fetch(`${base}/notifications/webhooks/msg91/${SECRET}`, { method: 'POST' });
    expect(res.status).toBeLessThan(300);
    expect(all()).not.toContain(SECRET);
    expect(all()).toContain('notifications/webhooks/msg91/[REDACTED]');
  });

  it('redacts on a 401, which is what an unverified caller produces', async () => {
    const res = await fetch(`${base}/notifications/webhooks/ses/${SECRET}/refuse`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(all()).not.toContain(SECRET);
  });

  it('redacts on a 500, where the leak was first seen', async () => {
    const res = await fetch(`${base}/notifications/webhooks/ses/${SECRET}/explode`, {
      method: 'POST',
    });
    expect(res.status).toBe(500);
    expect(all()).not.toContain(SECRET);
    // The stack trace is logged alongside the message; it must not reintroduce the URL.
    expect(all()).toContain('notifications/webhooks/ses/[REDACTED]');
  });

  it('drops the query string as well as the path secret', async () => {
    await fetch(`${base}/notifications/webhooks/ses/${SECRET}?token=super-secret-query`, {
      method: 'POST',
    });
    expect(all()).not.toContain(SECRET);
    expect(all()).not.toContain('super-secret-query');
  });

  describe('link tokens, which are accounts and tickets rather than webhook secrets', () => {
    /*
      A back-office invite account holds its grants before it is accepted, so an invitation
      token in a log line is a takeover. The refusals matter most: an expired or already-used
      link is the ordinary case, and the exception filter's 4xx line is where the path was.
    */
    const TOKEN = 'Zk3pL9qR2sT5vW8xY1bC4dF7gH0jK6mN';

    it.each([
      ['GET', `public/invitations/${TOKEN}`, 404],
      ['POST', `public/invitations/${TOKEN}/accept`, 201],
      ['POST', `public/share/${TOKEN}`, 409],
      ['POST', `attendee-invites/${TOKEN}/accept`, 401],
      ['POST', `attendee-invites/${TOKEN}/decline`, 201],
    ])('%s /%s is logged without its token', async (method, path, status) => {
      const res = await fetch(`${base}/${path}`, { method });
      expect(res.status).toBe(status);
      expect(emitted.length).toBeGreaterThan(0); // else the assertion below is vacuous
      expect(all()).not.toContain(TOKEN);
      expect(all()).toContain('[REDACTED]');
    });

    it('keeps the invite ID on resend, which is an identifier and not a credential', async () => {
      const id = 'cmtut10xc000jt06sn5knpcf7';
      await fetch(`${base}/attendee-invites/${id}/resend`, { method: 'POST' });
      expect(all()).toContain(`/api/attendee-invites/${id}/resend`);
      expect(all()).not.toContain('[REDACTED]');
    });
  });

  /*
    ── NEGATIVE CONTROL ────────────────────────────────────────────────────────────────
    A redactor that blanked every path would pass every assertion above and destroy the logs.
    A booking reference is precisely what somebody greps for when a customer telephones.
  */
  it('still logs an ordinary path in full', async () => {
    await fetch(`${base}/bookings/ETG-IN-2026-000123`, { method: 'GET' });
    expect(all()).toContain('/api/bookings/ETG-IN-2026-000123');
    expect(all()).not.toContain('[REDACTED]');
  });
});
