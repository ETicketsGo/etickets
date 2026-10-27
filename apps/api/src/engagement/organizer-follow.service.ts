import { HttpStatus, Injectable } from '@nestjs/common';
import { EventStatus, OrganizationStatus, type OrganizerUpdateCadence } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import {
  CommunicationConsentService,
  type ConsentDecisionContext,
} from './communication-consent.service';
import { ConsentPurpose, ORGANIZER_PURPOSES, type OrganizerPurpose } from './consent-purpose';

/** Where a follow came from. Server-checked, so the analytics cannot be fed free text. */
export const FOLLOW_SOURCES = [
  'ORGANIZER_PAGE',
  'BOOKING_CONFIRMATION',
  'EVENT_PAGE',
  'LOCAL_MIGRATION',
] as const;
export type FollowSource = (typeof FOLLOW_SOURCES)[number];

/** What a follower sees and sets for one organizer. */
export interface FollowPreferencesView {
  organizationId: string;
  /** Topic: new events, shown in the account. On by default - the person asked by following. */
  newEvents: boolean;
  /** Topic AND email permission (EARLY_ACCESS). Off by default. */
  earlyAccess: boolean;
  /** Topic AND email permission (OFFERS). Off by default. */
  offers: boolean;
  cadence: OrganizerUpdateCadence;
  /** Email permission for new-event news (ORGANIZER_UPDATES). Off by default. */
  emailUpdates: boolean;
}

export interface FollowPreferencesInput {
  newEvents?: boolean;
  earlyAccess?: boolean;
  offers?: boolean;
  cadence?: OrganizerUpdateCadence;
  emailUpdates?: boolean;
}

/** Organizers a person may start following. A suspended or rejected one is not offered. */
const FOLLOWABLE: OrganizationStatus[] = [OrganizationStatus.APPROVED, OrganizationStatus.PENDING];

/**
 * Following an organizer.
 *
 * ── WHAT A FOLLOW IS ───────────────────────────────────────────────────────────────
 * A row that says this person wants to see this organizer in their account. It is personal
 * data, deleted with the account. It is NOT marketing consent: it writes no consent row,
 * so nobody is mailed for following. Email needs the separate switches on the preferences.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ─────────────────────────────────────────────────────
 * Follow is an insert that skips duplicates against the (userId, organizationId) unique
 * index, so two taps, two tabs or a retried request leave exactly one row and never an
 * error. Unfollow is a delete of whatever is there, so a second one is a no-op.
 */
