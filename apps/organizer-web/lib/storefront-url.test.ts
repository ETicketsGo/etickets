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
    expect(storefrontOrigin(at('organizer.eticketsgo.com'), '')).toBe('https://eticketsgo.com');
    expect(storefrontOrigin(at('localhost', 'http:'), '')).toBe('http://localhost:3000');
  });

  it('prefers a configured address', () => {
    expect(storefrontOrigin(at('organizer-qa.eticketsgo.com'), 'https://shop.example.test/')).toBe(
      'https://shop.example.test',
    );
  });

  it('does not guess for a host it does not recognise', () => {
    expect(storefrontOrigin(at('console.example.test'), '')).toBeNull();
    expect(storefrontOrigin(undefined, '')).toBeNull();
  });
});
