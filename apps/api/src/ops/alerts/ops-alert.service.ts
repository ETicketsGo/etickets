import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationType } from '@eticketsgo/shared-types';
import { RedisService } from '../../redis/redis.service';
import {
  EMAIL_TRANSPORT,
  type EmailTransport,
} from '../../notifications/channels/transports/email.transport';

/**
 * The money-critical failures somebody must hear about the same day.
 *
 * Each one is a case where a customer's money and our records can disagree, and where the
 * platform already does the right thing (records it, holds stock, files a discrepancy) but
 * until now told nobody. See `docs/incidents/2026-10-06-payment-capture-without-confirmation.md`.
 */
export type OpsAlertKind =
  | 'WEBHOOK_SIGNATURE_REJECTED'
  | 'CAPTURE_NOT_APPLIED'
  | 'EXPIRY_FOUND_CAPTURE'
  | 'FINANCE_DISCREPANCY_OPENED'
  | 'CONFIRMATION_FAILED_AFTER_PAYMENT'
  | 'WEBHOOK_DEAD_LETTERED'
  | 'NOTIFICATION_FAILED'
  | 'PILOT_AUTO_PAUSED'
  /** The daily sign-in-code SMS budget was reached (or neared). See auth/otp-sms-guard.ts. */
  | 'OTP_SMS_BUDGET'
  /*
    Security signals (security-audit-alerts.ts, auth/login-backoff.ts). Not money, but each one
    is a moment where somebody may be inside an account, or changing who holds power, and the
    audit log alone is read only after the fact.
  */
  /** A spent refresh token was presented again: a session secret is in two places. */
  | 'AUTH_REFRESH_TOKEN_REUSE'
  /** A back-office account was locked after too many wrong second-factor codes. */
  | 'ADMIN_MFA_LOCKOUT'
  /** Back-office duties granted, changed or removed, or a back-office account suspended. */
  | 'ADMIN_ACCESS_CHANGED'
  /** Many different accounts started a sign-in wait in one window: password guessing at scale. */
  | 'LOGIN_BACKOFF_BURST';

/** A fact printed in the alert. Ids, amounts, codes and statuses only - never a person. */
export type OpsAlertFact = string | number | boolean | null | undefined;

export interface OpsAlert {
  kind: OpsAlertKind;
  /**
   * What repeats are grouped by inside one throttle window: the provider for a rejected
   * webhook, the provider reference for a capture, the booking for a failed confirmation.
   * Must not identify a person.
   */
  key: string;
  /** One line. It becomes the email subject. */
  summary: string;
  facts: Record<string, OpsAlertFact>;
  /** Where an operator looks first. */
  where: string;
}

export interface OpsAlertResult {
  /** True when this occurrence produced an alert (logged, and emailed if configured). */
  raised: boolean;
  /** Occurrences since the previous alert for the same kind and key, this one included. */
  count: number;
  /** How many recipients the email reached. 0 when not configured or every send failed. */
  delivered: number;
}

export interface OpsAlertStatus {
  /** True only when there is at least one recipient AND a real email provider. */
  configured: boolean;
  status: 'configured' | 'not_configured';
  /** Why it is not configured, in plain words. Null when configured. */
  reason: string | null;
  recipients: number;
  emailProvider: string;
  lastAlertAt: string | null;
  lastAlertKind: OpsAlertKind | null;
}

/** Fifteen minutes, per the owner's brief: the first one, then at most one per window. */
export const DEFAULT_THROTTLE_MS = 15 * 60 * 1000;

/**
 * Kinds whose key is ONE entity (a booking, a capture). A retry loop on the same booking would
 * otherwise mail every fifteen minutes for as long as it retries; one alert per entity per six
 * hours is enough to start a person on it.
 */
const PER_ENTITY_THROTTLE_MS = 6 * 60 * 60 * 1000;
/**
 * The SMS budget alert is keyed by phase, budget and UTC day, so each distinct event already
 * has its own key. A day-long window means an attack that keeps hitting a spent budget (or a
 * Postgres fallback that cannot share the "already alerted" flag) is still ONE email that day.
 */
