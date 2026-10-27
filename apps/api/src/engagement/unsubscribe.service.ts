import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SuppressionReason } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { SuppressionService } from '../notifications/delivery/suppression.service';
import { CommunicationConsentService } from './communication-consent.service';
import {
  ConsentPurpose,
  ORGANIZER_PURPOSES,
  currentConsent,
  type OrganizerPurpose,
} from './consent-purpose';
import { UnsubscribeHooks } from './unsubscribe-hooks';
import {
  ALL_ORGANIZER_PURPOSES,
  unsubscribeKey,
  verifyUnsubscribeToken,
  type UnsubscribeClaims,
} from './unsubscribe-token';

/** What the landing page shows. No address, no account id: the link may be forwarded. */
export interface UnsubscribePreview {
  scope: 'global' | 'organizer';
  purposes: string[];
  organization: { id: string; name: string } | null;
  /** Masked, so a forwarded link does not reveal the whole address. */
  emailMask: string;
}

/**
 * The work behind a signed unsubscribe link. No sign-in: the signature is the authority.
 *
 * ── WHAT IS WRITTEN ────────────────────────────────────────────────────────────────
 *   - organizer scope: a withdrawal consent row per purpose, the follower's early-access and
 *     offers topics switched off, and an `OrganizerSuppression` row so that organizer can
 *     never mail the address again until the person opts back in from their account.
 *   - global scope ("Unsubscribe from all marketing email"): a withdrawal of platform marketing
 *     email (in `MarketingConsent`, the store the sender reads), a withdrawal of every organizer
 *     consent the person currently has, and a MARKETING-scope `SuppressedDestination` row, so
 *     no organizer campaign and no ETicketsGo marketing reaches the address - including ones
 *     for which no consent row was ever found by email (owner decision 2026-10-27).
 *
 * ── WHAT IS DELIBERATELY NOT WRITTEN ───────────────────────────────────────────────
 * An ALL-scope suppression. That one blocks EVERY email to the address, tickets included.
 * Somebody who leaves all marketing must still get the ticket they paid for, their receipts,
 * refunds and sign-in codes; the MARKETING scope is read only by marketing sends.
 *
 * Repeating an unsubscribe is safe: the suppression insert skips duplicates (and re-arms a
 * lifted row), and a second withdrawal row is harmless evidence of a second click.
 */
@Injectable()
export class UnsubscribeService {
  private readonly logger = new Logger('Unsubscribe');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly consent: CommunicationConsentService,
    /** Listeners told after the unsubscribe has committed (campaign stats). Optional. */
    @Optional() private readonly hooks?: UnsubscribeHooks,
    /** Writes the MARKETING-scope row for "unsubscribe from all marketing email". */
    @Optional() private readonly suppression?: SuppressionService,
  ) {}

  private claimsOrThrow(token: string): UnsubscribeClaims {
    const claims = verifyUnsubscribeToken(token, unsubscribeKey(this.config));
    if (!claims) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'This unsubscribe link is not valid. Use the link in your latest email, or change your settings in your account.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return claims;
  }

  private purposesOf(claims: UnsubscribeClaims): string[] {
    if (claims.scope === 'global') return [ConsentPurpose.MARKETING_EMAIL];
    return claims.purpose === ALL_ORGANIZER_PURPOSES ? [...ORGANIZER_PURPOSES] : [claims.purpose];
  }

  async preview(token: string): Promise<UnsubscribePreview> {
    const claims = this.claimsOrThrow(token);
    const organization = claims.organizationId
      ? await this.prisma.organization.findUnique({
          where: { id: claims.organizationId },
          select: { id: true, name: true },
        })
      : null;
    return {
      scope: claims.scope,
      purposes: this.purposesOf(claims),
      organization,
      emailMask: SuppressionService.mask('email', claims.email),
    };
  }

  async unsubscribe(
    token: string,
    context: { ipAddress?: string | null; userAgent?: string | null; oneClick: boolean },
  ): Promise<UnsubscribePreview & { unsubscribed: true }> {
    const claims = this.claimsOrThrow(token);
    const preview = await this.preview(token);
    const subject = { userId: claims.userId, email: claims.email };
    const source = context.oneClick ? 'unsubscribe-one-click' : 'unsubscribe-link';
    const decisionContext = {
      source,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      actorUserId: null,
    };

    if (claims.scope === 'global') {
      await this.consent.record(
        subject,
        { purpose: ConsentPurpose.MARKETING_EMAIL, organizationId: null, granted: false },
        decisionContext,
      );
      // Every organizer consent currently granted is withdrawn too, so an opt-in later from
      // the account re-opens only what the person grants again.
      const rows = await this.consent.scopedRows(subject);
      const granted = new Map<string, Set<OrganizerPurpose>>();
      for (const orgId of new Set(rows.map((r) => r.organizationId).filter(Boolean))) {
        for (const purpose of ORGANIZER_PURPOSES) {
          if (currentConsent(rows, purpose, orgId as string).granted) {
            if (!granted.has(orgId as string)) granted.set(orgId as string, new Set());
            granted.get(orgId as string)!.add(purpose);
          }
        }
      }
      for (const [organizationId, purposes] of granted) {
        for (const purpose of purposes) {
          await this.consent.record(
            subject,
            { purpose, organizationId, granted: false },
            decisionContext,
          );
        }
      }
      await this.suppression?.suppress({
        channel: 'email',
        destination: claims.email,
        reason: SuppressionReason.UNSUBSCRIBED,
        scope: 'MARKETING',
        provider: null,
      });
    } else {
      const organizationId = claims.organizationId!;
      const purposes = this.purposesOf(claims) as OrganizerPurpose[];
      const destinationHash = SuppressionService.hash('email', claims.email);
      await this.prisma.$transaction(async (tx) => {
        for (const purpose of purposes) {
          await this.consent.record(
            subject,
            { purpose, organizationId, granted: false },
            decisionContext,
            tx,
          );
        }
        // The organizer's own do-not-mail list. Re-armed if an earlier one was lifted.
        await tx.organizerSuppression.upsert({
          where: {
            organizationId_channel_destinationHash: {
              organizationId,
              channel: 'email',
              destinationHash,
            },
          },
          create: {
            organizationId,
            channel: 'email',
            destinationHash,
            reason: SuppressionReason.UNSUBSCRIBED,
          },
          update: { liftedAt: null, reason: SuppressionReason.UNSUBSCRIBED },
        });
        // Keep the follower's topic mirror honest: these two are email-only topics.
        if (claims.userId) {
          const off: Record<string, boolean> = {};
          if (purposes.includes(ConsentPurpose.EARLY_ACCESS)) off.earlyAccess = false;
          if (purposes.includes(ConsentPurpose.OFFERS)) off.offers = false;
          if (Object.keys(off).length) {
            await tx.organizerNotificationPreference.updateMany({
              where: { userId: claims.userId, organizationId },
              data: off,
            });
          }
        }
      });
    }
    this.logger.log(`unsubscribed ${preview.emailMask} scope=${claims.scope} via ${source}`);
    await this.hooks?.emit({
      scope: claims.scope,
      organizationId: claims.organizationId,
      emailHash: SuppressionService.hash('email', claims.email),
      userId: claims.userId,
      oneClick: context.oneClick,
      at: new Date(),
    });
    return { ...preview, unsubscribed: true };
  }
}
