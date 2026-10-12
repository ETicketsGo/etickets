// Run with: node --test scripts/showcase/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOCAL_API, localTargetVerdict } from './local-guard.mjs';

describe('localTargetVerdict', () => {
  it('allows an API on this machine, on any port', () => {
    assert.equal(localTargetVerdict(DEFAULT_LOCAL_API).allowed, true);
    assert.equal(localTargetVerdict('http://127.0.0.1:4131/api').allowed, true);
    assert.equal(localTargetVerdict('http://[::1]:4131/api').allowed, true);
    assert.equal(localTargetVerdict('http://localhost/api').allowed, true);
    assert.equal(localTargetVerdict('http://LOCALHOST:4131/api/').apiBase, DEFAULT_LOCAL_API);
  });

  it('refuses QA, UAT, production, Railway and anything it does not recognise', () => {
    for (const target of [
      'https://api-qa.eticketsgo.com/api',
      'https://api-uat.eticketsgo.com/api',
      'https://api.eticketsgo.com/api',
      'https://api-qa-f580.up.railway.app/api',
      'http://api-qa.eticketsgo.com/api',
      'http://localhost.eticketsgo.com/api',
      'http://localhost.evil.example:4131/api',
      'http://evil.example/localhost/api',
      'http://localhst:4131/api',
      'http://127.0.0.2:4131/api',
      'http://192.168.1.10:4131/api',
      'http://0.0.0.0:4131/api',
      '',
      undefined,
      'not a url',
      'localhost:4131/api',
    ]) {
      assert.equal(localTargetVerdict(target).allowed, false, `should refuse ${target}`);
    }
  });

  it('refuses https, credentials and other paths even on localhost', () => {
    assert.equal(localTargetVerdict('https://localhost:4131/api').allowed, false);
    assert.equal(localTargetVerdict('http://u:p@localhost:4131/api').allowed, false);
    assert.equal(localTargetVerdict('http://localhost:4131/v2').allowed, false);
    assert.equal(localTargetVerdict('http://localhost:4131/').allowed, false);
  });
});
