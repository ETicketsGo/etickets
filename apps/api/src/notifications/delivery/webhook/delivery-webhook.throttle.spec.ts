import type { AddressInfo } from 'node:net';
import { Controller, Logger, Module, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DeliveryWebhookController } from './delivery-webhook.controller';
import { DeliveryWebhookService } from './delivery-webhook.service';

/**
 * Provider callbacks are not subject to the per-IP rate limit.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * A provider is one client. A bulk send of a few hundred SMS produces a few hundred Twilio
 * status callbacks from a handful of addresses within seconds, the global 120-per-minute limit
 * answered the overflow with 429, and Twilio does not retry a status callback -- so those
 * messages were never marked delivered or failed.
 *
 * Over real HTTP with the real guard, and with an ordinary throttled route in the same app, so
 * the test proves the limit is live and that these routes are exempt from it rather than
 * passing because nothing was throttling at all.
 */

@Controller('probe')
class ThrottledProbeController {
  @Post()
  hit() {
    return { ok: true };
  }
}

const acknowledged = { received: true, applied: 0, duplicate: false };
const webhooks = {
  twilio: jest.fn().mockResolvedValue(acknowledged),
  msg91: jest.fn().mockResolvedValue(acknowledged),
  ses: jest.fn().mockResolvedValue(acknowledged),
};

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 2 }])],
  controllers: [DeliveryWebhookController, ThrottledProbeController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: DeliveryWebhookService, useValue: webhooks },
    { provide: ConfigService, useValue: { get: () => undefined } },
  ],
})
class WebhookThrottleModule {}

describe('delivery webhooks under the global rate limit', () => {
  let app: INestApplication;
  let base: string;
  let quiet: jest.SpyInstance[];

  beforeEach(async () => {
    quiet = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    const moduleRef = await Test.createTestingModule({
      imports: [WebhookThrottleModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (app) await app.close();
    quiet.forEach((s) => s.mockRestore());
  });

  const post = (path: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ MessageSid: 'SM1', MessageStatus: 'delivered' }),
    });

  it('the limit is live for an ordinary route in the same application', async () => {
    expect((await post('/probe')).status).toBe(201);
    expect((await post('/probe')).status).toBe(201);
    expect((await post('/probe')).status).toBe(429);
  });

  it.each(['/notifications/webhooks/twilio', '/notifications/webhooks/msg91/path-secret'])(
    'accepts a burst of callbacks on %s well past the limit',
    async (path) => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) statuses.push((await post(path)).status);
      expect(statuses).not.toContain(429);
    },
  );
});
