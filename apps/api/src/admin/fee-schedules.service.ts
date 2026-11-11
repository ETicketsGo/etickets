import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FeeRule, FeeScheduleDraft, Prisma } from '@prisma/client';
import { AdminPermission, NotificationType, feeBandLabel } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { AdminAudienceService } from '../notifications/admin-audience.service';
import { NotificationService } from '../notifications/notification.service';
import { scheduleFingerprint } from '../pricing/fee-schedule-fingerprint';
import { normaliseCharge, type FeeBandType } from './fee-band-charge';
import {
  estimateImpact,
  previewSchedule,
  validateSchedule,
  type ScheduleBand,
} from './fee-schedule-validation';

/**
 * Draft -> submit -> approve for one currency's booking-fee schedule. Maker-checker.
 *
 * The live bands (`FeeRule`) are not touched until an approval succeeds, and an approval writes
 * every change in ONE transaction, so checkout sees either the old schedule or the new one and
 * never a half-edited one. See `FeeScheduleDraft` in schema.prisma for why this exists.
 *
 *  - A draft is copied from the live, not-deleted bands of a currency. It may be broken while
 *    it is edited (gaps, overlaps); edits are saved as a whole list, not one call per band.
 *  - A MAKER (PLATFORM_CONFIG) submits it. It is then PENDING_APPROVAL: frozen (the database
 *    refuses a change to its bands), and still prices nothing.
 *  - A CHECKER (FEE_SCHEDULE_APPROVE + a fresh second factor) approves it, which publishes it,
 *    or rejects it with a reason, which reopens it for its maker. Nobody who created, saved or
 *    submitted a draft may approve or reject it, whatever they hold, super admin included: the
 *    rule is judged on identity, like the bank-account check (`payout-account-safety.ts`).
 *  - An approval is refused (409) when the draft has errors (`validateSchedule`), or when the
 *    live schedule changed after the draft was copied (its fingerprint moved): no lost update.
 *  - Each publish gets the next version number for the currency. Every step writes an audit
 *    entry and a `FeeScheduleDecision` row, which the database keeps append-only. A published
 *    draft row is never changed again (also enforced by a trigger): it is the version history.
 *  - Bookings already made keep their fee snapshot. A quote carries the live schedule's
 *    fingerprint, and a booking made from a quote taken before the publish is refused and
 *    re-quoted (BookingsService), not silently charged the new fee.
 *  - EMERGENCY ROLLBACK: one checker may, alone, restore an EARLIER PUBLISHED version - terms
 *    that were already live once - with a written reason and a fresh second factor. It is a new
 *    version marked `emergency`, and every other approver is notified to review it.
 */
