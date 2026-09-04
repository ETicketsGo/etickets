import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

/**
 * Can the application actually be constructed?
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────
 * A deploy failed with `Nest can't resolve dependencies of the CinemaComplianceService`
 * while 2,355 tests were passing. Every one of them either constructed the service directly
 * (`new CinemaComplianceService(prisma, access, policies)`) or used a hand-built harness, so
 * the suite proved the service WORKS and never once asked whether Nest could BUILD it. A
 * provider that no module provides is invisible to that style of testing and fatal at boot.
 *
 * `compile()` walks the whole graph and instantiates every provider — which is exactly the
 * step that throws on a missing import — but does NOT run lifecycle hooks, so nothing here
 * opens a socket to Postgres, Redis or a payment provider. It is a wiring test, not a
 * connection test, and it is the cheapest possible proof that `main.ts` will get past
 * `NestFactory.create`.
 */
describe('the application module graph', () => {
  it('compiles, so every injected provider is actually provided by some module', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 120_000);
});
