import { HttpStatus, Injectable } from '@nestjs/common';
import type { FeeRule, Prisma } from '@prisma/client';
import { feeBandLabel } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { scheduleFingerprint } from '../pricing/fee-schedule-fingerprint';
import { normaliseCharge, type FeeBandType } from './fee-band-charge';
import { previewSchedule, validateSchedule, type ScheduleBand } from './fee-schedule-validation';

/**
 * Draft -> check -> publish for one currency's booking-fee schedule.
 *
 * The live bands (`FeeRule`) are not touched until a publish succeeds, and a publish writes
 * every change in ONE transaction, so checkout sees either the old schedule or the new one and
 * never a half-edited one. See `FeeScheduleDraft` in schema.prisma for why this exists.
 *
 *  - A draft is copied from the live, not-deleted bands of a currency. It may be broken while
 *    it is edited (gaps, overlaps); edits are saved as a whole list, not one call per band.
 *  - A publish is refused (409) when the draft has errors (`validateSchedule`), or when the
 *    live schedule changed after the draft was copied (its fingerprint moved): no lost update.
 *  - Each publish gets the next version number for the currency and one audit entry with the
 *    bands before and after. The published draft row is never changed again.
 *  - Bookings already made keep their fee snapshot. A quote carries the live schedule's
 *    fingerprint, and a booking made from a quote taken before the publish is refused and
 *    re-quoted (BookingsService), not silently charged the new fee.
 */
