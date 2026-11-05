import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SuppressionReason } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { maskPhone } from '../channels/transports/recipient.util';

/**
 * Destinations that must not be sent to again.
 *
 * ── WHY THIS IS NOT THE CONSENT SERVICE ────────────────────────────────────────────
 * `MarketingConsentService` answers "may we send this person promotional material", and its
 * absence correctly blocks marketing while never withholding a ticket. This answers "does
 * this destination work at all", and an ALL-scope row must stop TRANSACTIONAL mail too —
 * continuing to email an address that hard-bounces is precisely what gets a sending domain
 * throttled or suspended by SES. A MARKETING-scope row (a complaint, a platform-wide
 * marketing unsubscribe) stops promotion only; see `SuppressionScope`.
 *
 * Answering one with the other breaks the platform in both directions: somebody's ticket
 * withheld because they unsubscribed from a newsletter, or a dead mailbox emailed forever
 * because nobody ever unsubscribed it.
 *
 * ── WHY A HASH ─────────────────────────────────────────────────────────────────────
 * The only question ever asked of this table is "is this destination suppressed", and a hash
 * answers it exactly as well as plaintext. Storing addresses instead would create a table of
 * real, verified customer contact details whose entire purpose is to be read on every send —
 * the worst possible combination of sensitivity and access frequency.
 */
/**
 * A destination in the only form the webhook ledger may keep it: its suppression hash on each
 * channel it could belong to, and its mask. Never the address or number itself.
 *
 * Per channel because the hash includes the channel, and a callback does not always say which
 * one it is about -- an MSG91 report may concern an SMS or a WhatsApp message.
 */
export interface DestinationRef {
  hashes: Partial<Record<string, string>>;
  mask: string;
}

/**
 * What a suppression stops.
 *
 *   ALL        the destination does not work, or the person stopped the channel itself (a hard
 *              bounce, an invalid destination, a provider block, an SMS STOP). Nothing is sent.
 *   MARKETING  the person said no to promotional mail: a spam complaint, or "unsubscribe from
 *              all marketing email". Every organizer campaign and every platform MARKETING
 *              message skips it. Essential transactional mail - tickets, booking confirmations,
 *              receipts, sign-in codes, password resets, refunds - does NOT.
 *
 * ── WHY A COMPLAINT IS MARKETING-ONLY (owner decision 2026-10-27) ─────────────────────
 * A complaint used to block every email to the address. Somebody who marks one newsletter as
 * spam must still receive the ticket they paid for and the code they need to sign in; their
 * address works, they only refused promotion. A hard bounce still blocks everything, because
 * there the address itself is dead and continuing to send is what damages the sending domain.
 */
export type SuppressionScope = 'ALL' | 'MARKETING';

/** What a message is, for the suppression check: tickets and codes, or promotion. */
export type SendPurpose = 'transactional' | 'marketing';

/** The scope a reason suppresses by default. Only a complaint is marketing-only. */
export function scopeForReason(reason: string): SuppressionScope {
  return reason === SuppressionReason.COMPLAINT ? 'MARKETING' : 'ALL';
}

@Injectable()
export class SuppressionService {
  private readonly logger = new Logger('Notification');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Normalize before hashing, or the same destination hashes two ways.
   *
   * Email is case-insensitive in the part that matters here and people type it either way.
   * A phone number arrives as `+91 98765 43210` from one provider and `919876543210` from
   * another, and a suppression recorded under one form would never match the other — the
   * destination would look unsuppressed and keep being sent to, which is the whole failure
   * this table exists to prevent.
   */
  static normalize(channel: string, destination: string): string {
    const trimmed = destination.trim();
    if (channel === 'email') return trimmed.toLowerCase();
    return trimmed.replace(/[^\d]/g, '');
  }

  static hash(channel: string, destination: string): string {
    return createHash('sha256')
      .update(`${channel}:${SuppressionService.normalize(channel, destination)}`)
      .digest('hex');
  }

  /** Enough to recognise in a support conversation, never enough to use. */
  static mask(channel: string, destination: string): string {
    if (channel !== 'email') return maskPhone(destination);
    const [local, domain] = destination.trim().split('@');
    if (!domain) return '***';
    return `${local.slice(0, 2)}***@${domain}`;
  }