@Injectable()
export class OrganizerFollowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: CommunicationConsentService,
  ) {}

  private async assertFollowable(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, status: true },
    });
    if (!org || !FOLLOWABLE.includes(org.status)) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organizer not found.', HttpStatus.NOT_FOUND);
    }
  }

  async follow(user: RequestUser, organizationId: string, source: FollowSource) {
    await this.assertFollowable(organizationId);
    const created = await this.prisma.$transaction(async (tx) => {
      const res = await tx.organizerFollow.createMany({
        data: [{ userId: user.id, organizationId, source }],
        skipDuplicates: true,
      });
      // Defaults only: an existing row (from an earlier follow) keeps the person's choices.
      await tx.organizerNotificationPreference.createMany({
        data: [{ userId: user.id, organizationId }],
        skipDuplicates: true,
      });
      return res.count > 0;
    });
    const row = await this.prisma.organizerFollow.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId } },
      select: { createdAt: true },
    });
    return { organizationId, following: true, followedAt: row?.createdAt ?? null, created };
  }

  /**
   * Stop following. Any organizer email the person had allowed is withdrawn in the same
   * transaction: "stop following" is a clear signal to stop hearing from them, and leaving
   * the permission on would let a sender mail somebody who walked away.
   */
  async unfollow(user: RequestUser, organizationId: string, context: ConsentDecisionContext) {
    const subject = { userId: user.id, email: user.email };
    const state = await this.consent.organizerState(subject, organizationId);
    const granted = ORGANIZER_PURPOSES.filter((p) => state[p].granted);
    await this.prisma.$transaction(async (tx) => {
      await tx.organizerFollow.deleteMany({ where: { userId: user.id, organizationId } });
      await tx.organizerNotificationPreference.deleteMany({
        where: { userId: user.id, organizationId },
      });
      for (const purpose of granted) {
        await this.consent.record(
          subject,
          { purpose, organizationId, granted: false },
          { ...context, source: 'withdrawn-on-unfollow' },
          tx,
        );
      }
    });
    return { organizationId, following: false };
  }

  async status(user: RequestUser, organizationId: string) {
    const row = await this.prisma.organizerFollow.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId } },
      select: { createdAt: true },
    });
    return { organizationId, following: !!row, followedAt: row?.createdAt ?? null };
  }

  async list(user: RequestUser, page: number, pageSize: number) {
    const where = { userId: user.id };
    const [total, rows] = await Promise.all([
      this.prisma.organizerFollow.count({ where }),
      this.prisma.organizerFollow.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          createdAt: true,
          organization: {
            select: { id: true, name: true, logoUrl: true, verified: true, createdAt: true },
          },
        },
      }),
    ]);
    const orgIds = rows.map((r) => r.organization.id);
    const [eventCounts, prefs] = await Promise.all([
      orgIds.length
        ? this.prisma.event.groupBy({
            by: ['organizationId'],
            where: { organizationId: { in: orgIds }, status: EventStatus.PUBLISHED },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      Promise.all(orgIds.map((id) => this.preferences(user, id, { requireFollow: false }))),
    ]);
    const countBy = new Map(eventCounts.map((c) => [c.organizationId, c._count._all]));
    return {
      items: rows.map((r, i) => ({
        followedAt: r.createdAt,
        organization: {
          id: r.organization.id,
          name: r.organization.name,
          logoUrl: r.organization.logoUrl,
          verified: r.organization.verified,
          memberSince: r.organization.createdAt,
          eventCount: countBy.get(r.organization.id) ?? 0,
        },
        preferences: prefs[i],
      })),
      total,
      page,
      pageSize,
    };
  }

  async preferences(
    user: RequestUser,
    organizationId: string,
    opts: { requireFollow?: boolean } = {},
  ): Promise<FollowPreferencesView> {
    if (opts.requireFollow !== false) await this.assertFollowing(user, organizationId);
    const [pref, state] = await Promise.all([
      this.prisma.organizerNotificationPreference.findUnique({
        where: { userId_organizationId: { userId: user.id, organizationId } },
      }),
      this.consent.organizerState({ userId: user.id, email: user.email }, organizationId),
    ]);
    return {
      organizationId,
      newEvents: pref?.newEvents ?? true,
      /*
        Read from the CONSENT, not the preference mirror: the consent row is the evidence, and
        an unsubscribe link (which writes consent rows) must be reflected here at once.
      */
      earlyAccess: state.EARLY_ACCESS.granted,
      offers: state.OFFERS.granted,
      cadence: pref?.cadence ?? 'INSTANT',
      emailUpdates: state.ORGANIZER_UPDATES.granted,
    };
  }

  /**
   * Change what the person hears from one organizer.
   *
   * The email switches write consent rows - one per switch that CHANGED, so re-saving the
   * same answer does not pad the history. The topic booleans mirror them on the preference
   * row in the same transaction.
   */
  async setPreferences(
    user: RequestUser,
    organizationId: string,
    input: FollowPreferencesInput,
    context: ConsentDecisionContext,
  ): Promise<FollowPreferencesView> {
    const current = await this.preferences(user, organizationId);
    const subject = { userId: user.id, email: user.email };
    const changes: { purpose: OrganizerPurpose; granted: boolean }[] = [];
    const consider = (purpose: OrganizerPurpose, next: boolean | undefined, now: boolean) => {
      if (next !== undefined && next !== now) changes.push({ purpose, granted: next });
    };
    consider(ConsentPurpose.ORGANIZER_UPDATES, input.emailUpdates, current.emailUpdates);
    consider(ConsentPurpose.EARLY_ACCESS, input.earlyAccess, current.earlyAccess);
    consider(ConsentPurpose.OFFERS, input.offers, current.offers);

    await this.prisma.$transaction(async (tx) => {
      await tx.organizerNotificationPreference.upsert({
        where: { userId_organizationId: { userId: user.id, organizationId } },
        create: {
          userId: user.id,
          organizationId,
          newEvents: input.newEvents ?? current.newEvents,
          earlyAccess: input.earlyAccess ?? current.earlyAccess,
          offers: input.offers ?? current.offers,
          cadence: input.cadence ?? current.cadence,
        },
        update: {
          ...(input.newEvents !== undefined ? { newEvents: input.newEvents } : {}),
          ...(input.earlyAccess !== undefined ? { earlyAccess: input.earlyAccess } : {}),
          ...(input.offers !== undefined ? { offers: input.offers } : {}),
          ...(input.cadence !== undefined ? { cadence: input.cadence } : {}),
        },
      });
      for (const change of changes) {
        await this.consent.record(
          subject,
          { purpose: change.purpose, organizationId, granted: change.granted },
          {
            ...context,
            source: change.granted
              ? `following-preferences:${change.purpose}`
              : `withdrawn-by-user:following-preferences:${change.purpose}`,
          },
          tx,
        );
      }
    });
    return this.preferences(user, organizationId);
  }

  private async assertFollowing(user: RequestUser, organizationId: string) {
    const row = await this.prisma.organizerFollow.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId } },
      select: { id: true },
    });
    if (!row) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'You do not follow this organizer.',
        HttpStatus.NOT_FOUND,
      );
    }
  }
}