@Injectable()
export class FeeSchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly audience?: AdminAudienceService,
    @Optional() private readonly notifications?: NotificationService,
  ) {}

  private liveBands(currency: string, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    return db.feeRule.findMany({
      where: { currency, deletedAt: null },
      orderBy: [{ minMinor: 'asc' }],
    });
  }

  /** The live schedule of a currency, its version, any open or pending draft, and history. */
  async overview(currency: string) {
    const [live, openDraft, pendingDraft, history] = await Promise.all([
      this.liveBands(currency),
      this.prisma.feeScheduleDraft.findFirst({
        where: { currency, status: 'OPEN' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true, createdByUserId: true, updatedAt: true },
      }),
      this.prisma.feeScheduleDraft.findFirst({
        where: { currency, status: 'PENDING_APPROVAL' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          createdByUserId: true,
          submittedByUserId: true,
          submittedAt: true,
        },
      }),
      this.prisma.feeScheduleDraft.findMany({
        where: { currency, status: 'PUBLISHED' },
        orderBy: { version: 'desc' },
        take: 20,
        select: {
          id: true,
          version: true,
          publishedAt: true,
          publishedByUserId: true,
          submittedByUserId: true,
          approvedByUserId: true,
          approvalNote: true,
          emergency: true,
          rollbackOfVersion: true,
        },
      }),
    ]);
    const people = await this.people([
      ...history.flatMap((h) => [h.publishedByUserId, h.submittedByUserId, h.approvedByUserId]),
      pendingDraft?.submittedByUserId,
    ]);
    return {
      currency,
      liveVersion: history[0]?.version ?? 0,
      liveFingerprint: scheduleFingerprint(live),
      live: live.map(toScheduleBand),
      openDraft,
      pendingDraft: pendingDraft
        ? { ...pendingDraft, submittedBy: people.get(pendingDraft.submittedByUserId ?? '') ?? null }
        : null,
      history: history.map((h) => ({
        ...h,
        publishedBy: people.get(h.publishedByUserId ?? '') ?? null,
        submittedBy: people.get(h.submittedByUserId ?? '') ?? null,
        approvedBy: people.get(h.approvedByUserId ?? '') ?? null,
      })),
    };
  }

  /**
   * Start a draft from the live schedule, or return the one already open or waiting for
   * approval for this currency: two drafts of one schedule would only meet at approval, where
   * the second is refused, so everybody is pointed at the same one instead.
   */
  async createDraft(actorUserId: string, currency: string) {
    const current = await this.prisma.feeScheduleDraft.findFirst({
      where: { currency, status: { in: ['OPEN', 'PENDING_APPROVAL'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (current) return this.draft(current.id, actorUserId);
    const live = await this.liveBands(currency);
    const created = await this.prisma.feeScheduleDraft.create({
      data: {
        currency,
        baseFingerprint: scheduleFingerprint(live),
        bands: live.map(toScheduleBand) as unknown as Prisma.InputJsonValue,
        createdByUserId: actorUserId,
        contributorUserIds: [actorUserId],
      },
    });
    await this.audit.record({
      actorUserId,
      action: 'FEE_SCHEDULE_DRAFT_CREATED',
      entityType: 'FeeScheduleDraft',
      entityId: created.id,
      metadata: { currency, baseFingerprint: created.baseFingerprint, bands: live.length },
    });
    return this.draft(created.id, actorUserId);
  }

  /**
   * A draft with its check, its fee preview, whether the live schedule moved on, its approval
   * history, and - for `viewerUserId` - whether that person may approve it and why not.
   */
  async draft(id: string, viewerUserId?: string) {
    const row = await this.prisma.feeScheduleDraft.findUnique({ where: { id } });
    if (!row) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Draft not found.', HttpStatus.NOT_FOUND);
    }
    const bands = row.bands as unknown as ScheduleBand[];
    const live = await this.liveBands(row.currency);
    const liveFingerprint = scheduleFingerprint(live);
    const decisions = await this.prisma.feeScheduleDecision.findMany({
      where: { draftId: row.id },
      orderBy: { createdAt: 'asc' },
    });
    const contributors = row.contributorUserIds ?? [];
    const people = await this.people([
      ...decisions.map((d) => d.actorUserId),
      ...contributors,
      row.createdByUserId,
      row.submittedByUserId,
      row.approvedByUserId,
    ]);
    const who = (userId: string | null) => (userId ? (people.get(userId) ?? null) : null);
    const blocked = viewerUserId ? approvalIndependenceFailure(viewerUserId, row) : null;
    return {
      id: row.id,
      currency: row.currency,
      status: row.status,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      publishedAt: row.publishedAt,
      createdBy: who(row.createdByUserId),
      contributors: contributors.map((c) => who(c)).filter(Boolean),
      submittedBy: who(row.submittedByUserId),
      submittedAt: row.submittedAt,
      submissionNote: row.submissionNote,
      approvedBy: who(row.approvedByUserId),
      approvedAt: row.approvedAt,
      approvalNote: row.approvalNote,
      lastRejectionNote: row.lastRejectionNote,
      emergency: row.emergency,
      rollbackOfVersion: row.rollbackOfVersion,
      /*
        When it takes effect. Approval publishes immediately; there is no scheduled activation
        (a future `effectiveFrom` needs a worker step that re-checks the schedule at the time,
        see docs/finance/FEE-SCHEDULE-APPROVAL.md). Published: when it went live.
      */
      effective:
        row.status === 'PUBLISHED'
          ? { at: row.publishedAt, mode: 'PUBLISHED' as const }
          : { at: null, mode: 'ON_APPROVAL' as const },
      decisions: decisions.map((d) => ({
        id: d.id,
        action: d.action,
        actor: who(d.actorUserId),
        note: d.note,
        version: d.version,
        createdAt: d.createdAt,
      })),
      viewer: viewerUserId
        ? {
            mayDecide: row.status === 'PENDING_APPROVAL' && blocked === null,
            independenceBlock: blocked,
          }
        : undefined,
      bands,
      // Only an unpublished draft can go stale; a published one IS (or was) the live schedule.
      stale:
        (row.status === 'OPEN' || row.status === 'PENDING_APPROVAL') &&
        liveFingerprint !== row.baseFingerprint,
      validation: validateSchedule(row.currency, bands),
      preview: previewSchedule(row.currency, bands, live.map(toScheduleBand)),
    };
  }

  /**
   * What this draft would have changed for the currency's real orders of the last `days` days:
   * booking fees re-priced under the live schedule and under the draft. An estimate for the
   * approver (see `estimateImpact` for what it leaves out). Reads only.
   */
  async impact(id: string, days = 30) {
    const row = await this.prisma.feeScheduleDraft.findUnique({ where: { id } });
    if (!row) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Draft not found.', HttpStatus.NOT_FOUND);
    }
    const windowDays = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
    const since = new Date(Date.now() - windowDays * 86_400_000);
    const [live, orders] = await Promise.all([
      this.liveBands(row.currency),
      this.prisma.booking.findMany({
        where: {
          currency: row.currency,
          status: { in: ['CONFIRMED', 'PARTIALLY_REFUNDED'] },
          confirmedAt: { gte: since },
        },
        select: { subtotalMinor: true, discountMinor: true, _count: { select: { tickets: true } } },
        orderBy: { confirmedAt: 'desc' },
        // Bounded: an estimate does not need every order, and this is an interactive read.
        take: 5000,
      }),
    ]);
    return estimateImpact(
      row.currency,
      row.bands as unknown as ScheduleBand[],
      live.map(toScheduleBand),
      orders.map((o) => ({
        orderMinor: Math.max(0, o.subtotalMinor - (o.discountMinor ?? 0)),
        tickets: Math.max(1, o._count.tickets),
      })),
      windowDays,
    );
  }

  /**
   * Replace the draft's bands. Nothing live changes; the check runs on what was saved.
   *
   * Every save that changes the bands writes one audit entry, in the same transaction as the
   * save: who, which draft and currency, the live version and fingerprint it was copied from,
   * and the bands added, removed and changed (before/after, minor units). A save that changes
   * nothing writes no entry. The saver joins the draft's contributors, who may not approve it.
   * The write is conditional on the draft being unchanged since it was read, so two saves that
   * race cannot lose either one's contributor record.
   */
  async saveDraft(actorUserId: string, id: string, bands: ScheduleBand[]) {
    const row = await this.openDraft(id);
    const previous = row.bands as unknown as ScheduleBand[];
    const changes = diffBands(previous, bands);
    let audit: AuditEntry | undefined;
    if (changes) {
      const base = await this.prisma.feeScheduleDraft.aggregate({
        where: { currency: row.currency, status: 'PUBLISHED', publishedAt: { lte: row.createdAt } },
        _max: { version: true },
      });
      audit = {
        actorUserId,
        action: 'FEE_SCHEDULE_DRAFT_SAVED',
        entityType: 'FeeScheduleDraft',
        entityId: row.id,
        metadata: {
          currency: row.currency,
          baseVersion: base._max.version ?? 0,
          baseFingerprint: row.baseFingerprint,
          bandsBefore: previous.length,
          bandsAfter: bands.length,
          changes,
          savedAt: new Date().toISOString(),
        },
      };
    }
    const entry = audit;
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.feeScheduleDraft.updateMany({
        where: { id: row.id, status: 'OPEN', updatedAt: row.updatedAt },
        data: {
          bands: bands as unknown as Prisma.InputJsonValue,
          updatedByUserId: actorUserId,
          ...(changes
            ? { contributorUserIds: withPerson(row.contributorUserIds, actorUserId) }
            : {}),
        },
      });
      if (claimed.count !== 1) throw draftMoved();
      if (entry) await this.audit.recordInTransaction(tx, entry);
    });
    if (entry) this.audit.afterCommit(entry);
    return this.draft(id, actorUserId);
  }

  async discardDraft(actorUserId: string, id: string) {
    const row = await this.openDraft(id);
    const claimed = await this.prisma.feeScheduleDraft.updateMany({
      where: { id: row.id, status: 'OPEN' },
      data: { status: 'DISCARDED', updatedByUserId: actorUserId },
    });
    if (claimed.count !== 1) throw draftMoved();
    await this.audit.record({
      actorUserId,
      action: 'FEE_SCHEDULE_DRAFT_DISCARDED',
      entityType: 'FeeScheduleDraft',
      entityId: id,
      metadata: { currency: row.currency },
    });
    return { id, status: 'DISCARDED' as const };
  }

  /**
   * The old one-person publish. Refused: a schedule goes live only when somebody other than
   * its maker approves it. Kept as a route so an old console gets a reason, not a 404.
   */
  async publish(_actorUserId: string, _id: string): Promise<never> {
    throw new AppException(
      ErrorCodes.FEE_SCHEDULE_APPROVAL_REQUIRED,
      'A fee schedule now goes live only when another administrator approves it. Submit this draft for approval instead. Nothing was published.',
      HttpStatus.CONFLICT,
      { reason: 'APPROVAL_REQUIRED' },
    );
  }

  /**
   * Maker: send the draft for approval. It must be whole (no errors), current (copied from the
   * live schedule as it is now) and actually change something. Then it is frozen until a
   * checker decides or its submitter withdraws it.
   */
  async submit(actorUserId: string, id: string, note?: string) {
    const row = await this.openDraft(id);
    const bands = row.bands as unknown as ScheduleBand[];
    const live = await this.liveBands(row.currency);
    assertCurrent(row, live);
    assertWhole(row.currency, bands, 'submitted');
    const changes = diffBands(live.map(toScheduleBand), bands);
    if (!changes) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This draft is the same as the live schedule, so there is nothing to approve.',
        HttpStatus.CONFLICT,
        { reason: 'NO_CHANGES' },
      );
    }
    const hash = bandsHash(bands);
    const cleanNote = note?.trim() || null;
    const committed: { audit?: AuditEntry; decisionId?: string } = {};
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.feeScheduleDraft.updateMany({
        where: { id: row.id, status: 'OPEN', updatedAt: row.updatedAt },
        data: {
          status: 'PENDING_APPROVAL',
          submittedByUserId: actorUserId,
          submittedAt: new Date(),
          submissionNote: cleanNote,
          submittedBandsHash: hash,
          contributorUserIds: withPerson(row.contributorUserIds, actorUserId),
        },
      });
      if (claimed.count !== 1) throw draftMoved();
      const decision = await tx.feeScheduleDecision.create({
        data: {
          draftId: row.id,
          currency: row.currency,
          action: 'SUBMITTED',
          actorUserId,
          note: cleanNote,
          bandsHash: hash,
        },
      });
      const entry: AuditEntry = {
        actorUserId,
        action: 'FEE_SCHEDULE_SUBMITTED',
        entityType: 'FeeScheduleDraft',
        entityId: row.id,
        metadata: {
          currency: row.currency,
          baseFingerprint: row.baseFingerprint,
          bandsHash: hash,
          note: cleanNote,
          changes,
        },
      };
      await this.audit.recordInTransaction(tx, entry);
      committed.audit = entry;
      committed.decisionId = decision.id;
    });
    if (committed.audit) this.audit.afterCommit(committed.audit);
    await this.notifyApprovers(
      {
        kind: 'SUBMITTED',
        draftId: row.id,
        decisionId: committed.decisionId ?? row.id,
        currency: row.currency,
        actorUserId,
        note: cleanNote,
      },
      new Set([...(row.contributorUserIds ?? []), row.createdByUserId, actorUserId]),
    );
    return this.draft(id, actorUserId);
  }

  /** Maker: take a submitted draft back to edit it. Only somebody who worked on it may. */
  async withdraw(actorUserId: string, id: string) {
    const row = await this.pendingDraft(id);
    const makers = new Set([...(row.contributorUserIds ?? []), row.createdByUserId]);
    if (!makers.has(actorUserId)) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Only somebody who worked on this draft can withdraw it. To stop it, reject it with a reason.',
        HttpStatus.FORBIDDEN,
        { reason: 'NOT_A_MAKER' },
      );
    }
    await this.decide(row, actorUserId, 'WITHDRAWN', null);
    return this.draft(id, actorUserId);
  }

  /** Checker: send a submitted draft back to its maker, with the reason. */
  async reject(actorUserId: string, id: string, note: string) {
    const reason = note?.trim() ?? '';
    if (reason.length < 5) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Say why the draft is rejected, so its maker can fix it.',
        HttpStatus.BAD_REQUEST,
        { reason: 'NOTE_REQUIRED' },
      );
    }
    const row = await this.pendingDraft(id);
    await this.assertIndependent(actorUserId, row, 'reject');
    const decisionId = await this.decide(row, actorUserId, 'REJECTED', reason);
    await this.notifyDecision(row, actorUserId, 'REJECTED', reason, null, decisionId);
    return this.draft(id, actorUserId);
  }

  /**
   * Checker: approve a submitted draft, which publishes it, in one transaction or not at all.
   *
   * Serialised per currency by an advisory lock, and checked again inside it: the draft is
   * still pending, its bands are the ones submitted, the live schedule is the one it was copied
   * from, the draft has no errors, and the approver did not work on it. The version number is
   * unique per currency in the database too, so two approvals that somehow passed the lock
   * together cannot both commit.
   */
  async approve(actorUserId: string, id: string, note?: string) {
    const first = await this.pendingDraft(id);
    await this.assertIndependent(actorUserId, first, 'approve');
    const cleanNote = note?.trim() || null;
    const committed: { audits: AuditEntry[]; decisionId?: string } = { audits: [] };
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fee-schedule:${first.currency}`}))`;
      const current = await tx.feeScheduleDraft.findUnique({ where: { id } });
      if (!current || current.status !== 'PENDING_APPROVAL') throw notPending();
      if (approvalIndependenceFailure(actorUserId, current)) throw independenceError();
      const bands = current.bands as unknown as ScheduleBand[];
      const hash = bandsHash(bands);
      if (current.submittedBandsHash !== hash) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'This draft changed after it was submitted. Nothing was published. Ask its maker to submit it again.',
          HttpStatus.CONFLICT,
          { reason: 'CHANGED_SINCE_SUBMISSION' },
        );
      }
      const live = await this.liveBands(current.currency, tx);
      assertCurrent(current, live);
      assertWhole(current.currency, bands, 'published');

      const version = await nextVersion(tx, current.currency);
      const changes = await applyBands(tx, actorUserId, current.currency, live, bands);
      const now = new Date();
      await tx.feeScheduleDraft.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          version,
          publishedAt: now,
          publishedByUserId: actorUserId,
          approvedByUserId: actorUserId,
          approvedAt: now,
          approvalNote: cleanNote,
        },
      });
      const decision = await tx.feeScheduleDecision.create({
        data: {
          draftId: id,
          currency: current.currency,
          action: 'APPROVED',
          actorUserId,
          note: cleanNote,
          bandsHash: hash,
          version,
        },
      });
      const after = await this.liveBands(current.currency, tx);
      const approved: AuditEntry = {
        actorUserId,
        action: 'FEE_SCHEDULE_APPROVED',
        entityType: 'FeeScheduleDraft',
        entityId: id,
        metadata: {
          currency: current.currency,
          version,
          submittedByUserId: current.submittedByUserId,
          note: cleanNote,
          bandsHash: hash,
        },
      };
      const published: AuditEntry = {
        actorUserId,
        action: 'FEE_SCHEDULE_PUBLISHED',
        entityType: 'FeeScheduleDraft',
        entityId: id,
        metadata: {
          currency: current.currency,
          version,
          ...changes,
          submittedByUserId: current.submittedByUserId,
          approvedByUserId: actorUserId,
          before: live.map(toScheduleBand),
          after: after.map(toScheduleBand),
        },
      };
      await this.audit.recordInTransaction(tx, approved);
      await this.audit.recordInTransaction(tx, published);
      committed.audits.push(approved, published);
      committed.decisionId = decision.id;
      return { id, currency: current.currency, version, ...changes };
    });
    for (const a of committed.audits) this.audit.afterCommit(a);
    await this.notifyDecision(
      first,
      actorUserId,
      'APPROVED',
      cleanNote,
      result.version,
      committed.decisionId ?? id,
    );
    return result;
  }

  /**
   * Break glass: restore an earlier PUBLISHED version of a currency's schedule, now, alone.
   *
   * Only terms that were already live once can come back this way, so it cannot introduce a
   * fee nobody approved. It still needs FEE_SCHEDULE_APPROVE, a fresh second factor and a
   * written reason; it is a new version marked `emergency`, audited, and every other approver
   * is told to review it. Any open or pending draft goes stale (the live schedule moved) and
   * can no longer be approved.
   */
  async emergencyRollback(
    actorUserId: string,
    currency: string,
    targetVersion: number,
    reason: string,
  ) {
    const why = reason?.trim() ?? '';
    if (why.length < 20) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'An emergency rollback needs a reason of at least 20 characters: what went wrong, and why it cannot wait for a normal approval.',
        HttpStatus.BAD_REQUEST,
        { reason: 'REASON_REQUIRED' },
      );
    }
    const committed: { audits: AuditEntry[]; draftId?: string; decisionId?: string } = {
      audits: [],
    };
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fee-schedule:${currency}`}))`;
      const latest = await tx.feeScheduleDraft.aggregate({
        where: { currency, status: 'PUBLISHED' },
        _max: { version: true },
      });
      const liveVersion = latest._max.version ?? 0;
      const target = await tx.feeScheduleDraft.findFirst({
        where: { currency, status: 'PUBLISHED', version: targetVersion },
      });
      if (!target || targetVersion >= liveVersion) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          `Version ${targetVersion} is not an earlier published ${currency} schedule (the live version is ${liveVersion}). Nothing was changed.`,
          HttpStatus.CONFLICT,
          { reason: 'NOT_AN_EARLIER_VERSION', liveVersion },
        );
      }
      const bands = target.bands as unknown as ScheduleBand[];
      assertWhole(currency, bands, 'restored');
      const live = await this.liveBands(currency, tx);
      const changes = diffBands(live.map(toScheduleBand), bands);
      if (!changes) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          `The live ${currency} schedule already charges what version ${targetVersion} did. Nothing was changed.`,
          HttpStatus.CONFLICT,
          { reason: 'ALREADY_LIVE' },
        );
      }
      const version = liveVersion + 1;
      const applied = await applyBands(tx, actorUserId, currency, live, bands);
      const now = new Date();
      const hash = bandsHash(bands);
      const row = await tx.feeScheduleDraft.create({
        data: {
          currency,
          status: 'PUBLISHED',
          baseFingerprint: scheduleFingerprint(live),
          bands: bands as unknown as Prisma.InputJsonValue,
          version,
          createdByUserId: actorUserId,
          contributorUserIds: [actorUserId],
          publishedByUserId: actorUserId,
          publishedAt: now,
          submissionNote: why,
          emergency: true,
          rollbackOfVersion: targetVersion,
        },
      });
      const decision = await tx.feeScheduleDecision.create({
        data: {
          draftId: row.id,
          currency,
          action: 'EMERGENCY_ROLLBACK',
          actorUserId,
          note: why,
          bandsHash: hash,
          version,
        },
      });
      const after = await this.liveBands(currency, tx);
      const rolled: AuditEntry = {
        actorUserId,
        action: 'FEE_SCHEDULE_EMERGENCY_ROLLBACK',
        entityType: 'FeeScheduleDraft',
        entityId: row.id,
        metadata: {
          currency,
          version,
          restoredVersion: targetVersion,
          fromVersion: liveVersion,
          reason: why,
        },
      };
      const published: AuditEntry = {
        actorUserId,
        action: 'FEE_SCHEDULE_PUBLISHED',
        entityType: 'FeeScheduleDraft',
        entityId: row.id,
        metadata: {
          currency,
          version,
          ...applied,
          emergency: true,
          restoredVersion: targetVersion,
          before: live.map(toScheduleBand),
          after: after.map(toScheduleBand),
        },
      };
      await this.audit.recordInTransaction(tx, rolled);
      await this.audit.recordInTransaction(tx, published);
      committed.audits.push(rolled, published);
      committed.draftId = row.id;
      committed.decisionId = decision.id;
      return { id: row.id, currency, version, restoredVersion: targetVersion, ...applied };
    });
    for (const a of committed.audits) this.audit.afterCommit(a);
    await this.notifyApprovers(
      {
        kind: 'EMERGENCY_ROLLBACK',
        draftId: committed.draftId ?? '',
        decisionId: committed.decisionId ?? '',
        currency,
        actorUserId,
        note: why,
        version: result.version,
        restoredVersion: targetVersion,
      },
      new Set([actorUserId]),
    );
    return result;
  }

  // ── internals ──────────────────────────────────────────────────────────────────

  /** Record a non-publishing decision (withdraw / reject): PENDING_APPROVAL -> OPEN. */
  private async decide(
    row: FeeScheduleDraft,
    actorUserId: string,
    action: 'WITHDRAWN' | 'REJECTED',
    note: string | null,
  ): Promise<string> {
    const committed: { audit?: AuditEntry; decisionId?: string } = {};
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.feeScheduleDraft.updateMany({
        where: { id: row.id, status: 'PENDING_APPROVAL' },
        data: {
          status: 'OPEN',
          submittedByUserId: null,
          submittedAt: null,
          submissionNote: null,
          submittedBandsHash: null,
          ...(action === 'REJECTED' ? { lastRejectionNote: note } : {}),
        },
      });
      if (claimed.count !== 1) throw notPending();
      const decision = await tx.feeScheduleDecision.create({
        data: {
          draftId: row.id,
          currency: row.currency,
          action,
          actorUserId,
          note,
          bandsHash: bandsHash(row.bands as unknown as ScheduleBand[]),
        },
      });
      const entry: AuditEntry = {
        actorUserId,
        action: action === 'REJECTED' ? 'FEE_SCHEDULE_REJECTED' : 'FEE_SCHEDULE_WITHDRAWN',
        entityType: 'FeeScheduleDraft',
        entityId: row.id,
        metadata: { currency: row.currency, submittedByUserId: row.submittedByUserId, note },
      };
      await this.audit.recordInTransaction(tx, entry);
      committed.audit = entry;
      committed.decisionId = decision.id;
    });
    if (committed.audit) this.audit.afterCommit(committed.audit);
    return committed.decisionId ?? row.id;
  }

  /** Refuse, and record the refusal, when the actor worked on the draft. */
  private async assertIndependent(
    actorUserId: string,
    row: FeeScheduleDraft,
    attempted: 'approve' | 'reject',
  ) {
    const failure = approvalIndependenceFailure(actorUserId, row);
    if (!failure) return;
    await this.audit.record({
      actorUserId,
      action: 'FEE_SCHEDULE_APPROVAL_REFUSED',
      entityType: 'FeeScheduleDraft',
      entityId: row.id,
      metadata: { currency: row.currency, attempted, reason: failure },
    });
    throw independenceError(attempted === 'reject');
  }

  private async openDraft(id: string) {
    const row = await this.prisma.feeScheduleDraft.findUnique({ where: { id } });
    if (!row) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Draft not found.', HttpStatus.NOT_FOUND);
    }
    if (row.status === 'PENDING_APPROVAL') {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This draft is waiting for approval and cannot be changed. Withdraw it first to edit it.',
        HttpStatus.CONFLICT,
        { reason: 'PENDING_APPROVAL' },
      );
    }
    if (row.status !== 'OPEN') {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This draft was already published or discarded and cannot be changed.',
        HttpStatus.CONFLICT,
        { reason: 'DRAFT_CLOSED' },
      );
    }
    return row;
  }

  private async pendingDraft(id: string) {
    const row = await this.prisma.feeScheduleDraft.findUnique({ where: { id } });
    if (!row) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Draft not found.', HttpStatus.NOT_FOUND);
    }
    if (row.status !== 'PENDING_APPROVAL') throw notPending();
    return row;
  }

  /** id -> { id, email, name } for display. Unknown ids are simply absent. */
  private async people(ids: readonly (string | null | undefined)[]) {
    const wanted = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    const map = new Map<string, { id: string; email: string; name: string | null }>();
    if (wanted.length === 0 || !this.prisma.user?.findMany) return map;
    const rows = await this.prisma.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, email: true, fullName: true },
    });
    for (const r of rows) map.set(r.id, { id: r.id, email: r.email, name: r.fullName ?? null });
    return map;
  }

  /** Tell the people who may approve. Never fails the action that has already committed. */
  private async notifyApprovers(
    input: {
      kind: 'SUBMITTED' | 'EMERGENCY_ROLLBACK';
      draftId: string;
      decisionId: string;
      currency: string;
      actorUserId: string;
      note: string | null;
      version?: number;
      restoredVersion?: number;
    },
    ruledOut: Set<string>,
  ) {
    if (!this.audience) return;
    try {
      const actor = (await this.people([input.actorUserId])).get(input.actorUserId);
      await this.audience.notifyAdminsHolding(
        [AdminPermission.FEE_SCHEDULE_APPROVE],
        NotificationType.FEE_SCHEDULE_AWAITING_APPROVAL,
        {
          kind: input.kind,
          draftId: input.draftId,
          decisionId: input.decisionId,
          currency: input.currency,
          actorEmail: actor?.email ?? '',
          note: input.note ?? '',
          ...(input.version ? { version: input.version } : {}),
          ...(input.restoredVersion ? { restoredVersion: input.restoredVersion } : {}),
        },
        { skip: (userId) => ruledOut.has(userId) },
      );
    } catch {
      // The decision is committed; a failed lookup must not turn it into an error.
    }
  }

  /** Tell the submitter what the checker decided. Never fails the decision. */
  private async notifyDecision(
    row: FeeScheduleDraft,
    actorUserId: string,
    decision: 'APPROVED' | 'REJECTED',
    note: string | null,
    version: number | null,
    decisionId: string,
  ) {
    if (!this.notifications || !row.submittedByUserId) return;
    try {
      const people = await this.people([row.submittedByUserId, actorUserId]);
      const to = people.get(row.submittedByUserId);
      if (!to) return;
      await this.notifications.send({
        type: NotificationType.FEE_SCHEDULE_DECIDED,
        userId: to.id,
        toEmail: to.email,
        payload: {
          decision,
          decisionId,
          draftId: row.id,
          currency: row.currency,
          deciderEmail: people.get(actorUserId)?.email ?? '',
          note: note ?? '',
          ...(version ? { version } : {}),
        },
      });
    } catch {
      // Same as above: the decision stands whether or not the message goes out.
    }
  }
}

