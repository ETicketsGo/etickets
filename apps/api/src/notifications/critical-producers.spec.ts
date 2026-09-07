import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { NotificationType } from '@eticketsgo/shared-types';
import { CRITICAL_TYPES, isCritical } from './policy/channel-policy';

/**
 * Every producer of a critical notification writes it inside the transaction it belongs to.
 *
 * ── WHY A TEST THAT READS THE SOURCE ───────────────────────────────────────────────
 * `sendCritical(tx, input)` takes the transaction client as its first, required argument, so
 * a caller of THAT method cannot forget it — the compiler will not allow it. What the
 * compiler cannot do is stop somebody reaching for `send()` instead, which is still the right
 * method for the twelve non-critical producers and still accepts a critical type.
 *
 * The instruction behind this file was to avoid a guarantee that depends on a future
 * developer remembering an optional parameter. A required first argument is most of that; a
 * runtime warning is the audible half; and this is the half that fails the build when
 * somebody adds the seventeenth producer next year and reaches for the familiar method.
 *
 * It scans source, which is unusual, and is worth it here because the property is a property
 * of the CALL SITES rather than of any one function's behaviour, and there is no other way
 * to observe it.
 */

const SRC = resolve(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Files that name a critical type without producing one: the policy tables that classify
 * them, the template that renders them, and the routing that carries them. Listed
 * explicitly rather than pattern-matched, so adding a file cannot quietly opt out.
 */
const NOT_PRODUCERS = new Set(
  [
    'notifications/policy/channel-policy.ts',
    'notifications/policy/notification-policy.ts',
    'notifications/policy/dedupe-key.ts',
    'notifications/message-class.ts',
    'notifications/templates/notification-template.service.ts',
    // A settings surface: it LISTS the types a customer can express a preference about, and
    // sends none of them.
    'notifications/notification-preferences.controller.ts',
    // A readiness report: it LISTS the types whose policy selects WhatsApp, so an operator
    // knows which templates to get approved. It reads delivery evidence and sends nothing.
    'notifications/readiness/market-certification.service.ts',
  ].map((p) => p.replace(/\//g, require('node:path').sep)),
);

/**
 * Producers whose durability comes from a SWEEP rather than from a transaction.
 *
 * ── WHY THIS EXEMPTION EXISTS, AND WHY IT IS NOT A LOOPHOLE ────────────────────────
 * `sendCritical(tx, …)` guarantees that a message is owed by writing it in the transaction
 * that makes the fact true. That is the right mechanism when the audience is one person.
 *
 * It is the wrong one when the audience is a sold-out cinema. A show cancellation must not
 * fan out to two thousand bookings inside the organizer's HTTP request, so the transaction
 * records the FACT — the domain event, and the session's own CANCELLED status — and the
 * fan-out happens afterwards. Losing a batch to a crash costs nothing, because "who still
 * needs telling" is re-derivable from the data at any moment.
 *
 * That is a different guarantee, not a weaker one, and the test below checks the mechanism
 * is actually present rather than taking the exemption on trust: a file listed here must
 * have a sweep, and that sweep must re-derive its work with a NOT EXISTS. Deleting either
 * fails the build, which is the whole point of naming them.
 */
const SWEEP_BACKED = new Map<string, string>([
  [
    'notifications/producers/show-cancellation-fanout.service.ts'.replace(
      /\//g,
      require('node:path').sep,
    ),
    'show cancellation fans out to a whole audience; the sweep re-derives who is left',
  ],
]);

interface Mention {
  file: string;
  line: number;
  text: string;
}

/** Every line in production source that names a critical notification type. */
function criticalMentions(): Mention[] {
  const found: Mention[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (NOT_PRODUCERS.has(rel)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const type of CRITICAL_TYPES) {
        if (text.includes(`NotificationType.${type}`)) {
          found.push({ file: rel, line: i + 1, text: text.trim() });
        }
      }
    });
  }
  return found;
}

/**
 * The call a mention belongs to. A `send({ type: X })` spans several lines, so this walks
 * backwards to the nearest `this.notifications.<method>(` above it.
 */
function enclosingCall(file: string, line: number): string | null {
  const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
  for (let i = line - 1; i >= 0 && i > line - 30; i--) {
    const m = lines[i].match(/notifications\s*[?.]*\.(\w+)\s*\(/);
    if (m) return m[1];
  }
  return null;
}

describe('critical notifications are produced transactionally', () => {
  it('names every file that produces one, so a new one cannot appear unnoticed', () => {
    /*
      The list, not a count. A new producer added next year fails this test by name, which is
      the moment to ask whether it belongs in a transaction — rather than discovering months
      later that one message class quietly lost the guarantee.
    */
    const sep = require('node:path').sep;
    const files = new Set(criticalMentions().map((m) => m.file));
    expect([...files].sort()).toEqual([
      ['notifications', 'producers', 'show-cancellation-fanout.service.ts'].join(sep),
      ['payments', 'payments.service.ts'].join(sep),
      ['payments', 'settlement', 'settlement.service.ts'].join(sep),
      ['refunds', 'refunds.service.ts'].join(sep),
      ['shows', 'shows.service.ts'].join(sep),
    ]);
  });

  it('every one of those files reaches the notification service transactionally', () => {
    /*
      A file-level check as well as the line-level one below, because a producer can put its
      send behind a private helper -- SettlementService does, and its critical type literal is
      thirty lines from the call. The line scan cannot see through that; this can.
    */
    const sep = require('node:path').sep;
    const offenders: string[] = [];
    for (const file of new Set(criticalMentions().map((m) => m.file))) {
      if (SWEEP_BACKED.has(file)) continue;
      const src = readFileSync(join(SRC, file), 'utf8');
      if (!/sendCritical|fanOutCritical/.test(src)) offenders.push(file);
    }
    expect(offenders.map((f) => f.split(sep).join('/'))).toEqual([]);
  });

  it('a sweep-backed producer really has the sweep it is exempted for', () => {
    /*
      The exemption is checked, not taken on trust. A file excused from `sendCritical` because
      its work is re-derivable has to actually re-derive it — a sweep, and a NOT EXISTS that
      finds who has not been told. Delete either and this fails, which is the only thing that
      makes naming the file honest rather than a way to silence the guard.
    */
    for (const [file, why] of SWEEP_BACKED) {
      const src = readFileSync(join(SRC, file), 'utf8');
      expect({ file: why, hasSweep: /\basync sweep\(/.test(src) }).toEqual({
        file: why,
        hasSweep: true,
      });
      expect({ file: why, reDerives: /NOT EXISTS/.test(src) }).toEqual({
        file: why,
        reDerives: true,
      });
    }
  });

  it('and no critical type is sent through the non-transactional method', () => {
    const offenders = criticalMentions()
      .filter((m) => !SWEEP_BACKED.has(m.file))
      .map((m) => ({ ...m, call: enclosingCall(m.file, m.line) }))
      .filter((m) => m.call !== null)
      .filter((m) => !['sendCritical', 'fanOutCritical'].includes(m.call as string));

    /*
      A failure here means somebody produced a critical notification with `send()`. The
      message still goes out — the runtime guard makes sure of that — but it is enqueued
      AFTER the commit, which reopens the crash window this phase closed: money taken,
      booking confirmed, process dies, confirmation never recorded and never retried.
    */
    expect(
      offenders.map((o) => `${o.file}:${o.line} uses ${o.call}() — use sendCritical(tx, …)`),
    ).toEqual([]);
  });

  it('the SHOW_CHANGED producer fans out rather than looping', () => {
    // A sold-out house is hundreds of rows written while a screen row is locked for
    // scheduling. One statement, not one per booking.
    const showsSrc = readFileSync(join(SRC, 'shows', 'shows.service.ts'), 'utf8');
    expect(showsSrc).toContain('fanOutCritical');
    expect(showsSrc).toContain('NotificationType.SHOW_CHANGED');
  });
});

describe('what counts as critical', () => {
  it('is the set of messages whose loss is a customer-facing failure', () => {
    expect([...CRITICAL_TYPES].sort()).toEqual([
      'BOOKING_CANCELLED',
      'BOOKING_CONFIRMED',
      'REFUND_COMPLETED',
      'SETTLEMENT_RELEASED',
      'SHOW_CANCELLED',
      'SHOW_CHANGED',
    ]);
  });

  it('does not include messages that are merely useful', () => {
    // A reminder that never arrives costs somebody a nudge. These are not that.
    expect(isCritical(NotificationType.EVENT_REMINDER)).toBe(false);
    expect(isCritical(NotificationType.SHARE_VIEWED)).toBe(false);
    expect(isCritical(NotificationType.PAYMENT_FAILED)).toBe(false);
  });
});
