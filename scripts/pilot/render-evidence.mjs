#!/usr/bin/env node
/**
 * Renders <out>/<env>-results.json into markdown tables, one per release gate.
 *   node scripts/pilot/render-evidence.mjs C:/etg-wt/pilot-cert qa
 * Evidence ids are kept; nothing secret is ever in the results file (tokens are not recorded).
 */
import fs from 'node:fs';
import path from 'node:path';

const [out = 'C:/etg-wt/pilot-cert', env = 'qa'] = process.argv.slice(2);
const rows = JSON.parse(fs.readFileSync(path.join(out, `${env}-results.json`), 'utf8'));
const GATES = [
  ['infra', 'Infrastructure'],
  ['payments', 'Payments'],
  ['comms', 'Communications'],
  ['ops', 'Operations (check-in)'],
  ['authz', 'Authorization'],
  ['journey', 'Journey: onboarding to publish'],
  ['refund', 'Journey: refunds'],
  ['recon', 'Journey: reconciliation'],
  ['payout', 'Journey: payout'],
  ['failure', 'Failure and recovery'],
  ['harness', 'Harness'],
];
const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .slice(0, 420);
const tally = (g) =>
  ['PASS', 'FAIL', 'BLOCKED']
    .map((k) => `${rows.filter((r) => r.gate === g && r.status === k).length} ${k}`)
    .join(', ');
let md = '';
for (const [g, title] of GATES) {
  const list = rows.filter((r) => r.gate === g);
  if (!list.length) continue;
  md += `#### ${title} (${tally(g)})\n\n| Id | Step | Result | Evidence |\n| --- | --- | --- | --- |\n`;
  for (const r of list) md += `| ${r.id} | ${cell(r.step)} | **${r.status}** | ${cell(r.note)} |\n`;
  md += '\n';
}
const total = ['PASS', 'FAIL', 'BLOCKED']
  .map((k) => `${rows.filter((r) => r.status === k).length} ${k}`)
  .join(', ');
process.stdout.write(`Totals: ${total}\n\n${md}`);
