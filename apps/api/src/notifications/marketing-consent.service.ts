import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SuppressionService } from './delivery/suppression.service';

/** The audit action when the account-wide setting lifts an "unsubscribe from all marketing". */
export const MARKETING_UNSUBSCRIBE_LIFTED = 'MARKETING_UNSUBSCRIBE_LIFTED';

/** How a consent decision was obtained. Recorded verbatim; never inferred. */
export interface ConsentContext {
  source: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** ISO-3166 alpha-2 of the market the decision was made in. */
  country?: string | null;
  /** The disclosure actually shown, as `TYPE/JURISDICTION/vN`. */
  policyVersion?: string | null;
  /**
   * The number this consent is FOR. Pass only an already-verified number, and only for a
   * messaging channel - see the schema comment. Anything else is left null.
   */
  phone?: string | null;
  /**
   * True only when the decision was made on the person's ACCOUNT-WIDE notification settings.
   * Only then does a granted `email` decision lift an earlier "unsubscribe from all marketing
   * email" (owner decision 2026-10-28). Set by the server, never accepted from a client.
   */
  accountWide?: boolean;
}

export interface ConsentSubject {
  userId?: string | null;
  email?: string | null;
}

/** Current consent state for one channel. */
export interface ConsentState {
  channel: string;
  granted: boolean;
  source: string | null;
  decidedAt: Date | null;
}

/**
 * Records and answers "may we send this person commercial messages?".
 *
 * ── THE DEFAULT IS NO ──────────────────────────────────────────────────────────────
 * With no row on file, `mayReceiveMarketing` returns false. Silence is not consent, and a
 * system that reads an absent record as permission will, the first time a marketing
 * message is added, mail everybody who ever bought a ticket. That is precisely the failure
 * anti-spam law exists to punish, and it is one line of default behaviour away.
 *
 * Transactional messages never consult this service at all — see message-class.ts. A
 * ticket must reach the person who paid for it whatever their marketing preferences say.
 */
@Injectable()
export class MarketingConsentService {
  private readonly logger = new Logger('MarketingConsent');

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly suppression?: SuppressionService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  private normalise(email: string | null | undefined): string | null {
    const trimmed = email?.trim().toLowerCase();
    return trimmed ? trimmed : null;
  }

  /**
   * Record a decision. Always an INSERT — the table is append-only, so a withdrawal is a
   * new row rather than an edit and the history stays reconstructable.
   */
  async record(
    subject: ConsentSubject,
    channel: string,
    granted: boolean,
    context: ConsentContext,
  ): Promise<void> {
    const email = this.normalise(subject.email);
    if (!email) {
      // Without an email there is no stable subject to attach the consent to, and writing
      // a row that cannot be matched later is worse than not writing one: it looks like
      // evidence and proves nothing.
      this.logger.warn(`consent not recorded for channel=${channel}: no email on the subject`);
      return;
    }
    /*
      The number is READ HERE, never accepted from the caller.

      An SMS consent whose subject is a number the caller supplied proves nothing: anyone
      could name somebody else's. Taking it from the account's own verified number means the
      snapshot is of a number this person demonstrably controls, and an account with no
      verified number simply records no number rather than an unverified one.
    */
    let phone = context.phone ?? null;
    if ((channel === 'sms' || channel === 'whatsapp') && !phone && subject.userId) {
      const owner = await this.prisma.user.findUnique({
        where: { id: subject.userId },
        select: { phone: true, phoneVerifiedAt: true },
      });
      phone = owner?.phoneVerifiedAt ? (owner.phone ?? null) : null;
    }

    await this.prisma.marketingConsent.create({
      data: {
        userId: subject.userId ?? null,
        email,
        channel,
        granted,
        source: context.source,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        country: context.country ?? null,
        policyVersion: context.policyVersion ?? null,
        /*
          Snapshotted for messaging channels only. A consent on `email` has no number to
          record, and recording one there would be collecting a phone number for no reason.
        */
        phone: channel === 'sms' || channel === 'whatsapp' ? phone : null,
      },
    });

    /*
      ── THE ONLY WAY BACK FROM "UNSUBSCRIBE FROM ALL MARKETING EMAIL" ─────────────────
      A global unsubscribe stays in force until the person turns marketing email back on
      in their account-wide settings. That is this branch and nothing else: allowing one
      organizer's email records that organizer's consent but never lifts this row. Only the
      UNSUBSCRIBED reason is lifted; a complaint or a hard bounce needs an operator.
    */
    if (granted && channel === 'email' && context.accountWide && this.suppression) {
      const lifted = await this.suppression.liftMarketingOptOut('email', email);
      if (lifted) {
        await this.audit?.record({
          actorUserId: subject.userId ?? null,
          action: MARKETING_UNSUBSCRIBE_LIFTED,
          entityType: 'SuppressedDestination',
          entityId: subject.userId ?? null,
          // No address: the audit log outlives an account deletion.
          metadata: { channel, scope: 'MARKETING', reason: 'UNSUBSCRIBED', source: context.source },
          ip: context.ipAddress ?? null,
        });
      }
    }
  }

  /**
   * May this person be sent a commercial message on this channel?
   *
   * Reads the NEWEST row for the subject. Matching prefers the account when there is one
   * and falls back to the email address, so a person who consented as a guest and later
   * registered is still the same person — and, more importantly, a person who WITHDREW as
   * a guest does not get re-subscribed by creating an account.
   */
  async mayReceiveMarketing(subject: ConsentSubject, channel: string): Promise<boolean> {
    const email = this.normalise(subject.email);
    if (!subject.userId && !email) return false;

    const latest = await this.prisma.marketingConsent.findFirst({
      where: {
        channel,
        OR: [
          ...(subject.userId ? [{ userId: subject.userId }] : []),
          ...(email ? [{ email }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    return latest?.granted ?? false;
  }

  /** Current state per channel, for an account page or a data-subject request. */
  async stateFor(subject: ConsentSubject, channels: string[]): Promise<ConsentState[]> {
    return Promise.all(
      channels.map(async (channel) => {
        const email = this.normalise(subject.email);
        const latest =
          subject.userId || email
            ? await this.prisma.marketingConsent.findFirst({
                where: {
                  channel,
                  OR: [
                    ...(subject.userId ? [{ userId: subject.userId }] : []),
                    ...(email ? [{ email }] : []),
                  ],
                },
                orderBy: { createdAt: 'desc' },
              })
            : null;
        return {
          channel,
          granted: latest?.granted ?? false,
          source: latest?.source ?? null,
          decidedAt: latest?.createdAt ?? null,
        };
      }),
    );
  }

  /**
   * The full audit trail for one subject, newest first.
   *
   * This is the thing a regulator asks for, and the reason the table is append-only. It is
   * also what a data-subject access request has to return.
   */
  async history(subject: ConsentSubject) {
    const email = this.normalise(subject.email);
    if (!subject.userId && !email) return [];
    return this.prisma.marketingConsent.findMany({
      where: {
        OR: [
          ...(subject.userId ? [{ userId: subject.userId }] : []),
          ...(email ? [{ email }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        channel: true,
        granted: true,
        source: true,
        createdAt: true,
      },
    });
  }
}