@Injectable()
export class FeeSchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private liveBands(currency: string, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    return db.feeRule.findMany({
      where: { currency, deletedAt: null },
      orderBy: [{ minMinor: 'asc' }],
    });
  }

  /** The live schedule of a currency, its version, any open draft, and recent publishes. */
  async overview(currency: string) {
    const [live, openDraft, history] = await Promise.all([
      this.liveBands(currency),
      this.prisma.feeScheduleDraft.findFirst({
        where: { currency, status: 'OPEN' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true, createdByUserId: true, updatedAt: true },
      }),
      this.prisma.feeScheduleDraft.findMany({
        where: { currency, status: 'PUBLISHED' },
        orderBy: { version: 'desc' },
        take: 10,
        select: { id: true, version: true, publishedAt: true, publishedByUserId: true },
      }),
    ]);
    return {
      currency,
      liveVersion: history[0]?.version ?? 0,
      liveFingerprint: scheduleFingerprint(live),
      live: live.map(toScheduleBand),
      openDraft,
      history,
    };
  }

  /**
   * Start a draft from the live schedule, or return the one already open for this currency:
   * two admins editing two drafts of one schedule would only meet at publish, where the second
   * is refused, so they are pointed at the same one instead.
   */
  async createDraft(actorUserId: string, currency: string) {
    const open = await this.prisma.feeScheduleDraft.findFirst({
      where: { currency, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
    });
    if (open) return this.draft(open.id);
    const live = await this.liveBands(currency);
    const created = await this.prisma.feeScheduleDraft.create({
      data: {
        currency,
        baseFingerprint: scheduleFingerprint(live),
        bands: live.map(toScheduleBand) as unknown as Prisma.InputJsonValue,
        createdByUserId: actorUserId,
      },
    });
    await this.audit.record({
      actorUserId,
      action: 'FEE_SCHEDULE_DRAFT_CREATED',
      entityType: 'FeeScheduleDraft',
      entityId: created.id,
      metadata: { currency, baseFingerprint: created.baseFingerprint, bands: live.length },
    });
    return this.draft(created.id);
  }

  /** A draft with its check and its fee preview, and whether the live schedule moved on. */
  async draft(id: string) {
    const row = await this.prisma.feeScheduleDraft.findUnique({ where: { id } });
    if (!row) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Draft not found.', HttpStatus.NOT_FOUND);
    }
    const bands = row.bands as unknown as ScheduleBand[];
    const live = await this.liveBands(row.currency);
    const liveFingerprint = scheduleFingerprint(live);
    return {
      id: row.id,
      currency: row.currency,
      status: row.status,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      publishedAt: row.publishedAt,
      bands,
      // Only an open draft can go stale; a published one IS (or was) the live schedule.
      stale: row.status === 'OPEN' && liveFingerprint !== row.baseFingerprint,
      validation: validateSchedule(row.currency, bands),
      preview: previewSchedule(row.currency, bands, live.map(toScheduleBand)),
    };
  }

  /**
   * Replace the draft's bands. Nothing live changes; the check runs on what was saved.
   *
   * Every save that changes the bands writes one audit entry, in the same transaction as the
   * save: who, which draft and currency, the live version and fingerprint it was copied from,
   * and the bands added, removed and changed (before/after, minor units). A save that changes
   * nothing writes no entry.
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
      await tx.feeScheduleDraft.update({
        where: { id: row.id },
        data: {
          bands: bands as unknown as Prisma.InputJsonValue,
          updatedByUserId: actorUserId,
        },
      });
      if (entry) await this.audit.recordInTransaction(tx, entry);
    });
    if (entry) this.audit.afterCommit(entry);
    return this.draft(id);
  }

  async discardDraft(actorUserId: string, id: string) {
    const row = await this.openDraft(id);
    await this.prisma.feeScheduleDraft.update({
      where: { id: row.id },
      data: { status: 'DISCARDED', updatedByUserId: actorUserId },
    });
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
   * Make the draft the live schedule, in one transaction, or change nothing.
   *
   * Serialised per currency by an advisory lock, and checked again inside it: the draft is
   * still open, the live schedule is the one it was copied from, and the draft has no errors.
   * The version number is unique per currency in the database too, so two publishes that
   * somehow passed the lock together cannot both commit.
   */
  async publish(actorUserId: string, id: string) {
    const committed: { audit?: AuditEntry } = {};
    const result = await this.prisma.$transaction(async (tx) => {
      const draft = await tx.feeScheduleDraft.findUnique({ where: { id } });
      if (!draft) {
        throw new AppException(ErrorCodes.NOT_FOUND, 'Draft not found.', HttpStatus.NOT_FOUND);
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fee-schedule:${draft.currency}`}))`;
      const current = await tx.feeScheduleDraft.findUnique({ where: { id } });
      if (!current || current.status !== 'OPEN') {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'This draft was already published or discarded. Open the live schedule to start a new draft.',
          HttpStatus.CONFLICT,
          { reason: 'DRAFT_CLOSED' },
        );
      }
      const live = await this.liveBands(current.currency, tx);
      if (scheduleFingerprint(live) !== current.baseFingerprint) {
        throw new AppException(
          ErrorCodes.FEE_SCHEDULE_STALE,
          `The live ${current.currency} fee schedule was changed after this draft was started. Nothing was published. Discard this draft and start a new one from the live schedule.`,
          HttpStatus.CONFLICT,
          { reason: 'STALE' },
        );
      }
      const bands = current.bands as unknown as ScheduleBand[];
      const validation = validateSchedule(current.currency, bands);
      if (!validation.valid) {
        const errors = validation.issues.filter((i) => i.severity === 'error');
        throw new AppException(
          ErrorCodes.FEE_SCHEDULE_INVALID,
          `This draft has ${errors.length === 1 ? '1 problem' : `${errors.length} problems`} to fix before it can be published. Nothing was published.`,
          HttpStatus.CONFLICT,
          { reason: 'INVALID', issues: validation.issues },
        );
      }

      const last = await tx.feeScheduleDraft.aggregate({
        where: { currency: current.currency, status: 'PUBLISHED' },
        _max: { version: true },
      });
      const version = (last._max.version ?? 0) + 1;
      const changes = await applyBands(tx, actorUserId, current.currency, live, bands);

      await tx.feeScheduleDraft.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          version,
          publishedAt: new Date(),
          publishedByUserId: actorUserId,
        },
      });
      const after = await this.liveBands(current.currency, tx);
      const audit: AuditEntry = {
        actorUserId,
        action: 'FEE_SCHEDULE_PUBLISHED',
        entityType: 'FeeScheduleDraft',
        entityId: id,
        metadata: {
          currency: current.currency,
          version,
          ...changes,
          before: live.map(toScheduleBand),
          after: after.map(toScheduleBand),
        },
      };
      await this.audit.recordInTransaction(tx, audit);
      committed.audit = audit;
      return { id, currency: current.currency, version, ...changes };
    });
    if (committed.audit) this.audit.afterCommit(committed.audit);
    return result;
  }

  private async openDraft(id: string) {
    const row = await this.prisma.feeScheduleDraft.findUnique({ where: { id } });
    if (!row) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Draft not found.', HttpStatus.NOT_FOUND);
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
