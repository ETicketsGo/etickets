import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HEADER_LEN,
  decryptFile,
  encryptFile,
  keyFingerprint,
  parseBackupKey,
} from '../../prisma/backup-crypto';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'etg-crypto-test-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const key = randomBytes(32);
const plain = randomBytes(300_000); // several stream chunks

async function encrypted(): Promise<string> {
  const src = join(dir, 'a.dump');
  writeFileSync(src, plain);
  await encryptFile(src, join(dir, 'a.enc'), key);
  return join(dir, 'a.enc');
}

it('round-trips exactly, with a fresh IV every time', async () => {
  const enc = await encrypted();
  await decryptFile(enc, join(dir, 'out'), key);
  expect(readFileSync(join(dir, 'out')).equals(plain)).toBe(true);
  const src = join(dir, 'a.dump');
  await encryptFile(src, join(dir, 'b.enc'), key);
  expect(readFileSync(enc).equals(readFileSync(join(dir, 'b.enc')))).toBe(false);
});

it('names the key it needs and refuses the wrong one before decrypting anything', async () => {
  const enc = await encrypted();
  await expect(decryptFile(enc, join(dir, 'out'), randomBytes(32))).rejects.toThrow(/wrong key/);
  expect(existsSync(join(dir, 'out'))).toBe(false);
  expect(readFileSync(enc).subarray(8, 16).equals(keyFingerprint(key))).toBe(true);
});

it.each([
  ['a flipped ciphertext byte', (b: Buffer) => (b[HEADER_LEN + 10] ^= 1)],
  ['a flipped tag byte', (b: Buffer) => (b[b.length - 1] ^= 1)],
])('detects %s (authenticated, never restores garbage)', async (_l, flip) => {
  const enc = await encrypted();
  const b = readFileSync(enc);
  flip(b);
  writeFileSync(enc, b);
  await expect(decryptFile(enc, join(dir, 'out'), key)).rejects.toThrow();
});

it('detects truncation and a non-backup file', async () => {
  const enc = await encrypted();
  writeFileSync(enc, readFileSync(enc).subarray(0, 5000));
  await expect(decryptFile(enc, join(dir, 'o1'), key)).rejects.toThrow();
  writeFileSync(
    join(dir, 'x'),
    Buffer.from('PGDMP plain dump, not encrypted, long enough to read'),
  );
  await expect(decryptFile(join(dir, 'x'), join(dir, 'o2'), key)).rejects.toThrow(/bad header/);
});

it('parses base64 or hex keys, rejects anything that is not 32 bytes, never echoes the value', () => {
  expect(parseBackupKey(undefined)).toBeNull();
  expect(parseBackupKey('  ')).toBeNull();
  expect(parseBackupKey(key.toString('base64'))!.equals(key)).toBe(true);
  expect(parseBackupKey(key.toString('hex'))!.equals(key)).toBe(true);
  const bad = randomBytes(16).toString('base64');
  expect(() => parseBackupKey(bad)).toThrow(/32 bytes/);
  try {
    parseBackupKey(bad);
  } catch (e) {
    expect((e as Error).message).not.toContain(bad);
  }
});
