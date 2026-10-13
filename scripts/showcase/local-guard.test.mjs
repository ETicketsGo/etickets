// Run with: node --test scripts/showcase/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LOCAL_API,
  QA_API,
  localTargetVerdict,
  qaTargetVerdict,
  targetVerdict,
} from './local-guard.mjs';

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

describe('the QA target', () => {
  it('allows exactly the QA API host, with or without a trailing slash', () => {
    assert.equal(QA_API, 'https://api-qa-f580.up.railway.app/api');
    assert.equal(qaTargetVerdict(QA_API).allowed, true);
    assert.equal(qaTargetVerdict(`${QA_API}/`).allowed, true);
    assert.equal(qaTargetVerdict('HTTPS://API-QA-F580.UP.RAILWAY.APP/api').allowed, true);
    assert.equal(targetVerdict('qa', undefined).apiBase, QA_API);
  });

  it('refuses every other host: UAT, production, custom domains, other Railway hosts', () => {
    for (const target of [
      'https://api-qa.eticketsgo.com/api',
      'https://api-uat.eticketsgo.com/api',
      'https://api.eticketsgo.com/api',
      'https://api-prod.up.railway.app/api',
      'https://api-qa-f23c.up.railway.app/api',
      'https://api-qa-f580.up.railway.app.evil.example/api',
      'https://evil.example/api-qa-f580.up.railway.app/api',
      'http://api-qa-f580.up.railway.app/api',
      'https://api-qa-f580.up.railway.app:8443/api',
      'https://user:pw@api-qa-f580.up.railway.app/api',
      'https://api-qa-f580.up.railway.app/api?x=1',
      'https://api-qa-f580.up.railway.app/v2',
      'https://api-qa-f580.up.railway.app/',
      'http://localhost:4131/api',
      '',
      'not a url',
    ]) {
      assert.equal(targetVerdict('qa', target).allowed, false, `should refuse ${target}`);
    }
  });

  it('does not loosen the local rule, and an unknown target is refused', () => {
    assert.equal(targetVerdict('local', QA_API).allowed, false);
    assert.equal(targetVerdict(undefined, QA_API).allowed, false);
    assert.equal(targetVerdict('local', DEFAULT_LOCAL_API).allowed, true);
    assert.equal(targetVerdict('uat', QA_API).allowed, false);
    assert.equal(targetVerdict('prod', 'https://api.eticketsgo.com/api').allowed, false);
  });
});

describe('load-showcase.mjs refuses before any request', () => {
  const loader = fileURLToPath(new URL('./load-showcase.mjs', import.meta.url));
  const run = (...argv) =>
    spawnSync(process.execPath, [loader, '--dry-run', ...argv], {
      encoding: 'utf8',
      timeout: 20000,
    });

  it('exits 2 for a production, UAT or unknown host with --target qa', () => {
    for (const api of ['https://api.eticketsgo.com/api', 'https://api-uat.eticketsgo.com/api']) {
      const r = run('--target', 'qa', '--api', api);
      assert.equal(r.status, 2, api);
      assert.match(r.stderr, /REFUSED/);
    }
  });

  it('exits 2 for the QA host without --target qa, and for an unknown target', () => {
    assert.equal(run('--api', QA_API).status, 2);
    assert.equal(run('--target', 'prod').status, 2);
  });
});
