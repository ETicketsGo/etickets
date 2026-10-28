import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  SuppressionReason,
  getApplicablePolicy,
  policyVersionLabel,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MarketingConsentService } from '../notifications/marketing-consent.service';
import { SuppressionService } from '../notifications/delivery/suppression.service';
import { AppException, ErrorCodes } from '../common/errors';
import {
  ConsentPurpose,
  ORGANIZER_PURPOSES,
  currentConsent,
  isOrganizerPurpose,
  type ConsentRecord,
  type CurrentConsent,
  type OrganizerPurpose,
} from './consent-purpose';

/** Who the decision is about. An account when there is one, and always an email. */
export interface ConsentSubject {
  userId?: string | null;
  email: string;
}

/** How the decision was made. Set by the server; a client never chooses its own source. */
export interface ConsentDecisionContext {
  source: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Who did it, for the audit row. Null for a signed link (no session). */
  actorUserId?: string | null;
  /** The market whose text was shown. Only used to pick the policy version. */
  country?: string | null;
  /**
   * True only for the person's ACCOUNT-WIDE marketing email setting. Only that decision may
   * lift an "unsubscribe from all marketing email". Set by the server, never by a client.
   */
  accountWide?: boolean;
}

export interface ConsentDecision {
  purpose: string;
  organizationId: string | null;
  granted: boolean;
  channel?: string;
}

type Tx = Prisma.TransactionClient;

/** The audit actions. Two names, so a search for withdrawals finds only withdrawals. */
export const CONSENT_GRANTED = 'COMMUNICATION_CONSENT_GRANTED';
export const CONSENT_WITHDRAWN = 'COMMUNICATION_CONSENT_WITHDRAWN';

/**
 * Records and answers "may we send this person this kind of message, from this sender?".
 *
 * ── THE DEFAULT IS NO ──────────────────────────────────────────────────────────────
 * Same rule as `MarketingConsentService`: no row means no consent. Following an organizer
 * writes NO row here. A follower is not a subscriber until they say so, in words that name
 * the organizer and the kind of email.
 *
 * ── EVIDENCE, NOT STATE ────────────────────────────────────────────────────────────
 * Every decision is an INSERT plus an audit entry. Nothing here updates or deletes a consent
 * row, so the history a regulator or the person asks for is complete.
 */
