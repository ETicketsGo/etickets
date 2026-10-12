import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  OFFSITE_BACKUP_EVIDENCE_ACTION as PRISMA_ACTION,
  makeClient,
  offsiteConfig,
  offsiteKey,
  sha256OfFile,
  uploadOffsite,
} from '../../prisma/backup-offsite';
import { OFFSITE_BACKUP_EVIDENCE_ACTION } from './backup-freshness';
import * as backup from '../../prisma/backup';

/*
  recordOpsEvidence shells out to psql against DATABASE_URL, which on a developer machine is the
  SHARED database. Replace it so the test can assert the evidence row without writing one.
*/
jest.mock('../../prisma/backup', () => ({
  ...jest.requireActual('../../prisma/backup'),
  recordOpsEvidence: jest.fn(() => true),
}));
const recordEvidence = backup.recordOpsEvidence as jest.Mock;

let dir: string;
let dump: { name: string; path: string };
const CONTENT = Buffer.from('PGDMP-pretend-custom-format-dump-' + 'x'.repeat(5000));
const SHA = createHash('sha256').update(CONTENT).digest('hex');
const ENV = {
  BACKUP_OFFSITE_BUCKET: 'etg-backups',
  BACKUP_OFFSITE_PREFIX: 'nightly',
  AWS_ACCESS_KEY_ID: 'test-key',
  AWS_SECRET_ACCESS_KEY: 'test-secret',
} as unknown as NodeJS.ProcessEnv;
const KEY = 'nightly/production/2026-10-12/etg-production-2026-10-12T02-00-00-000Z.dump';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'etg-offsite-test-'));
  dump = { name: 'etg-production-2026-10-12T02-00-00-000Z.dump', path: join(dir, 'x.dump') };
  writeFileSync(dump.path, CONTENT);
  recordEvidence.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('configuration', () => {
  it('is OFF unless a bucket is set (and then touches nothing)', async () => {
    expect(offsiteConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      offsiteConfig({ BACKUP_OFFSITE_BUCKET: '  ' } as unknown as NodeJS.ProcessEnv),
    ).toBeNull();
    const send = jest.fn();
    const r = await uploadOffsite(dump, { env: {} as NodeJS.ProcessEnv, client: { send } });
    expect(r.status).toBe('disabled');
    expect(send).not.toHaveBeenCalled();
    expect(recordEvidence).not.toHaveBeenCalled();
  });

  it('defaults to ap-south-1 and SSE-S3, and supports KMS and an opt-out', () => {
    const c = offsiteConfig(ENV)!;
    expect(c.region).toBe('ap-south-1');
    expect(c.sse).toBe('AES256');
    const kms = offsiteConfig({ ...ENV, BACKUP_OFFSITE_KMS_KEY_ID: 'alias/etg' })!;
    expect(kms.sse).toBe('aws:kms');
    expect(kms.kmsKeyId).toBe('alias/etg');
    expect(offsiteConfig({ ...ENV, BACKUP_OFFSITE_SSE: 'none' })!.sse).toBeNull();
  });
});

describe('key naming', () => {
  it('nests by environment and UTC date and keeps the unique timestamped name', () => {
    expect(offsiteKey('nightly', dump.name)).toBe(KEY);
    expect(offsiteKey('', dump.name)).toBe(`production/2026-10-12/${dump.name}`);
  });
  it('two different runs never share a key', () => {
    const a = offsiteKey('p', 'etg-qa-2026-10-12T02-00-00-000Z.dump');
    const b = offsiteKey('p', 'etg-qa-2026-10-13T02-00-00-000Z.dump');
    expect(a).not.toBe(b);
  });
  it('does not let a name escape the prefix', () => {
    expect(offsiteKey('p', '../../evil.dump')).toBe('p/unknown/undated/evil.dump');
  });
});

