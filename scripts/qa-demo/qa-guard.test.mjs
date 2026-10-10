// Run with: node --test scripts/qa-demo/qa-guard.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_QA_API, qaTargetVerdict } from './qa-guard.mjs';

describe('qaTargetVerdict', () => {
  it('allows the QA API under both of its host names', () => {
    assert.equal(qaTargetVerdict(DEFAULT_QA_API).allowed, true);
    assert.equal(qaTargetVerdict('https://api-qa-f580.up.railway.app/api').allowed, true);
    assert.equal(qaTargetVerdict('https://API-QA.eticketsgo.com/api/').apiBase, DEFAULT_QA_API);
  });

  it('refuses UAT, production and anything it does not recognise', () => {
    for (const target of [
      'https://api-uat.eticketsgo.com/api',
      'https://api.eticketsgo.com/api',
      'https://eticketsgo.com/api',
      'https://api-qa.eticketsgo.com.evil.example/api',
      'https://evil.example/api-qa.eticketsgo.com/api',
      'http://localhost:4000/api',
      '',
      undefined,
      'not a url',
    ]) {
      assert.equal(qaTargetVerdict(target).allowed, false, `should refuse ${target}`);
    }
  });

  it('refuses plain http, credentials, ports and other paths even on the QA host', () => {
    assert.equal(qaTargetVerdict('http://api-qa.eticketsgo.com/api').allowed, false);
    assert.equal(qaTargetVerdict('https://u:p@api-qa.eticketsgo.com/api').allowed, false);
    assert.equal(qaTargetVerdict('https://api-qa.eticketsgo.com:8443/api').allowed, false);
    assert.equal(qaTargetVerdict('https://api-qa.eticketsgo.com/v2').allowed, false);
  });
});