  /** See {@link DestinationRef}. `channels` must all be the same kind (phone, or email). */
  static reference(destination: string, channels: readonly string[]): DestinationRef {
    const hashes: Partial<Record<string, string>> = {};
    for (const channel of channels) hashes[channel] = SuppressionService.hash(channel, destination);
    return { hashes, mask: SuppressionService.mask(channels[0] ?? 'sms', destination) };
  }

  /**
   * Whether this destination is currently blocked on this channel for this kind of message.
   *
   * `transactional` (the default) reads only ALL-scope rows: a complaint or a marketing
   * unsubscribe never withholds a ticket, a receipt or a sign-in code. `marketing` reads both
   * scopes.
   *
   * Fails OPEN. A database hiccup on the suppression lookup must not stop a ticket from
   * going out: the cost of one email to a bad address is a bounce, and the cost of silently
   * withholding every notification during a blip is a great deal more. (The campaign sender
   * does its own fail-CLOSED check; promotion can wait.)
   */
  async isSuppressed(
    channel: string,
    destination: string | null | undefined,
    purpose: SendPurpose = 'transactional',
  ): Promise<boolean> {
    if (!destination) return false;
    const rows = await this.prisma.suppressedDestination
      .findMany({
        where: {
          channel,
          destinationHash: SuppressionService.hash(channel, destination),
          liftedAt: null,
          ...(purpose === 'transactional' ? { scope: 'ALL' } : {}),
        },
        select: { expiresAt: true },
      })
      .catch(() => [] as { expiresAt: Date | null }[]);
    // A reason that genuinely expires stops applying when it does. A hard bounce has no
    // expiry.
    const now = Date.now();
    return rows.some((row) => !row.expiresAt || row.expiresAt.getTime() > now);
  }

  /**
   * Record a suppression. Idempotent: the same bad address reported by three bounces is one
   * row, and a repeat does not overwrite the ORIGINAL reason — the first thing that went
   * wrong is the thing worth keeping.
   */
  async suppress(input: {
    channel: string;
    /** The destination in the clear, when the caller has it... */
    destination?: string | null;
    /** ...or only its reference, when it arrives from the webhook ledger. */
    destinationRef?: DestinationRef | null;
    reason: SuppressionReason;
    /** Defaults to the reason's own scope (`scopeForReason`): MARKETING for a complaint. */
    scope?: SuppressionScope;
    provider?: string | null;
    sourceDeliveryId?: string | null;
    expiresAt?: Date | null;
  }): Promise<void> {
    const scope = input.scope ?? scopeForReason(input.reason);
    const destinationHash = input.destination
      ? SuppressionService.hash(input.channel, input.destination)
      : input.destinationRef?.hashes[input.channel];
    // A reference recorded for a different channel cannot name this destination here.
    if (!destinationHash) return;
    const destinationMask = input.destination
      ? SuppressionService.mask(input.channel, input.destination)
      : (input.destinationRef?.mask ?? '***');

    const created = await this.prisma.suppressedDestination.createMany({
      data: [
        {
          channel: input.channel,
          destinationHash,
          destinationMask,
          reason: input.reason,
          scope,
          provider: input.provider ?? null,
          sourceDeliveryId: input.sourceDeliveryId ?? null,
          expiresAt: input.expiresAt ?? null,
        },
      ],
      // Never raises, so a second bounce for the same address cannot abort the transaction
      // that is processing the webhook it arrived in.
      skipDuplicates: true,
    });
    if (created.count > 0) {
      this.logger.warn(
        `[${input.channel}] suppressed ${destinationMask} (${input.reason}, ${scope})`,
      );
      return;
    }

    /*
      ── AN OPT-OUT RE-ARMS A LIFTED ROW ─────────────────────────────────────────────────
      The row is unique per destination and a lift never deletes it, so a person who opted
      out, opted back in, and then opted out AGAIN would otherwise stay lifted: the second
      STOP is a duplicate insert and nothing changes. A legal instruction cannot be lost to a
      unique index. Scoped to UNSUBSCRIBED on purpose -- every other reason keeps its
      existing first-reason-wins behaviour.
    */
    if (input.reason === SuppressionReason.UNSUBSCRIBED) {
      const rearmed = await this.prisma.suppressedDestination.updateMany({
        where: { channel: input.channel, destinationHash, scope, liftedAt: { not: null } },
        data: {
          reason: input.reason,
          provider: input.provider ?? null,
          sourceDeliveryId: input.sourceDeliveryId ?? null,
          expiresAt: input.expiresAt ?? null,
          suppressedAt: new Date(),
          liftedAt: null,
          liftedBy: null,
        },
      });
      if (rearmed.count > 0) {
        this.logger.warn(
          `[${input.channel}] suppressed ${destinationMask} again (${input.reason})`,
        );
      }
    }
  }