describe('upload request (mocked client)', () => {
  const capture = () => {
    const inputs: Array<Record<string, unknown>> = [];
    const send = jest.fn(async (cmd: PutObjectCommand) => {
      inputs.push(cmd.input as unknown as Record<string, unknown>);
      return {};
    });
    return { send, inputs };
  };

  it('sends the SHA-256 as the store-verified checksum, metadata, SSE and If-None-Match', async () => {
    const { send, inputs } = capture();
    const r = await uploadOffsite(dump, { env: ENV, client: { send } });
    expect(r).toEqual({ status: 'uploaded', key: KEY, sha256: SHA, bytes: CONTENT.length });
    const i = inputs[0];
    expect(i.ChecksumSHA256).toBe(Buffer.from(SHA, 'hex').toString('base64'));
    expect(i.IfNoneMatch).toBe('*');
    expect(i.ServerSideEncryption).toBe('AES256');
    expect(i.Bucket).toBe('etg-backups');
    expect(i.ContentLength).toBe(CONTENT.length);
    expect((i.Metadata as Record<string, string>).sha256).toBe(SHA);
  });

  it('records the evidence row only after the store accepted the object', async () => {
    await uploadOffsite(dump, { env: ENV, client: { send: async () => ({}) } });
    expect(recordEvidence).toHaveBeenCalledWith(PRISMA_ACTION, dump.name, {
      key: KEY,
      sha256: SHA,
      bytes: CONTENT.length,
    });
  });

  it('never overwrites: a refused write is reported as exists, with no evidence row and no retry', async () => {
    const send = jest.fn().mockRejectedValue(
      Object.assign(new Error('exists'), {
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      }),
    );
    const r = await uploadOffsite(dump, { env: ENV, client: { send } });
    expect(r.status).toBe('exists');
    expect(send).toHaveBeenCalledTimes(1);
    expect(recordEvidence).not.toHaveBeenCalled();
  });

  it('passes the KMS key id only with aws:kms', async () => {
    const { send, inputs } = capture();
    await uploadOffsite(dump, {
      env: { ...ENV, BACKUP_OFFSITE_KMS_KEY_ID: 'k-1' },
      client: { send },
    });
    expect(inputs[0].ServerSideEncryption).toBe('aws:kms');
    expect(inputs[0].SSEKMSKeyId).toBe('k-1');
  });
});

