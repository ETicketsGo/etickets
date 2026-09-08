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
 * step that throws on a missing import — and is the cheapest possible proof that `main.ts`
 * will get past `NestFactory.create`.
 *
 * ── WHY IT ALSO CALLS init(), WHICH IT DID NOT ─────────────────────────────────────
 * This file used to say that compiling "opens no socket to Postgres, Redis or a payment
 * provider", and that was simply wrong. `RedisService` connects in its CONSTRUCTOR, and
 * compiling instantiates every provider — so the graph walk opened a Redis connection, and
 * because `close()` runs no lifecycle hooks on a module that was never initialised, nothing
 * ever closed it.
 *
 * One socket is enough to keep the Node event loop alive, and that is precisely what it did:
 * the test passed in under a second and Jest then hung forever. It cost a CI step its entire
 * budget more than once, and it took the whole API suite down with it whenever Jest ran in
 * band — which a two-core runner does by default, because it picks `cpus - 1` workers.
 *
 * `init()` runs the lifecycle the application really runs, so `onModuleDestroy` fires on
 * close and the connection is actually released (verified: the client reaches status `end`
 * rather than staying `ready`). It also makes the assertion stronger — the test is named for
 * booting, and booting is what it now does.
 */
describe('the application module graph', () => {
  it('boots, so every injected provider is actually provided by some module', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    /*
      Initialised before closing, so the teardown hooks that release connections actually
      run. Without this the module is disposed while its sockets stay open.
    */
    await moduleRef.init();
    await moduleRef.close();
  }, 120_000);
});
