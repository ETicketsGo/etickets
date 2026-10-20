import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { SNS_FETCH, SnsVerifier, type SnsEnvelope } from './sns-verifier';
import {
  redactedSubscribeUrl,
  validateSubscribeUrl,
  type SubscribeUrlRejection,
} from './sns-subscribe-url';

/** What an operator is told. Never the URL, the token or the SubscriptionArn. */
export interface ConfirmationSummary {
  id: string;
  topicArn: string;
  status: string;
  receivedAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  attemptCount: number;
  lastFailure: string | null;
}

/**
 * The outcome of handling one SubscriptionConfirmation.
 *
 * - `confirmed`: Amazon accepted ConfirmSubscription during this request.
 * - `already_confirmed`: this topic and token were confirmed before; nothing was fetched.
 * - `in_progress`: another request holds the lease on this token right now; nothing fetched.
 * - `refused`: the message failed a check; nothing was fetched and nothing was written.
 * - `failed`: every check passed but Amazon's answer was not a confirmation. SNS should send
 *   it again, so the webhook answers 5xx for this one.
 */
export type ConfirmationOutcome =
  | { kind: 'confirmed' }
  | { kind: 'already_confirmed' }
  | { kind: 'in_progress' }
  | { kind: 'refused'; reason: ConfirmationRefusal }
  | { kind: 'failed'; reason: ConfirmFetchFailure };

export type ConfirmationRefusal =
  'topic_allowlist_unset' | 'topic_not_allowed' | 'message_id_missing' | SubscribeUrlRejection;

export type ConfirmFetchFailure =
  'timeout' | 'network_error' | 'redirect_refused' | `http_${number}` | 'unexpected_response';

/** Three days, which is how long AWS honours a subscription confirmation token. */
const TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
/** Amazon answers ConfirmSubscription in well under a second; SNS waits ~15 s for our reply. */
const CONFIRM_TIMEOUT_MS = 5_000;
/** A request that claimed a token and died is presumed gone after this. */
const ATTEMPT_LEASE_MS = 30_000;
/** A ConfirmSubscriptionResponse is a few hundred bytes. */
const MAX_RESPONSE_CHARS = 16_384;

/**
 * Confirming the SES event topic's SNS subscription, automatically and safely (ADR-054).
 *
 * ── WHY IT IS AUTOMATIC NOW ────────────────────────────────────────────────────────
 * ADR-052 refused to auto-confirm because a valid signature proves the SENDER, not that we
 * WANT the subscription: anybody with an AWS account can create a topic and point it at this
 * URL. That objection is answered by the topic allowlist, not by a person. SES_SNS_TOPIC_ARNS
 * is where somebody already decides, deliberately, which topic this environment trusts; a
 * confirmation is acted on only for a topic named there, exactly. The manual step added a
 * person who could only re-check the same thing -- and in production, where the token was
 * deliberately never stored, it could not be done at all.
 *
 * ── WHAT MUST ALL HOLD BEFORE ANYTHING IS FETCHED ──────────────────────────────────
 * 1. The path secret (checked by the webhook before the body is read).
 * 2. The SNS signature, with a certificate from an Amazon signing host (SnsVerifier).
 * 3. The TopicArn is in SES_SNS_TOPIC_ARNS. An unset list refuses: it has chosen nothing.
 * 4. The SubscribeURL is Amazon's ConfirmSubscription for that same topic and token, on the
 *    regional SNS host the TopicArn names (validateSubscribeUrl).
 * Then exactly one GET, no redirects, a short timeout -- and only to the URL check 4 returned.
 *
 * ── WHY NO TOKEN IS EVER AT REST ───────────────────────────────────────────────────
 * The token is spent in the same request it arrives in. The row keeps its SHA-256 (enough to
 * recognise a repeat, useless for confirming) and the URL with the token replaced. Logs and
 * audit entries carry the topic and a reason, never the URL, the token or the SubscriptionArn.
 *
 * ── WHY IT DOES NOT DEPEND ON APP_ENV ──────────────────────────────────────────────
 * The checks are the same in every environment, so production is not a special case with its
 * own untested path. What differs per environment is configuration: each one names its own
 * topic.
 */