  /**
   * Lift an opt-out because the provider says the recipient is opted in again.
   *
   * Two kinds of evidence, recorded distinctly in `liftedBy`:
   *   - `start`    the recipient texted START and the provider reported it (the primary path);
   *   - `accepted` a provider that itself refuses opted-out numbers just accepted a message to
   *                this one, which it would not have done had they still been opted out.
   *
   * Only the UNSUBSCRIBED reason: opting back in says nothing about a hard bounce or a carrier
   * block. Never deleted, so the history of why the number was blocked survives.
   */
  async liftProviderOptOut(
    channel: string,
    destination: string | DestinationRef,
    provider: string,
    evidence: 'start' | 'accepted',
  ): Promise<boolean> {
    const destinationHash =
      typeof destination === 'string'
        ? SuppressionService.hash(channel, destination)
        : destination.hashes[channel];
    if (!destinationHash) return false;
    const res = await this.prisma.suppressedDestination.updateMany({
      where: {
        channel,
        destinationHash,
        scope: 'ALL',
        reason: SuppressionReason.UNSUBSCRIBED,
        liftedAt: null,
      },
      data: { liftedAt: new Date(), liftedBy: `provider:${provider}:${evidence}` },
    });
    if (res.count > 0) {
      const mask =
        typeof destination === 'string'
          ? SuppressionService.mask(channel, destination)
          : destination.mask;
      this.logger.log(
        `[${channel}] opt-out lifted for ${mask} (${provider}: ${
          evidence === 'start' ? 'recipient texted START' : 'provider accepted a message'
        })`,
      );
    }
    return res.count > 0;
  }

  /**
   * Lift an "unsubscribe from all marketing email" because the person turned marketing email
   * back on in their ACCOUNT-WIDE settings (owner decision 2026-10-28).
   *
   * Call it from that one path only (`MarketingConsentService.record` with `accountWide`).
   * Allowing one organizer's email is NOT a reason: that consent is recorded, but it does not
   * take effect while this row stands.
   *
   * Only the MARKETING-scope UNSUBSCRIBED row. A COMPLAINT stays until an operator lifts it,
   * and an ALL-scope row (a hard bounce) is about the address working, which an opt-in says
   * nothing about. Never deleted, so the history stays.
   */
  async liftMarketingOptOut(
    channel: string,
    destination: string,
    db: Pick<Prisma.TransactionClient, 'suppressedDestination'> = this.prisma,
  ): Promise<boolean> {
    const res = await db.suppressedDestination.updateMany({
      where: {
        channel,
        destinationHash: SuppressionService.hash(channel, destination),
        scope: 'MARKETING',
        reason: SuppressionReason.UNSUBSCRIBED,
        liftedAt: null,
      },
      data: { liftedAt: new Date(), liftedBy: 'account:global-opt-in' },
    });
    return res.count > 0;
  }

  /**
   * Lift a suppression, without deleting it.
   *
   * A destination gets unblocked for real reasons — a mailbox was recreated, a number was
   * reassigned, a bounce was somebody else's fault. Deleting the row would lose why it was
   * blocked, which is the only thing that makes the decision to unblock it reviewable.
   */
  async lift(id: string, actorUserId: string): Promise<boolean> {
    const res = await this.prisma.suppressedDestination.updateMany({
      where: { id, liftedAt: null },
      data: { liftedAt: new Date(), liftedBy: actorUserId },
    });
    return res.count === 1;
  }

  /** Operator listing: masked destinations only, newest first. */
  async list(opts: { channel?: string; reason?: string; limit?: number } = {}) {
    return this.prisma.suppressedDestination.findMany({
      where: {
        ...(opts.channel ? { channel: opts.channel } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
        liftedAt: null,
      },
      orderBy: { suppressedAt: 'desc' },
      take: Math.min(opts.limit ?? 50, 200),
      select: {
        id: true,
        channel: true,
        destinationMask: true,
        reason: true,
        scope: true,
        provider: true,
        suppressedAt: true,
        expiresAt: true,
      },
    });
  }
}
