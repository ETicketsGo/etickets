import { swaggerVisibility } from './swagger-visibility';

/**
 * Publishing the API reference, and the one environment that may never do it.
 *
 * The interesting case is not the laptop or QA -- both of those already worked. It is a
 * production process that has been handed `ENABLE_SWAGGER=true`, which is not a hypothetical:
 * the QA template sets it, templates get copied between environments, and the only thing that
 * previously stood between that copy and the full API surface was somebody noticing.
 */
describe('swaggerVisibility', () => {
  it('publishes on a developer machine, which is where it is for', () => {
    expect(swaggerVisibility({ APP_ENV: 'LOCAL', NODE_ENV: 'development' }).enabled).toBe(true);
  });

  it('publishes on QA, which runs a production build and asks for it explicitly', () => {
    // Both halves matter: QA is NODE_ENV=production AND sets the variable.
    expect(
      swaggerVisibility({ APP_ENV: 'QA', NODE_ENV: 'production', ENABLE_SWAGGER: 'true' }).enabled,
    ).toBe(true);
  });

  it('stays off on UAT, which mirrors production and does not ask', () => {
    expect(swaggerVisibility({ APP_ENV: 'UAT', NODE_ENV: 'production' }).enabled).toBe(false);
  });

  it('never publishes in production, even when asked to', () => {
    const asked = swaggerVisibility({
      APP_ENV: 'PRODUCTION',
      NODE_ENV: 'production',
      ENABLE_SWAGGER: 'true',
    });
    expect(asked.enabled).toBe(false);
    // And it says so, rather than dropping the variable on the floor.
    expect(asked.refusedInProduction).toBe(true);
  });

  it('is not fooled by how the environment is spelled', () => {
    expect(swaggerVisibility({ APP_ENV: ' production ', ENABLE_SWAGGER: 'true' }).enabled).toBe(
      false,
    );
  });

  it('does not treat NODE_ENV as the name of the environment', () => {
    /*
      The trap this guard was rewritten to avoid. QA and UAT both run NODE_ENV=production, so a
      check against it does not mean "this is production" anywhere but a laptop.
    */
    expect(swaggerVisibility({ APP_ENV: 'QA', NODE_ENV: 'production' }).enabled).toBe(false);
    expect(
      swaggerVisibility({ APP_ENV: 'QA', NODE_ENV: 'production', ENABLE_SWAGGER: 'true' }).enabled,
    ).toBe(true);
  });
});