const PER_DAY_THROTTLE_MS = 24 * 60 * 60 * 1000;
const THROTTLE_MS: Record<OpsAlertKind, number> = {
  WEBHOOK_SIGNATURE_REJECTED: DEFAULT_THROTTLE_MS,
  CAPTURE_NOT_APPLIED: PER_ENTITY_THROTTLE_MS,
  EXPIRY_FOUND_CAPTURE: PER_ENTITY_THROTTLE_MS,
  FINANCE_DISCREPANCY_OPENED: DEFAULT_THROTTLE_MS,
  CONFIRMATION_FAILED_AFTER_PAYMENT: PER_ENTITY_THROTTLE_MS,
  WEBHOOK_DEAD_LETTERED: DEFAULT_THROTTLE_MS,
  NOTIFICATION_FAILED: DEFAULT_THROTTLE_MS,
  // Grouped by trigger. Each pause is written to the audit log; the email is the nudge.
  PILOT_AUTO_PAUSED: DEFAULT_THROTTLE_MS,
  OTP_SMS_BUDGET: PER_DAY_THROTTLE_MS,
  // Grouped as one kind: a replay storm is one email with a count, not one per account.
  AUTH_REFRESH_TOKEN_REUSE: DEFAULT_THROTTLE_MS,
  // Keyed by account: each locked account is named at once, then counted.
  ADMIN_MFA_LOCKOUT: DEFAULT_THROTTLE_MS,
  // Keyed by the account changed: role, duties and suspension of one person in one email.
  ADMIN_ACCESS_CHANGED: DEFAULT_THROTTLE_MS,
  // Keyed by window, and raised once per window by the counter itself (login-backoff.ts).
  LOGIN_BACKOFF_BURST: DEFAULT_THROTTLE_MS,
};

/**
 * Something that wants to act on every occurrence, not only on the throttled email: the pilot's
 * automatic pause (apps/api/src/pilot). Called before the throttle, never awaited by `notify`.
 */
export type OpsAlertListener = (alert: OpsAlert) => unknown;

const REDIS_PREFIX = 'ops-alert';
const LAST_KEY = `${REDIS_PREFIX}:last`;
const MAX_FACT_LENGTH = 300;