@Injectable()
export class CommunicationConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly marketing: MarketingConsentService,
    private readonly suppression: SuppressionService,
  ) {}

  /** The hash the rows are keyed by. The same one `SuppressedDestination` uses for email. */
  static subjectHash(email: string): string {
    return SuppressionService.hash('email', email);
  }

  /** The policy label stored on every row: the MARKETING text, for the person's market. */
  static policyVersion(country?: string | null): string {
    return policyVersionLabel(getApplicablePolicy('MARKETING', country));
  }

  /**
   * Record one decision. Inside the caller's transaction when given one, so a follow, a
   * preference change or an unsubscribe and its consent rows commit together or not at all.
   */
  async record(
    subject: ConsentSubject,
    decision: ConsentDecision,
    context: ConsentDecisionContext,
    tx?: Tx,
  ): Promise<void> {
    const channel = decision.channel ?? 'email';
    const policyVersion = CommunicationConsentService.policyVersion(context.country);

    if (decision.purpose === ConsentPurpose.MARKETING_EMAIL && !decision.organizationId) {
      /*
        Platform marketing email has ONE store, `MarketingConsent`, which the sender already
        reads. Writing it here too would create a second answer that can disagree.
      */
      await this.marketing.record(
        { userId: subject.userId ?? null, email: subject.email },
        'email',
        decision.granted,
        {
          source: context.source,
          ipAddress: context.ipAddress ?? null,
          userAgent: context.userAgent ?? null,
          country: context.country ?? null,
          policyVersion,
          accountWide: context.accountWide === true,
        },
      );
    } else {
      if (!decision.organizationId || !isOrganizerPurpose(decision.purpose)) {
        throw new AppException(
          ErrorCodes.VALIDATION_FAILED,
          'This consent needs an organizer.',
          HttpStatus.BAD_REQUEST,
        );
      }
      const db = tx ?? this.prisma;
      await db.communicationConsent.create({
        data: {
          userId: subject.userId ?? null,
          subjectHash: CommunicationConsentService.subjectHash(subject.email),
          organizationId: decision.organizationId,
          purpose: decision.purpose,
          channel,
          granted: decision.granted,
          source: context.source,
          policyVersion,
          ipAddress: context.ipAddress ?? null,
          userAgent: context.userAgent?.slice(0, 300) ?? null,
        },
      });
      /*
        An explicit opt-in for THIS organizer lifts an earlier unsubscribe from this organizer,
        and only that (owner decision 2026-10-28). Without it the suppression would silently
        overrule the consent they just gave.

        Only reason UNSUBSCRIBED. A spam complaint about this organizer's mail is never
        lifted by a preference change; that takes an operator. Other organizers are not
        touched. Lifted, never deleted, so the history stays.

        An "unsubscribe from all marketing email" is NOT lifted here. The consent row above is
        recorded, but it takes effect only once the person turns marketing email back on in
        their account-wide settings (see `MarketingConsentService.record`).
      */
      if (decision.granted && channel === 'email') {
        await db.organizerSuppression.updateMany({
          where: {
            organizationId: decision.organizationId,
            channel: 'email',
            destinationHash: SuppressionService.hash('email', subject.email),
            reason: SuppressionReason.UNSUBSCRIBED,
            liftedAt: null,
          },
          data: { liftedAt: new Date() },
        });
      }
    }

    const entry = {
      actorUserId: context.actorUserId ?? null,
      organizationId: decision.organizationId ?? null,
      action: decision.granted ? CONSENT_GRANTED : CONSENT_WITHDRAWN,
      entityType: 'CommunicationConsent',
      entityId: subject.userId ?? null,
      // No email here. The audit log outlives an account deletion; the address must not.
      metadata: {
        purpose: decision.purpose,
        channel,
        source: context.source,
        policyVersion,
      },
      ip: context.ipAddress ?? null,
    };
    if (tx) await this.audit.recordInTransaction(tx, entry);
    else await this.audit.record(entry);
  }

  /** Every scoped row for the subject, matched by account OR by email hash. */
  async scopedRows(subject: ConsentSubject, organizationId?: string): Promise<ConsentRecord[]> {
    const subjectHash = CommunicationConsentService.subjectHash(subject.email);
    return this.prisma.communicationConsent.findMany({
      where: {
        ...(organizationId ? { organizationId } : {}),
        OR: [...(subject.userId ? [{ userId: subject.userId }] : []), { subjectHash }],
      },
      select: {
        purpose: true,
        organizationId: true,
        channel: true,
        granted: true,
        source: true,
        policyVersion: true,
        createdAt: true,
      },
    });
  }

  /** The current state of every organizer purpose for one organizer. */
  async organizerState(
    subject: ConsentSubject,
    organizationId: string,
  ): Promise<Record<OrganizerPurpose, CurrentConsent>> {
    const rows = await this.scopedRows(subject, organizationId);
    return Object.fromEntries(
      ORGANIZER_PURPOSES.map((p) => [p, currentConsent(rows, p, organizationId)]),
    ) as Record<OrganizerPurpose, CurrentConsent>;
  }

  /** Platform marketing email, read from its own store. */
  async platformMarketingEmail(subject: ConsentSubject): Promise<CurrentConsent> {
    const [state] = await this.marketing.stateFor(
      { userId: subject.userId ?? null, email: subject.email },
      ['email'],
    );
    return {
      purpose: ConsentPurpose.MARKETING_EMAIL,
      organizationId: null,
      channel: 'email',
      granted: state?.granted ?? false,
      decidedAt: state?.decidedAt ?? null,
      source: state?.source ?? null,
      policyVersion: null,
    };
  }

  /**
   * Whether the person's "unsubscribe from all marketing email" is in force: an active
   * MARKETING-scope UNSUBSCRIBED suppression. Only the account-wide marketing email setting
   * lifts it. Read so the follow screens can say why organizer email will not arrive.
   */
  async globalMarketingUnsubscribed(email: string): Promise<boolean> {
    const row = await this.prisma.suppressedDestination.findFirst({
      where: {
        channel: 'email',
        destinationHash: SuppressionService.hash('email', email),
        scope: 'MARKETING',
        reason: SuppressionReason.UNSUBSCRIBED,
        liftedAt: null,
      },
      select: { id: true },
    });
    return !!row;
  }

  /**
   * May this organizer email this person for this purpose, right now?
   *
   * All three must hold: a granted consent row for exactly this organizer and purpose, no
   * unsubscribe from this organizer, and no suppression of either scope (an address that does
   * not work, a complaint, or an unsubscribe from all marketing email).
   */
  async mayEmailForOrganizer(
    subject: ConsentSubject,
    organizationId: string,
    purpose: OrganizerPurpose,
  ): Promise<boolean> {
    const rows = await this.scopedRows(subject, organizationId);
    if (!currentConsent(rows, purpose, organizationId).granted) return false;
    const blocked = await this.prisma.organizerSuppression.findFirst({
      where: {
        organizationId,
        channel: 'email',
        destinationHash: SuppressionService.hash('email', subject.email),
        liftedAt: null,
      },
      select: { id: true },
    });
    if (blocked) return false;
    return !(await this.suppression.isSuppressed('email', subject.email, 'marketing'));
  }

  /**
   * The person's whole consent history, both stores merged, newest first.
   * What a data-subject access request returns, and what the account page shows.
   */
  async history(subject: ConsentSubject, limit = 200) {
    const [scoped, platform] = await Promise.all([
      this.prisma.communicationConsent.findMany({
        where: {
          OR: [
            ...(subject.userId ? [{ userId: subject.userId }] : []),
            { subjectHash: CommunicationConsentService.subjectHash(subject.email) },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          purpose: true,
          organizationId: true,
          channel: true,
          granted: true,
          source: true,
          policyVersion: true,
          createdAt: true,
        },
      }),
      this.marketing.history({ userId: subject.userId ?? null, email: subject.email }),
    ]);
    const merged = [
      ...scoped,
      ...platform
        .filter((r) => r.channel === 'email')
        .map((r) => ({
          purpose: ConsentPurpose.MARKETING_EMAIL as string,
          organizationId: null,
          channel: r.channel,
          granted: r.granted,
          source: r.source,
          policyVersion: null,
          createdAt: r.createdAt,
        })),
    ];
    merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return merged.slice(0, limit);
  }
}
