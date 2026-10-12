import { CapabilitiesController } from './capabilities.controller';

describe('GET /capabilities phoneSignIn', () => {
  const make = (v?: string) => new CapabilitiesController({ get: () => v } as never).get();

  it('is true by default', () => {
    expect(make(undefined).phoneSignIn).toBe(true);
    expect(make('true').phoneSignIn).toBe(true);
  });

  it('is false when SMS is declared off', () => {
    expect(make('false').phoneSignIn).toBe(false);
  });
});