/**
 * Why `actorUserId` may not decide on this draft, or null when they may.
 *
 * Judged on identity, never on role: a super admin who drafted a schedule is still its maker.
 * The maker is everybody recorded as having created, saved or submitted it.
 */
export type ApprovalIndependenceFailure = 'SUBMITTER' | 'CONTRIBUTOR';

export function approvalIndependenceFailure(
  actorUserId: string,
  draft: Pick<
    FeeScheduleDraft,
    'createdByUserId' | 'updatedByUserId' | 'submittedByUserId' | 'contributorUserIds'
  >,
): ApprovalIndependenceFailure | null {
  if (draft.submittedByUserId && draft.submittedByUserId === actorUserId) return 'SUBMITTER';
  const makers = new Set([
    draft.createdByUserId,
    ...(draft.updatedByUserId ? [draft.updatedByUserId] : []),
    ...(draft.contributorUserIds ?? []),
  ]);
  return makers.has(actorUserId) ? 'CONTRIBUTOR' : null;
}

/** A stable hash of a band list: same bands in any order, any JSON key order, same hash. */
export function bandsHash(bands: readonly ScheduleBand[]): string {
  const rows = bands
    .map((b) => JSON.stringify(compactBand(b)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function withPerson(list: readonly string[] | null | undefined, userId: string): string[] {
  const out = [...(list ?? [])];
  if (!out.includes(userId)) out.push(userId);
  return out;
}

function draftMoved() {
  return new AppException(
    ErrorCodes.CONFLICT,
    'This draft was changed by somebody else at the same moment. Reload it and try again.',
    HttpStatus.CONFLICT,
    { reason: 'DRAFT_MOVED' },
  );
}

function notPending() {
  return new AppException(
    ErrorCodes.CONFLICT,
    'This draft is not waiting for approval (it was already decided, withdrawn or published).',
    HttpStatus.CONFLICT,
    { reason: 'NOT_PENDING' },
  );
}

function independenceError(reject = false) {
  return new AppException(
    ErrorCodes.SEPARATION_OF_DUTIES,
    reject
      ? 'You worked on this draft, so you cannot reject it. Withdraw it instead.'
      : 'You worked on this draft, so you cannot approve it. Another administrator who holds the approval duty must approve it.',
    HttpStatus.FORBIDDEN,
    { reason: 'NOT_INDEPENDENT', rule: 'FEE_SCHEDULE_APPROVER_INDEPENDENT' },
  );
}

function assertCurrent(row: { currency: string; baseFingerprint: string }, live: FeeRule[]) {
  if (scheduleFingerprint(live) !== row.baseFingerprint) {
    throw new AppException(
      ErrorCodes.FEE_SCHEDULE_STALE,
      `The live ${row.currency} fee schedule was changed after this draft was started. Nothing was published. Reject or withdraw this draft and start a new one from the live schedule.`,
      HttpStatus.CONFLICT,
      { reason: 'STALE' },
    );
  }
}

function assertWhole(currency: string, bands: ScheduleBand[], verb: string) {
  const validation = validateSchedule(currency, bands);
  if (validation.valid) return;
  const errors = validation.issues.filter((i) => i.severity === 'error');
  throw new AppException(
    ErrorCodes.FEE_SCHEDULE_INVALID,
    `This schedule has ${errors.length === 1 ? '1 problem' : `${errors.length} problems`} to fix before it can be ${verb}. Nothing was changed.`,
    HttpStatus.CONFLICT,
    { reason: 'INVALID', issues: validation.issues },
  );
}

async function nextVersion(tx: Prisma.TransactionClient, currency: string) {
  const last = await tx.feeScheduleDraft.aggregate({
    where: { currency, status: 'PUBLISHED' },
    _max: { version: true },
  });
  return (last._max.version ?? 0) + 1;
}

/** A live band as a draft row. */
export function toScheduleBand(r: FeeRule): ScheduleBand {
  return {
    key: r.id,
    sourceId: r.id,
    minMinor: r.minMinor,
    maxMinor: r.maxMinor,
    feeType: (r.feeType ?? 'FLAT') as FeeBandType,
    feeMinor: r.feeMinor,
    feePercentBps: r.feePercentBps,
    minFeeMinor: r.minFeeMinor,
    maxFeeMinor: r.maxFeeMinor,
    country: r.country,
    region: r.region,
    active: r.active,
  };
}

const BAND_FIELDS = [
  'minMinor',
  'maxMinor',
  'feeType',
  'feeMinor',
  'feePercentBps',
  'minFeeMinor',
  'maxFeeMinor',
  'country',
  'region',
  'active',
] as const;
type BandField = (typeof BAND_FIELDS)[number];

function compactBand(b: ScheduleBand) {
  const out: Record<string, unknown> = { key: b.key, sourceId: b.sourceId ?? null };
  for (const f of BAND_FIELDS) out[f] = b[f] ?? null;
  return out;
}

/**
 * What a draft save changed, band by band (matched on the draft's `key`), or null when nothing
 * did. Order is ignored: the same bands in another order are the same schedule. Only the band
 * fields are listed, so the entry carries amounts and markets and nothing about any person.
 */
export function diffBands(before: ScheduleBand[], after: ScheduleBand[]) {
  const prior = new Map<string, ScheduleBand>();
  for (const b of before) if (!prior.has(b.key)) prior.set(b.key, b);
  const seen = new Set<string>();
  const added: Record<string, unknown>[] = [];
  const changed: {
    key: string;
    sourceId: string | null;
    fields: Partial<Record<BandField, { before: unknown; after: unknown }>>;
  }[] = [];
  for (const b of after) {
    const old = seen.has(b.key) ? undefined : prior.get(b.key);
    if (!old) {
      added.push(compactBand(b));
      continue;
    }
    seen.add(b.key);
    const fields: Partial<Record<BandField, { before: unknown; after: unknown }>> = {};
    for (const f of BAND_FIELDS) {
      const was = old[f] ?? null;
      const now = b[f] ?? null;
      if (was !== now) fields[f] = { before: was, after: now };
    }
    if (Object.keys(fields).length > 0) {
      changed.push({ key: b.key, sourceId: b.sourceId ?? null, fields });
    }
  }
  const removed = before.filter((b) => !seen.has(b.key)).map(compactBand);
  if (added.length === 0 && removed.length === 0 && changed.length === 0) return null;
  return { added, removed, changed };
}

/**
 * Write the draft over the live bands: unchanged rows are left alone, changed rows are updated
 * in place (the audit log keeps pointing at them), new rows are created, and live rows the
 * draft no longer has are soft-deleted exactly as a single delete would be.
 */
async function applyBands(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  currency: string,
  live: FeeRule[],
  bands: ScheduleBand[],
): Promise<{ created: number; updated: number; deleted: number }> {
  const byId = new Map(live.map((r) => [r.id, r]));
  const kept = new Set<string>();
  let created = 0;
  let updated = 0;
  for (const b of bands) {
    const charge = normaliseCharge({
      feeType: b.feeType,
      feeMinor: b.feeMinor,
      feePercentBps: b.feePercentBps,
      minFeeMinor: b.minFeeMinor,
      maxFeeMinor: b.maxFeeMinor,
    });
    const data = {
      minMinor: b.minMinor,
      maxMinor: b.maxMinor,
      ...charge,
      country: b.country,
      region: b.region,
      active: b.active,
    };
    const source = b.sourceId && !kept.has(b.sourceId) ? byId.get(b.sourceId) : undefined;
    if (source) {
      kept.add(source.id);
      const same =
        source.minMinor === data.minMinor &&
        source.maxMinor === data.maxMinor &&
        (source.feeType ?? 'FLAT') === data.feeType &&
        source.feeMinor === data.feeMinor &&
        source.feePercentBps === data.feePercentBps &&
        source.minFeeMinor === data.minFeeMinor &&
        source.maxFeeMinor === data.maxFeeMinor &&
        source.country === data.country &&
        source.region === data.region &&
        source.active === data.active;
      if (same) continue;
      await tx.feeRule.update({
        where: { id: source.id },
        data: { ...data, label: feeBandLabel(data, currency) },
      });
      updated++;
      continue;
    }
    await tx.feeRule.create({
      data: { ...data, currency, label: feeBandLabel(data, currency) },
    });
    created++;
  }
  const gone = live.filter((r) => !kept.has(r.id)).map((r) => r.id);
  if (gone.length > 0) {
    await tx.feeRule.updateMany({
      where: { id: { in: gone } },
      data: { active: false, deletedAt: new Date(), deletedByUserId: actorUserId },
    });
  }
  return { created, updated, deleted: gone.length };
}