const EMAIL_PATTERN = /[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+/g;
/** A value that is nothing but a phone number (8+ digits with the usual separators). */
const PHONE_ONLY = /^\+?[\d\s().-]{8,}$/;
/** A phone number inside prose: an international prefix and at least eight more digits. */
const PHONE_IN_TEXT = /\+\d[\d\s().-]{7,}\d/g;

/**
 * Strips anything that could identify a customer before it goes into a log line or an email.
 *
 * The callers only pass ids, amounts and codes, so this is the second line, not the first: it
 * exists because a discrepancy's `detail` and an exception message are prose, and prose is
 * where an address slips in unnoticed.
 */
export function redactForOps(value: string): string {
  const oneLine = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (PHONE_ONLY.test(oneLine) && (oneLine.match(/\d/g)?.length ?? 0) >= 8) return '[redacted]';
  const cleaned = oneLine
    .replace(EMAIL_PATTERN, '[redacted email]')
    .replace(PHONE_IN_TEXT, '[redacted phone]');
  return cleaned.length > MAX_FACT_LENGTH ? `${cleaned.slice(0, MAX_FACT_LENGTH)}...` : cleaned;
}

/** Comma-separated list, trimmed, anything that is not shaped like an address dropped. */
export function parseOpsAlertEmails(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

/**
 * Tells a person, by email, that a money-critical path has met something it could not handle.
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────────────────
 * On 2026-10-06 a real UPI payment was captured on production while every Razorpay webhook was
 * refused for a bad secret. The code logged an ERROR thirteen times and nobody read it for
 * days. This is the smallest thing that would have made a phone buzz: a short plain-text email
 * through the email transport the platform already runs (SES), to `OPS_ALERT_EMAILS`.
 *
 * ── THE RULES IT KEEPS ────────────────────────────────────────────────────────────
 * - It never throws and never makes a caller wait. `notify` swallows every failure, and the
 *   hooks call it without awaiting, so a broken SES or Redis cannot slow or fail a webhook, a
 *   confirmation or a sweep. What those paths decide and write is exactly what it was.
 * - Throttled per kind and key, shared across replicas through Redis (memory if Redis is
 *   down): the first occurrence alerts at once, then at most one per window, carrying how many
 *   happened since the last alert. A webhook storm is one email every fifteen minutes.
 * - Ids, amounts, statuses and codes only. Never a secret, a signature, card or UPI data, a
 *   customer's email or phone, or a payload. Every fact is redacted again on the way out.
 * - Unset recipients is not an error: the alert is logged at ERROR, and the admin ops health
 *   says "ops alerts: not configured".
 *
 * It goes straight to the transport rather than through NotificationService on purpose: an
 * alert about notifications failing must not be queued behind the notifications that are
 * failing, and an ops address is not a customer with preferences, consent or a locale.
 */
@Injectable()
export class OpsAlertService implements OnModuleInit {
  private readonly logger = new Logger('OpsAlert');
  private readonly recipients: string[];
  private readonly appEnv: string;
  /** Used when Redis is absent or refusing: per-process, so a restart forgets. */
  private readonly memory = new Map<string, { gateUntil: number; count: number }>();
  private memoryLast: { at: string; kind: OpsAlertKind } | null = null;
  private readonly listeners: OpsAlertListener[] = [];

  constructor(
    @Optional() private readonly config?: ConfigService,
    @Optional() @Inject(EMAIL_TRANSPORT) private readonly transport?: EmailTransport,
    @Optional() private readonly redis?: RedisService,
    /** For tests: a fixed clock. */
    @Optional() @Inject('OPS_ALERT_CLOCK') private readonly now: () => number = Date.now,
  ) {
    this.recipients = parseOpsAlertEmails(this.config?.get<string>('OPS_ALERT_EMAILS'));
    this.appEnv = this.config?.get<string>('APP_ENV') ?? 'LOCAL';
  }

  onModuleInit(): void {
    const s = this.describe();
    if (!s.configured) {
      // Once at boot, so a deployment without alerting says so where it starts.
      this.logger.warn(`Ops alerts are not configured: ${s.reason}`);
    }
  }

  /**
   * Record one occurrence and alert if the throttle allows. Never rejects.
   *
   * Callers use `void alerts.notify(...)`: the returned promise is for tests and for the rare
   * caller that has already finished its own work.
   */
  async notify(alert: OpsAlert): Promise<OpsAlertResult> {
    this.fanOut(alert);
    try {
      const gate = await this.claim(alert.kind, alert.key);
      if (!gate.won) return { raised: false, count: gate.count, delivered: 0 };
      const at = new Date(this.now()).toISOString();
      const { subject, body } = this.render(alert, gate.count, at);
      // Always logged at ERROR, configured or not: the log is the one place it cannot be lost.
      this.logger.error(`${subject} | ${body.replace(/\n+/g, ' | ')}`);
      const delivered = await this.send(subject, body);
      await this.markLast(at, alert.kind);
      return { raised: true, count: gate.count, delivered };
    } catch (err) {
      // An alert that cannot be raised must never become the caller's failure.
      this.logger.error(
        `Ops alert ${alert.kind} could not be raised: ${err instanceof Error ? err.message : err}`,
      );
      return { raised: false, count: 0, delivered: 0 };
    }
  }

  /**
   * Hear about every occurrence. The listener runs on its own promise: a slow or failing
   * listener cannot delay or fail `notify`, and so cannot reach the money path that called it.
   */
  subscribe(listener: OpsAlertListener): void {
    this.listeners.push(listener);
  }

  private fanOut(alert: OpsAlert): void {
    for (const listener of this.listeners) {
      void Promise.resolve()
        .then(() => listener(alert))
        .catch((err: unknown) =>
          this.logger.error(
            `Ops alert listener failed on ${alert.kind}: ${
              err instanceof Error ? redactForOps(err.message) : 'unknown error'
            }`,
          ),
        );
    }
  }

  /** Read-only status for the admin ops health. Never throws. */
  async status(): Promise<OpsAlertStatus> {
    const base = this.describe();
    let last = this.memoryLast;
    try {
      const raw = this.redis ? await this.redis.client.get(LAST_KEY) : null;
      if (raw) last = JSON.parse(raw) as { at: string; kind: OpsAlertKind };
    } catch {
      // Redis down: the in-process value is the best we have.
    }
    return { ...base, lastAlertAt: last?.at ?? null, lastAlertKind: last?.kind ?? null };
  }

  private describe(): Omit<OpsAlertStatus, 'lastAlertAt' | 'lastAlertKind'> {
    const emailProvider = this.transport?.name ?? 'none';
    const reason =
      this.recipients.length === 0
        ? 'OPS_ALERT_EMAILS is not set, so alerts are written to the log only.'
        : emailProvider === 'log' || emailProvider === 'none'
          ? `EMAIL_PROVIDER is ${emailProvider}, so alert emails are written to the log only.`
          : null;
    return {
      configured: reason === null,
      status: reason === null ? 'configured' : 'not_configured',
      reason,
      recipients: this.recipients.length,
      emailProvider,
    };
  }

  /**
   * Count this occurrence and decide whether it opens a new window.
   *
   * Redis first, because the API and the worker are separate processes and a webhook storm
   * hits every API replica: only a shared gate keeps it to one email. SET NX PX is the gate;
   * the counter is read and reset by whoever wins it, so the email says how many happened.
   */
  private async claim(kind: OpsAlertKind, key: string): Promise<{ won: boolean; count: number }> {
    const windowMs = THROTTLE_MS[kind] ?? DEFAULT_THROTTLE_MS;
    const id = `${kind}:${redactForOps(key).slice(0, 120)}`;
    if (this.redis) {
      try {
        const c = this.redis.client;
        const counterKey = `${REDIS_PREFIX}:count:${id}`;
        const seen = await c.incr(counterKey);
        // The counter outlives a few windows so a slow trickle is still counted, then goes.
        await c.pexpire(counterKey, windowMs * 4);
        const won = await c.set(`${REDIS_PREFIX}:gate:${id}`, '1', 'PX', windowMs, 'NX');
        if (won !== 'OK') return { won: false, count: seen };
        const total = await c.getset(counterKey, '0');
        return { won: true, count: Math.max(1, Number(total ?? seen) || seen) };
      } catch {
        // Fall through to the in-process gate.
      }
    }
    const now = this.now();
    if (this.memory.size > 1000) {
      // Bounded: keys include booking ids, and a long Redis outage must not grow this forever.
      for (const [k, v] of this.memory) if (v.gateUntil < now) this.memory.delete(k);
    }
    const entry = this.memory.get(id) ?? { gateUntil: 0, count: 0 };
    entry.count += 1;
    if (now < entry.gateUntil) {
      this.memory.set(id, entry);
      return { won: false, count: entry.count };
    }
    const count = entry.count;
    this.memory.set(id, { gateUntil: now + windowMs, count: 0 });
    return { won: true, count };
  }

  private render(alert: OpsAlert, count: number, at: string): { subject: string; body: string } {
    const env = redactForOps(this.appEnv);
    const subject = `[ETicketsGo ${env}] ${redactForOps(alert.summary)}`;
    const lines = [
      `What happened: ${redactForOps(alert.summary)}`,
      `Alert type: ${alert.kind}`,
      `Environment: ${env}`,
      `Time (UTC): ${at}`,
      count > 1
        ? `Occurrences: ${count} since the last alert of this type (throttled).`
        : 'Occurrences: 1',
      '',
      'Details:',
      ...Object.entries(alert.facts)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `- ${redactForOps(k)}: ${redactForOps(String(v))}`),
      '',
      `Where to look: ${redactForOps(alert.where)}`,
      '',
      'This message carries ids only. Customer details are in the admin console.',
    ];
    return { subject, body: lines.join('\n') };
  }

  /** One send per recipient; a failed send is logged and the rest still go. */
  private async send(subject: string, body: string): Promise<number> {
    if (!this.transport || this.recipients.length === 0) return 0;
    let delivered = 0;
    for (const toEmail of this.recipients) {
      try {
        await this.transport.send({
          /*
            Not a NotificationType: this message never enters the notification pipeline, so it
            has no template, preference or consent row. The transports read `type` only to
            label a log line.
          */
          type: 'OPS_ALERT' as NotificationType,
          channel: 'email',
          locale: 'en',
          toEmail,
          subject,
          body,
          html: null,
          payload: {},
        });
        delivered += 1;
      } catch (err) {
        this.logger.error(
          `Ops alert email could not be sent (${this.transport.name}): ${
            err instanceof Error ? redactForOps(err.message) : 'unknown error'
          }`,
        );
      }
    }
    return delivered;
  }

  private async markLast(at: string, kind: OpsAlertKind): Promise<void> {
    this.memoryLast = { at, kind };
    try {
      await this.redis?.client.set(LAST_KEY, JSON.stringify({ at, kind }));
    } catch {
      // Status falls back to the in-process value.
    }
  }
}
