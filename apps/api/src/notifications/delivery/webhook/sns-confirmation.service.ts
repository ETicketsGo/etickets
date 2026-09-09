import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { AppException, ErrorCodes } from '../../../common/errors';
import { snsCaptureVerdict } from './sns-confirmation.guard';

/** What an operator is told without revealing anything. */
export interface PendingConfirmationSummary {
  id: string;
  topicArn: string;
  status: string;
  receivedAt: string;
  expiresAt: string;
  expired: boolean;
  revealed: boolean;
  revealedAt: string | null;
}

export interface RevealedConfirmation extends PendingConfirmationSummary {
  /** Present on the FIRST reveal only. */
  subscribeUrl: string;
}

/** Three days, which is how long AWS honours a subscription confirmation token. */
const TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Holding an SNS confirmation token long enough for a person to act on it.
 *
 * ── THE PROBLEM THIS SOLVES, PRECISELY ─────────────────────────────────────────────
 * The SES webhook refuses to auto-confirm a subscription, on purpose: a valid signature proves
 * the message came from Amazon, not that this platform wants to be subscribed to that topic.
 * Confirmation is therefore a deliberate human act.
 *
 * The token that authorises that act arrives exactly once, inside the message body, and the
 * handler logs only the SubscribeURL's host — because a token written to a log is a token in
 * every aggregator, backup, and screenshot from then on. The result was a design that required
 * a human step and gave the human no way to take it.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ──────────────────────────────────────────────────
 * It is not a secret store, and nothing else may be put in it. One row type, one shape of
 * value, one route, gone in seventy-two hours. A general "reveal a secret" facility is a
 * different and much larger decision, and building one as a side effect of a webhook fix is
 * how a platform acquires an unaudited credential viewer.
 *
 * ── THE ORDER OF THE TWO GATES MATTERS ─────────────────────────────────────────────
 * The SNS signature is checked by the caller BEFORE this service is reached, so an unsigned or
 * tampered message can never reach `capture` at all. The environment guard is checked INSIDE
 * capture as well, so a future caller that forgets the first gate still cannot write a token
 * into a production database.
 */
@Injectable()
export class SnsConfirmationService {
  private readonly logger = new Logger('NotificationWebhook');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private verdict() {
    return snsCaptureVerdict(this.config.get<string>('APP_ENV'));
  }

  /** Whether this environment may hold a token at all. Cheap, pure, and safe to call anywhere. */
  get enabled(): boolean {
    return this.verdict().allowed;
  }

  /**
   * Record a confirmation whose signature has ALREADY been verified by the caller.
   *
   * Returns silently in a production environment rather than throwing: this runs inside the
   * webhook request, and the correct behaviour for a message we will not store is still to
   * acknowledge it — refusing would make SNS redeliver a message that is not going to be
   * stored however many times it arrives.
   */
  async capture(input: {
    topicArn: string | undefined;
    messageId: string | undefined;
    subscribeUrl: string | undefined;
    now?: Date;
  }): Promise<void> {
    const verdict = this.verdict();
    if (!verdict.allowed) {
      // No URL, no token, no message id — only the decision and why.
      this.logger.warn(`SNS confirmation not captured: ${verdict.reason}`);
      return;
    }
    const { topicArn, messageId, subscribeUrl } = input;
    if (!topicArn || !messageId || !subscribeUrl) {
      this.logger.warn('SNS confirmation not captured: envelope lacked topic, id or URL.');
      return;
    }

    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

    /*
      A redelivery of the same confirmation carries the same MessageId, so the unique index
      makes it a no-op rather than a second row. `update` deliberately does NOT touch
      `subscribeUrl` or `revealedAt`: re-receiving a message the operator has already acted on
      must not silently un-reveal it.
    */
    const row = await this.prisma.snsPendingConfirmation.upsert({
      where: { messageId },
      create: { topicArn, messageId, subscribeUrl, expiresAt, receivedAt: now },
      update: {},
      select: { id: true },
    });

    /*
      A newer confirmation for the same topic supersedes older pending ones. Without this,
      "the pending confirmation" is ambiguous the moment somebody clicks Request confirmation
      twice, and an operator could reveal a token that AWS has already replaced.
    */
    await this.prisma.snsPendingConfirmation.updateMany({
      where: { topicArn, status: 'PENDING', id: { not: row.id } },
      data: { status: 'EXPIRED' },
    });

    this.logger.warn(
      `SNS SubscriptionConfirmation captured for manual confirmation (topic ${topicArn}). ` +
        `Reveal it through the admin console; it expires ${expiresAt.toISOString()}.`,
    );
    await this.audit.record({
      action: 'SNS_CONFIRMATION_CAPTURED',
      entityType: 'SnsPendingConfirmation',
      entityId: row.id,
      // Topic and expiry only. The URL and token are never audit metadata.
      metadata: { topicArn, expiresAt: expiresAt.toISOString() },
    });
  }

