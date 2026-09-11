import type { AddressInfo } from 'node:net';
import { Controller, Get, Logger, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * What somebody sees when they are rate limited.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * The status-to-code mapping had no case for 429, so a throttled request was reported as
 * `INTERNAL` — a server fault — with the message "ThrottlerException: Too Many Requests",
 * which names a class to a person who only pressed a button too often. Organization
 * registration is now rate limited, so this is a message real organizers will read.
 *
 * Over real HTTP with the real guard and the real filter, because the mapping only happens
 * when both are in the pipeline.
 */

@Controller('probe')
class ProbeController {
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @Get()
  hit() {
    return { ok: true };
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
  controllers: [ProbeController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class ProbeModule {}

describe('a rate-limited request', () => {
  let app: INestApplication;
  let url: string;
  let quiet: jest.SpyInstance[];

  beforeEach(async () => {
    quiet = (['warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/probe`;
  });

  afterEach(async () => {
    if (app) await app.close();
    quiet.forEach((s) => s.mockRestore());
  });

  it('is reported as RATE_LIMITED with a sentence a person can act on', async () => {
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(url)).status).toBe(200);

    const refused = await fetch(url);
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { code: string; message: string };
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.message).not.toMatch(/ThrottlerException/);
    expect(body.message).toMatch(/try again/i);
  });
});
