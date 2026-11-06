#!/usr/bin/env node
/**
 * Backward-compatibility gate for Prisma migrations.
 *
 * WHY. A deploy runs `prisma migrate deploy` once, then starts the NEW image. A rollback
 * redeploys the OLD image against the SAME, already-migrated database (there are no down
 * migrations). And during a rolling deploy with two replicas, old and new code run at once. So
 * every migration must leave the schema usable by the previous release: expand now, contract
 * in a later release once nothing reads the old shape.
 *
 * WHAT. Each NEW migration.sql (added since --base, or every one with --all) is scanned for
 * statements the previous release cannot survive:
 *   DROP TABLE / DROP COLUMN / RENAME / ALTER COLUMN ... TYPE / SET NOT NULL /
 *   ADD COLUMN ... NOT NULL without DEFAULT / DROP TYPE / RENAME VALUE / TRUNCATE / DELETE FROM
 * A file may acknowledge them with a line
 *   -- migration-compat: <why the previous release is still safe>
 * which turns its findings into notes. The reason is printed, so a reviewer reads it.
 *
 *   node scripts/deploy/check-migration-compat.mjs --base origin/main   # CI / before a PR
 *   node scripts/deploy/check-migration-compat.mjs --all                # report on history
 *
 * Exit 1 when a new migration has an unacknowledged finding.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'apps/api/prisma/migrations';
const args = process.argv.slice(2);
const all = args.includes('--all');
const baseIdx = args.indexOf('--base');
const base = baseIdx >= 0 ? args[baseIdx + 1] : null;
const filesIdx = args.indexOf('--files');
const explicit = filesIdx >= 0 ? args[filesIdx + 1].split(',').filter(Boolean) : null;
if (!all && !base && !explicit) {
  console.error(
    'Pass --base <git ref> (new migrations since that ref), --files a.sql,b.sql or --all.',
  );
  process.exit(2);
}

const RULES = [
  [/\bDROP\s+TABLE\b/i, 'drops a table the previous release may still read'],
  [/\bDROP\s+COLUMN\b/i, 'drops a column the previous release may still read or write'],
  [/\bRENAME\s+(COLUMN|TO|CONSTRAINT)\b/i, 'renames something the previous release names'],
  [/\bALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i, 'changes a column type'],
  [
    /\bALTER\s+COLUMN\s+"?\w+"?\s+SET\s+NOT\s+NULL\b/i,
    'makes a column required: the previous release may insert without it',
  ],
  [
    /\bADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?"?\w+"?\s+[^,;]*\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/i,
    'adds a required column with no default: the previous release cannot insert',
  ],
  [/\bDROP\s+TYPE\b/i, 'drops an enum or type'],
  [/\bRENAME\s+VALUE\b/i, 'renames an enum value the previous release writes'],
  [/\bTRUNCATE\b/i, 'deletes every row of a table'],
  [/\bDELETE\s+FROM\b/i, 'deletes rows'],
];

function newFiles() {
  if (explicit) return explicit;
  if (all) {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(DIR, d.name, 'migration.sql'))
      .filter((p) => existsSync(p));
  }
  const out = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=A', base, 'HEAD', '--', `${DIR}/*/migration.sql`],
    { encoding: 'utf8' },
  );
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** SQL without comments, split into statements; function bodies ($$...$$) kept whole. */
function statements(sql) {
  const noComments = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const parts = [];
  let buf = '';
  let inDollar = false;
  for (const piece of noComments.split(/(\$\$)/)) {
    if (piece === '$$') {
      inDollar = !inDollar;
      buf += piece;
      continue;
    }
    if (inDollar) {
      buf += piece;
      continue;
    }
    const chunks = piece.split(';');
    for (let i = 0; i < chunks.length; i++) {
      buf += chunks[i];
      if (i < chunks.length - 1) {
        parts.push(buf.trim());
        buf = '';
      }
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}

const files = newFiles();
let failed = 0;
const report = [];
for (const file of files) {
  const sql = readFileSync(file, 'utf8');
  const ack = sql.match(/^--\s*migration-compat:\s*(.+)$/im)?.[1]?.trim() ?? null;
  const findings = [];
  for (const stmt of statements(sql)) {
    // A function or trigger body is not a schema change by itself.
    if (/^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER)\b/i.test(stmt)) continue;
    for (const [re, why] of RULES) {
      if (re.test(stmt)) findings.push({ why, statement: stmt.replace(/\s+/g, ' ').slice(0, 160) });
    }
  }
  if (findings.length === 0) continue;
  const blocking = !ack;
  if (blocking) failed++;
  report.push({ file, acknowledged: ack, findings });
}

for (const r of report) {
  console.log(`${r.acknowledged ? 'NOTE' : 'FAIL'}  ${r.file}`);
  if (r.acknowledged) console.log(`      acknowledged: ${r.acknowledged}`);
  for (const f of r.findings) console.log(`      - ${f.why}\n        ${f.statement}`);
}
console.log(
  `${files.length} migration(s) checked, ${report.length} with findings, ${failed} unacknowledged.`,
);
if (failed > 0 && !all) {
  console.log(
    'Make it expand-only (add, never drop or rename, in the same release), or add a line\n' +
      '  -- migration-compat: <why the previous release still works>\n' +
      'to the migration after checking the previous release against it.',
  );
  process.exit(1);
}