  private summarise(
    row: {
      id: string;
      topicArn: string;
      status: string;
      receivedAt: Date;
      expiresAt: Date;
      revealedAt: Date | null;
    },
    now: Date,
  ): PendingConfirmationSummary {
    return {
      id: row.id,
      topicArn: row.topicArn,
      status: row.status,
      receivedAt: row.receivedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      expired: row.expiresAt.getTime() <= now.getTime(),
      revealed: row.revealedAt !== null,
      revealedAt: row.revealedAt ? row.revealedAt.toISOString() : null,
    };
  }

  private refuseIfDisabled(): void {
    const verdict = this.verdict();
    if (!verdict.allowed) {
      throw new AppException(ErrorCodes.FORBIDDEN, verdict.reason, HttpStatus.FORBIDDEN);
    }
  }

  /** Metadata for the latest pending confirmation. Never includes the URL. */
  async status(now: Date = new Date()): Promise<PendingConfirmationSummary | null> {
    this.refuseIfDisabled();
    const row = await this.prisma.snsPendingConfirmation.findFirst({
      where: { status: 'PENDING' },
      orderBy: { receivedAt: 'desc' },
    });
    return row ? this.summarise(row, now) : null;
  }

  /**
   * Reveal the URL, once.
   *
   * ── WHY ONE-TIME, AND WHY IT IS SAFE TO BE STRICT ──────────────────────────────────
   * A value that can be read repeatedly is one an audit trail cannot really account for: the
   * fifth read looks exactly like the first. Stamping the first read makes every later attempt
   * visibly a second attempt, and the cost of being wrong is small — AWS will issue a fresh
   * token on demand from the SNS console, so a lost reveal is a button, not an incident.
   */
  async reveal(actorUserId: string, now: Date = new Date()): Promise<RevealedConfirmation> {
    this.refuseIfDisabled();

    const row = await this.prisma.snsPendingConfirmation.findFirst({
      where: { status: 'PENDING' },
      orderBy: { receivedAt: 'desc' },
    });
    if (!row) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'No pending SNS subscription confirmation has been received. Create the subscription ' +
          'in the AWS console, or use Request confirmation on an existing pending one.',
        HttpStatus.NOT_FOUND,
      );
    }

    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.snsPendingConfirmation.update({
        where: { id: row.id },
        data: { status: 'EXPIRED' },
      });
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'This confirmation token has expired. Use Request confirmation in the SNS console to ' +
          'have AWS send a new one.',
        HttpStatus.GONE,
      );
    }

    /*
      Audited BEFORE the value is handed over, and the stamp is written in the same breath.
      A reveal that failed to record itself must not also succeed in disclosing.
    */
    if (row.revealedAt) {
      await this.audit.record({
        actorUserId,
        action: 'SNS_CONFIRMATION_REVEAL_REFUSED',
        entityType: 'SnsPendingConfirmation',
        entityId: row.id,
        metadata: { topicArn: row.topicArn, firstRevealedAt: row.revealedAt.toISOString() },
      });
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `This confirmation was already revealed at ${row.revealedAt.toISOString()}. It is ` +
          'shown once. Use Request confirmation in the SNS console to have AWS send a new one.',
        HttpStatus.CONFLICT,
      );
    }

    const claimed = await this.prisma.snsPendingConfirmation.updateMany({
      // The null check is the claim: two concurrent reveals cannot both match it, so only one
      // of them updates a row and only one of them discloses.
      where: { id: row.id, revealedAt: null },
      data: { revealedAt: now, revealedBy: actorUserId },
    });
    if (claimed.count !== 1) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'This confirmation was revealed by another request. It is shown once.',
        HttpStatus.CONFLICT,
      );
    }

    await this.audit.record({
      actorUserId,
      action: 'SNS_CONFIRMATION_REVEALED',
      entityType: 'SnsPendingConfirmation',
      entityId: row.id,
      // Topic only. Putting the URL here would move the token into the audit log, which is
      // exactly the store this whole design is keeping it out of.
      metadata: { topicArn: row.topicArn },
    });
    // Who and which topic, never the URL — the whole point of the row is that the token stays
    // out of the logs.
    this.logger.warn(`SNS confirmation revealed to user ${actorUserId} for topic ${row.topicArn}.`);

    return {
      ...this.summarise({ ...row, revealedAt: now }, now),
      subscribeUrl: row.subscribeUrl,
    };
  }

  /**
   * Mark a confirmation done once the operator has pasted the URL into AWS.
   *
   * Set by a person, never inferred: nothing in this process can observe AWS accepting a
   * token, and a status this platform guessed at would be a status nobody could trust.
   */
  async markConfirmed(actorUserId: string, id: string): Promise<PendingConfirmationSummary> {
    this.refuseIfDisabled();
    const row = await this.prisma.snsPendingConfirmation.update({
      where: { id },
      data: { status: 'CONFIRMED' },
    });
    await this.audit.record({
      actorUserId,
      action: 'SNS_CONFIRMATION_MARKED_CONFIRMED',
      entityType: 'SnsPendingConfirmation',
      entityId: id,
      metadata: { topicArn: row.topicArn },
    });
    return this.summarise(row, new Date());
  }
}
