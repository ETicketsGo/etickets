import { describe, expect, it, beforeAll } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import {
  checkRequest,
  isExemptPath,
  parseGateMode,
  readGateConfig,
  type GateConfig,
} from './access-gate';

const TEAM = 'eticketsgo.cloudflareaccess.com';
const AUD = 'a'.repeat(64);

let keys: JWTVerifyGetKey;
let privateKey: CryptoKey;
let strangerKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  strangerKey = (await generateKeyPair('RS256')).privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  keys = createLocalJWKSet({ keys: [jwk] });
});

function token(
  opts: { iss?: string; aud?: string; expSeconds?: number; key?: CryptoKey; alg?: string } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: 'admin@eticketsgo.com', type: 'app' })
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? `https://${TEAM}`)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (opts.expSeconds ?? 600))
    .sign(opts.key ?? privateKey);
}

const enforce: GateConfig = readGateConfig({
  ADMIN_ACCESS_GATE: 'enforce',
  CF_ACCESS_TEAM_DOMAIN: TEAM,
  CF_ACCESS_AUD: AUD,
});

describe('parseGateMode', () => {
  it('is off unless report or enforce is spelled out', () => {
    expect(parseGateMode(undefined)).toBe('off');
    expect(parseGateMode('')).toBe('off');
    expect(parseGateMode('on')).toBe('off');
    expect(parseGateMode('enforced')).toBe('off');
    expect(parseGateMode(' Enforce ')).toBe('enforce');
    expect(parseGateMode('REPORT')).toBe('report');
  });
});

describe('readGateConfig', () => {
  it('accepts a team domain given as a URL', () => {
    const c = readGateConfig({
      ADMIN_ACCESS_GATE: 'enforce',
      CF_ACCESS_TEAM_DOMAIN: `https://${TEAM}/`,
      CF_ACCESS_AUD: AUD,
    });
    expect(c.teamDomain).toBe(TEAM);
    expect(c.problem).toBeNull();
  });
  it('refuses any key host that is not a Cloudflare team domain', () => {
    for (const d of [
      'evil.example.com',
      'x.cloudflareaccess.com.evil.com',
      'cloudflareaccess.com',
      '',
    ]) {
      expect(readGateConfig({ CF_ACCESS_TEAM_DOMAIN: d, CF_ACCESS_AUD: AUD }).problem).toMatch(
        /TEAM_DOMAIN/,
      );
    }
  });
  it('requires a 64-character AUD tag', () => {
    expect(readGateConfig({ CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: 'short' }).problem).toMatch(
      /AUD/,
    );
  });
});

describe('checkRequest', () => {
  it('lets everything through when off, even with no configuration', async () => {
    const off = readGateConfig({});
    expect(await checkRequest(off, '/admin', null, keys)).toEqual({ allow: true, reason: 'off' });
  });

  it('always answers the health probe', async () => {
    expect(isExemptPath('/api/health')).toBe(true);
    expect(await checkRequest(enforce, '/api/health', null, keys)).toEqual({
      allow: true,
      reason: 'exempt',
    });
  });

  it('exempts nothing else', async () => {
    for (const p of [
      '/',
      '/login',
      '/admin',
      '/_next/static/x.js',
      '/_next/image',
      '/api/health/',
      '/runtime-config.js',
    ]) {
      expect(isExemptPath(p)).toBe(false);
      expect((await checkRequest(enforce, p, null, keys)).allow).toBe(false);
    }
  });

  it('accepts a valid token for this application', async () => {
    expect(await checkRequest(enforce, '/admin', await token(), keys)).toEqual({
      allow: true,
      reason: 'valid',
    });
  });

  it('refuses a missing token', async () => {
    expect(await checkRequest(enforce, '/admin', null, keys)).toEqual({
      allow: false,
      reason: 'no-token',
    });
  });

  it('refuses a token for another Access application', async () => {
    const v = await checkRequest(enforce, '/admin', await token({ aud: 'b'.repeat(64) }), keys);
    expect(v).toMatchObject({ allow: false, reason: 'invalid-token' });
  });

  it('refuses a token from another team', async () => {
    const v = await checkRequest(
      enforce,
      '/admin',
      await token({ iss: 'https://other.cloudflareaccess.com' }),
      keys,
    );
    expect(v).toMatchObject({ allow: false, reason: 'invalid-token' });
  });

  it('refuses an expired token', async () => {
    const v = await checkRequest(enforce, '/admin', await token({ expSeconds: -120 }), keys);
    expect(v).toMatchObject({ allow: false, reason: 'invalid-token', detail: 'ERR_JWT_EXPIRED' });
  });

  it('refuses a token signed with a key Cloudflare does not publish', async () => {
    const v = await checkRequest(enforce, '/admin', await token({ key: strangerKey }), keys);
    expect(v).toMatchObject({ allow: false, reason: 'invalid-token' });
  });

  it('refuses an unsigned or garbage token', async () => {
    const none = `${btoa(JSON.stringify({ alg: 'none' }))}.${btoa(JSON.stringify({ iss: `https://${TEAM}`, aud: AUD }))}.`;
    expect((await checkRequest(enforce, '/admin', none, keys)).allow).toBe(false);
    expect((await checkRequest(enforce, '/admin', 'not-a-jwt', keys)).allow).toBe(false);
  });

  it('fails closed when enforcing without a usable configuration', async () => {
    const broken = readGateConfig({ ADMIN_ACCESS_GATE: 'enforce' });
    expect(await checkRequest(broken, '/admin', await token(), keys)).toMatchObject({
      allow: false,
      reason: 'misconfigured',
    });
    // ...but the health probe still answers, so the deployment is not marked failed.
    expect((await checkRequest(broken, '/api/health', null, keys)).allow).toBe(true);
  });
});