@Injectable()
export class SnsConfirmationService {
  private readonly logger = new Logger('NotificationWebhook');
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly verifier: SnsVerifier,
    /* See SnsVerifier: an @Optional token, never a default parameter, or Nest cannot boot. */
    @Optional() @Inject(SNS_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /**
   * Handle a SubscriptionConfirmation whose path secret and signature have ALREADY been
   * verified by the caller.
   */
  async handle(envelope: SnsEnvelope, now: Date = new Date()): Promise<ConfirmationOutcome> {
    const topicArn = envelope.TopicArn;
    if (!this.config.get<string>('SES_SNS_TOPIC_ARNS')?.trim()) {
      return this.refuse(topicArn, 'topic_allowlist_unset');
    }
    if (!this.verifier.isTopicAllowed(topicArn)) return this.refuse(topicArn, 'topic_not_allowed');

    const verdict = validateSubscribeUrl(envelope);
    if (!verdict.ok) return this.refuse(topicArn, verdict.reason);
    if (!envelope.MessageId) return this.refuse(topicArn, 'message_id_missing');

    const tokenHash = createHash('sha256').update(verdict.token, 'utf8').digest('hex');
    const row = await this.findOrCreate({
      topicArn: verdict.topicArn,
      tokenHash,
      messageId: envelope.MessageId,
      subscribeUrl: redactedSubscribeUrl(verdict),
      now,
    });

    if (row.status === 'CONFIRMED') {
      // A redelivery, or a replay of a message we already acted on. Nothing is fetched, so a
      // replay cannot re-subscribe an endpoint somebody has since unsubscribed.
      this.logger.log(`SNS subscription for topic ${verdict.topicArn} already confirmed; no-op.`);
      return { kind: 'already_confirmed' };
    }

    /*
      The lease. Two deliveries of the same token arriving together must not both call Amazon:
      only the request whose update matches takes the attempt. A request that died mid-call
      leaves a lease that ages out, so the token is never stuck.
    */
    const claimed = await this.prisma.snsPendingConfirmation.updateMany({
      where: {
        id: row.id,
        status: 'PENDING',
        OR: [
          { lastAttemptAt: null },
          { lastAttemptAt: { lt: new Date(now.getTime() - ATTEMPT_LEASE_MS) } },
        ],
      },
      data: { lastAttemptAt: now, attemptCount: { increment: 1 } },
    });
    if (claimed.count !== 1) return { kind: 'in_progress' };

    const result = await this.confirmAtAmazon(verdict.url, verdict.topicArn);
    if (!result.ok) {
      await this.prisma.snsPendingConfirmation.update({
        where: { id: row.id },
        // Lease released so SNS's retry can try again at once.
        data: { lastFailure: result.reason, lastAttemptAt: null },
      });
      this.logger.warn(
        `SNS subscription confirmation for topic ${verdict.topicArn} failed (${result.reason}); ` +
          'SNS will redeliver, or use Request confirmation in the SNS console.',
      );
      await this.audit.record({
        action: 'SNS_SUBSCRIPTION_CONFIRM_FAILED',
        entityType: 'SnsPendingConfirmation',
        entityId: row.id,
        metadata: { topicArn: verdict.topicArn, reason: result.reason },
      });
      return { kind: 'failed', reason: result.reason };
    }

    await this.prisma.snsPendingConfirmation.update({
      where: { id: row.id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: now,
        subscriptionArn: result.subscriptionArn,
        lastFailure: null,
      },
    });
    // Anything older still waiting for this topic -- including rows from the retired manual
    // flow -- is now moot.
    await this.prisma.snsPendingConfirmation.updateMany({
      where: { topicArn: verdict.topicArn, status: 'PENDING', id: { not: row.id } },
      data: { status: 'EXPIRED' },
    });
    this.logger.warn(
      `SNS subscription CONFIRMED automatically for topic ${verdict.topicArn} ` +
        '(signature, topic allowlist and SubscribeURL verified).',
    );
    await this.audit.record({
      action: 'SNS_SUBSCRIPTION_CONFIRMED',
      entityType: 'SnsPendingConfirmation',
      entityId: row.id,
      // Topic and environment only: never the URL, the token or the SubscriptionArn.
      metadata: {
        topicArn: verdict.topicArn,
        appEnv: this.config.get<string>('APP_ENV') ?? null,
        automatic: true,
      },
    });
    return { kind: 'confirmed' };
  }

  /** The latest confirmation record, for the admin console. Never the URL or the token. */
  async status(): Promise<ConfirmationSummary | null> {
    const row = await this.prisma.snsPendingConfirmation.findFirst({
      orderBy: { receivedAt: 'desc' },
    });
    if (!row) return null;
    return {
      id: row.id,
      topicArn: row.topicArn,
      status: row.status,
      receivedAt: row.receivedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
      attemptCount: row.attemptCount,
      lastFailure: row.lastFailure,
    };
  }

  private refuse(topicArn: string | undefined, reason: ConfirmationRefusal): ConfirmationOutcome {
    /*
      The reason and the topic. The topic is a signed field of a verified message; the URL is
      never echoed, because its query string carries the token.
    */
    const topic = typeof topicArn === 'string' && topicArn.length <= 300 ? topicArn : '(none)';
    this.logger.warn(
      `SNS SubscriptionConfirmation refused (${reason}) for topic ${topic}; not confirmed.`,
    );
    return { kind: 'refused', reason };
  }

  private async findOrCreate(input: {
    topicArn: string;
    tokenHash: string;
    messageId: string;
    subscribeUrl: string;
    now: Date;
  }) {
    const { topicArn, tokenHash, messageId, subscribeUrl, now } = input;
    const where = { OR: [{ topicArn, tokenHash }, { messageId }] };
    const existing = await this.prisma.snsPendingConfirmation.findFirst({ where });
    if (existing) return existing;
    try {
      return await this.prisma.snsPendingConfirmation.create({
        data: {
          topicArn,
          tokenHash,
          messageId,
          subscribeUrl,
          receivedAt: now,
          expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
        },
      });
    } catch (err) {
      // Lost a race with a concurrent delivery of the same message: use the row it wrote.
      if ((err as { code?: string } | null)?.code !== 'P2002') throw err;
      const row = await this.prisma.snsPendingConfirmation.findFirst({ where });
      if (!row) throw err;
      return row;
    }
  }

  /**
   * The only outbound request this flow makes. `url` comes from validateSubscribeUrl and
   * nowhere else.
   */
  private async confirmAtAmazon(
    url: URL,
    topicArn: string,
  ): Promise<{ ok: true; subscriptionArn: string } | { ok: false; reason: ConfirmFetchFailure }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
    try {
      /*
        `redirect: 'manual'`: the URL was checked, the place a redirect points was not. A 3xx
        is reported as a failure and its Location is never requested.
      */
      const res = await this.fetchImpl(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        return { ok: false, reason: 'redirect_refused' };
      }
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, reason: `http_${res.status}` };
      }
      const body = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
      /*
        The answer must be a ConfirmSubscriptionResponse naming a subscription OF THIS TOPIC.
        A 200 that says anything else is not evidence the subscription exists.
      */
      const match = body.match(/<SubscriptionArn>\s*([^<\s]+)\s*<\/SubscriptionArn>/);
      if (
        !body.includes('ConfirmSubscriptionResponse') ||
        !match ||
        !match[1].startsWith(`${topicArn}:`)
      ) {
        return { ok: false, reason: 'unexpected_response' };
      }
      return { ok: true, subscriptionArn: match[1] };
    } catch {
      return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }
}
