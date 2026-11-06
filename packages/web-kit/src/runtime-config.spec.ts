import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_CONFIG_GLOBAL,
  cleanRuntimeValue,
  readServerRuntimeConfig,
  runtimeConfigScript,
  runtimeValue,
} from './runtime-config';

describe('what may be served', () => {
  it('keeps absolute http(s) URLs, without a trailing slash', () => {
    expect(cleanRuntimeValue('API_URL', 'https://api-qa.example.com/api/')).toBe(
      'https://api-qa.example.com/api',
    );
    expect(cleanRuntimeValue('API_URL', 'http://localhost:4000/api')).toBe(
      'http://localhost:4000/api',
    );
  });
  it('drops anything that is not one', () => {
    for (const bad of [
      '',
      '  ',
      'api.example.com',
      'javascript:alert(1)',
      'ftp://x',
      'https://u:p@x.com',
    ]) {
      expect(cleanRuntimeValue('API_URL', bad)).toBeUndefined();
    }
    expect(cleanRuntimeValue('API_URL', 42)).toBeUndefined();
  });
  it('APP_ENV and the app scheme are plain words', () => {
    expect(cleanRuntimeValue('APP_ENV', 'QA')).toBe('QA');
    expect(cleanRuntimeValue('APP_ENV', 'QA</script>')).toBeUndefined();
    expect(cleanRuntimeValue('APP_RETURN_SCHEME', 'etgnative-qa')).toBe('etgnative-qa');
    expect(cleanRuntimeValue('APP_RETURN_SCHEME', 'https://x')).toBeUndefined();
  });
});

describe('the server reads the container, not the build', () => {
  it('reads NEXT_PUBLIC_* by computed name, with an ETG_PUBLIC_* override', () => {
    expect(
      readServerRuntimeConfig({
        NEXT_PUBLIC_API_URL: 'https://api-uat.example.com/api',
        NEXT_PUBLIC_APP_ENV: 'UAT',
        ETG_PUBLIC_ADMIN_URL: 'https://admin.example.com',
        NEXT_PUBLIC_ADMIN_URL: 'https://ignored.example.com',
        JWT_ACCESS_SECRET: 'never-served',
        DATABASE_URL: 'postgresql://never/served',
      }),
    ).toEqual({
      API_URL: 'https://api-uat.example.com/api',
      APP_ENV: 'UAT',
      ADMIN_URL: 'https://admin.example.com',
    });
  });
  it('serves only allowlisted keys, whatever else the container has', () => {
    const out = readServerRuntimeConfig({
      NEXT_PUBLIC_SECRET_THING: 'x',
      ETG_PUBLIC_DATABASE_URL: 'https://db.example.com',
    });
    expect(out).toEqual({});
  });
});

describe('the script', () => {
  it('assigns a frozen object and cannot be broken out of', () => {
    const js = runtimeConfigScript({ SITE_URL: 'https://x.example.com/</script><script>' });
    expect(js.startsWith(`window.${RUNTIME_CONFIG_GLOBAL}=Object.freeze(`)).toBe(true);
    expect(js).not.toContain('</script>');
    expect(js).not.toContain('<');
  });
  it('escapes the two characters JSON allows but a script line does not', () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const js = runtimeConfigScript({ SITE_URL: `https://x.example.com/${ls}${ps}` });
    expect(js).not.toContain(ls);
    expect(js).not.toContain(ps);
    expect(js).toContain('\\u2028');
    expect(js).toContain('\\u2029');
  });
});

describe('runtimeValue', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('in a browser, prefers the served value and falls back to the build value', () => {
    vi.stubGlobal('window', {
      [RUNTIME_CONFIG_GLOBAL]: { API_URL: 'https://api.prod.example/api' },
    });
    expect(runtimeValue('API_URL', 'https://api-qa.example/api')).toBe(
      'https://api.prod.example/api',
    );
    expect(runtimeValue('ADMIN_URL', 'https://admin-qa.example')).toBe('https://admin-qa.example');
  });
  it('in a browser without the script (an old page), uses the build value', () => {
    vi.stubGlobal('window', {});
    expect(runtimeValue('API_URL', 'https://api-qa.example/api')).toBe(
      'https://api-qa.example/api',
    );
  });
  it('ignores a served value that does not look right', () => {
    vi.stubGlobal('window', { [RUNTIME_CONFIG_GLOBAL]: { API_URL: 'javascript:alert(1)' } });
    expect(runtimeValue('API_URL', 'https://api-qa.example/api')).toBe(
      'https://api-qa.example/api',
    );
  });
});
