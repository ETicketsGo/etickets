import { describe, expect, it } from 'vitest';
import { storefrontOrigin } from './storefront-url';

const at = (hostname: string, protocol = 'https:') => ({ protocol, hostname });

describe('storefrontOrigin', () => {
  it('follows how the deployments are named', () => {
    expect(storefrontOrigin(at('organizer-qa.eticketsgo.com'), '')).toBe(
      'https://qa.eticketsgo.com',
    );
    expect(storefrontOrigin(at('organizer-uat.eticketsgo.com'), '')).toBe(
      'https://uat.eticketsgo.com',
    );
    expect(storefrontOrigin(at('localhost', 'http:'), '')).toBe('http://localhost:3000');
    expect(storefrontOrigin(at('127.0.0.1', 'http:'), '')).toBe('http://127.0.0.1:3000');
  });

  /*
    PRODUCTION (owner evidence, 2026-10-25): `https://eticketsgo.com/register?intent=organizer`
    answered GoDaddy's 404 - the bare apex is a domain forwarder that drops the path. The
    storefront is served at `www.`, so stripping `organizer.` must never leave a bare apex.
    This case used to be pinned to the bare apex, which is how the broken link shipped green.
  */
  it('sends production to www, never to the bare apex', () => {
    expect(storefrontOrigin(at('organizer.eticketsgo.com'), '')).toBe('https://www.eticketsgo.com');
    expect(storefrontOrigin(at('organizer.eticketsgo.com'), '')).not.toBe('https://eticketsgo.com');
  });

  it('keeps a stripped host that already has a subdomain as it is', () => {
    expect(storefrontOrigin(at('organizer.qa.eticketsgo.com'), '')).toBe(
      'https://qa.eticketsgo.com',
    );
    expect(storefrontOrigin(at('organizer-staging.eticketsgo.com'), '')).toBe(
      'https://staging.eticketsgo.com',
    );
  });

  it('prefers a configured address', () => {
    expect(storefrontOrigin(at('organizer-qa.eticketsgo.com'), 'https://shop.example.test/')).toBe(
      'https://shop.example.test',
    );
    expect(storefrontOrigin(at('organizer.eticketsgo.com'), ' https://www.eticketsgo.com ')).toBe(
      'https://www.eticketsgo.com',
    );
  });

  it('does not guess for a host it does not recognise', () => {
    expect(storefrontOrigin(at('console.example.test'), '')).toBeNull();
    expect(storefrontOrigin(undefined, '')).toBeNull();
  });
});