describe('failure keeps the local dump', () => {
  it('retries a transient failure, then reports failed without throwing, leaving the file intact', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = jest.fn().mockRejectedValue(
      Object.assign(new Error('boom https://secret.example/x AKIAABCDEFGHIJKLMNOP'), {
        name: 'ServiceUnavailable',
        $metadata: { httpStatusCode: 503 },
      }),
    );
    const r = await uploadOffsite(dump, { env: ENV, client: { send }, retryDelayMs: 1 });
    expect(r.status).toBe('failed');
    expect(send).toHaveBeenCalledTimes(3);
    expect(r.sha256).toBe(SHA);
    // Stable code, no URL and no key id in the log.
    const logged = String(err.mock.calls[0][0]);
    expect(logged).toContain('BACKUP_OFFSITE_FAILED');
    expect(logged).not.toMatch(/secret\.example|AKIA/);
    // The local recovery point is untouched, byte for byte.
    expect(readdirSync(dir)).toEqual(['x.dump']);
    expect(readFileSync(dump.path).equals(CONTENT)).toBe(true);
    expect(recordEvidence).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('does not retry a permanent client error (bad credentials, rejected checksum)', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = jest.fn().mockRejectedValue(
      Object.assign(new Error('denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
    );
    const r = await uploadOffsite(dump, { env: ENV, client: { send }, retryDelayMs: 1 });
    expect(r.status).toBe('failed');
    expect(send).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('a missing file is a failure result, not an exception', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await uploadOffsite({ name: dump.name, path: join(dir, 'gone.dump') }, { env: ENV });
    expect(r.status).toBe('failed');
    err.mockRestore();
  });
});

describe('the db-seed image constraints', () => {
  it('the two copies of the evidence constant agree', () => {
    expect(PRISMA_ACTION).toBe(OFFSITE_BACKUP_EVIDENCE_ACTION);
  });

  it('prisma/backup-offsite.ts imports nothing from src/ (the runtime image has no apps/api/src)', () => {
    const src = readFileSync(join(__dirname, '../../prisma/backup-offsite.ts'), 'utf8');
    const imports = [...src.matchAll(/^import [^;]*? from '([^']+)'/gm)].map((m) => m[1]);
    for (const i of imports) {
      expect(i.startsWith('node:') || i.startsWith('@aws-sdk/') || i === './backup').toBe(true);
    }
  });
});

describe('real SDK against an in-process S3-compatible server', () => {
  /*
    Not Docker/MinIO: a small HTTP server that enforces the two behaviours that matter, so the
    REAL SDK's serialisation of ChecksumSHA256 / If-None-Match is exercised on the wire.
    It is a fake, so it proves our requests are well-formed, not that AWS accepts them.
  */
  let server: Server;
  let endpoint: string;
  const store = new Map<string, Buffer>();
  const seen: Array<Record<string, string | string[] | undefined>> = [];

  const readBody = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = await readBody(req);
      seen.push(req.headers);
      const key = decodeURIComponent(req.url ?? '').split('?')[0];
      if (req.method !== 'PUT') {
        res.statusCode = 405;
        return res.end();
      }
      if (req.headers['if-none-match'] === '*' && store.has(key)) {
        res.statusCode = 412;
        res.setHeader('content-type', 'application/xml');
        return res.end('<Error><Code>PreconditionFailed</Code></Error>');
      }
      const want = req.headers['x-amz-checksum-sha256'];
      const got = createHash('sha256').update(body).digest('base64');
      if (want !== got) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/xml');
        return res.end('<Error><Code>BadDigest</Code></Error>');
      }
      store.set(key, body);
      res.statusCode = 200;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const env = () => ({ ...ENV, BACKUP_OFFSITE_ENDPOINT: endpoint }) as NodeJS.ProcessEnv;

  it('stores byte-identical content once, and a second upload cannot replace it', async () => {
    const e = env();
    const first = await uploadOffsite(dump, { env: e, client: makeClient(offsiteConfig(e)!, e) });
    expect(first.status).toBe('uploaded');
    const key = `/etg-backups/${first.key}`;
    expect(store.get(key)!.equals(CONTENT)).toBe(true);
    expect(await sha256OfFile(dump.path)).toBe(SHA);

    // A changed local file with the SAME name must not replace the stored object.
    writeFileSync(dump.path, Buffer.from('different bytes'));
    const second = await uploadOffsite(dump, { env: e, client: makeClient(offsiteConfig(e)!, e) });
    expect(second.status).toBe('exists');
    expect(store.get(key)!.equals(CONTENT)).toBe(true);
    const h = seen[seen.length - 1];
    expect(h['if-none-match']).toBe('*');
    expect(h['x-amz-server-side-encryption']).toBe('AES256');
  });

  it('the store rejects corrupted bytes (checksum mismatch) and we report failed', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const e = env();
    const realClient = makeClient(offsiteConfig(e)!, e);
    // Corrupt the body in flight, after the checksum header was computed from the real file.
    const corrupting = {
      send: (cmd: PutObjectCommand) => {
        const body = Buffer.from('corrupted in transit');
        cmd.input.Body = body;
        cmd.input.ContentLength = body.length;
        return realClient.send(cmd);
      },
    };
    const d2 = { name: 'etg-production-2026-10-13T02-00-00-000Z.dump', path: dump.path };
    const r = await uploadOffsite(d2, { env: e, client: corrupting, retryDelayMs: 1 });
    expect(r.status).toBe('failed');
    expect([...store.keys()].some((k) => k.includes('2026-10-13'))).toBe(false);
    err.mockRestore();
  });
});
