import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** How a consent decision was obtained. Recorded verbatim; never inferred. */
export interface ConsentContext {
  source: string;
  ipAddress?: string | null;
  userAgent?: string | null;
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

  constructor(private readonly prisma: PrismaService) {}

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
    await this.prisma.marketingConsent.create({
      data: {
        userId: subject.userId ?? null,
        email,
        channel,
        granted,
        source: context.source,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      },
    });
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
