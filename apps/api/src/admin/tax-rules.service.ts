import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma, TaxBase, TaxRule, TaxRuleChange } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { TAX_CATEGORIES, isTaxCategory } from '@eticketsgo/shared-types';
import { approvalIndependenceFailure } from './fee-schedules.service';

type Db = Prisma.TransactionClient | PrismaService;

/** The fields that decide WHO a live rule charges and WHEN. Changing one needs a checker. */
const SCOPE_FIELDS = [
  'taxGroup',
  'country',
  'region',
  'currency',
  'category',
  'priority',
  'effectiveFrom',
  'effectiveTo',
] as const;

/**
 * Tax rules, as an administrator edits them.
 *
 * ── WHY EDITING A RATE IS NOT ALLOWED ──────────────────────────────────────────────
 * The schema says it plainly: "a rate change is a NEW rule with a later `effectiveFrom`,
 * never an edit". This service is where that stops being a comment.
 *
 * A booking snapshots the tax it was charged, so editing a live rate does not corrupt past
 * money. What it destroys is the ability to answer "what were we charging on 3 March, and
 * why" — the row that produced those snapshots is simply gone, replaced by one that says
 * something else. Every rate this platform charges changed on 22 September 2025; a table
 * that cannot express "18% until then, 5% after" cannot describe its own history.
 *
 * So a live rate is superseded rather than edited: the old rule gets an `effectiveTo`, the
 * new one an `effectiveFrom` at the same instant, and both stay on file. The boundary is
 * exact because `effectiveTo` is exclusive and `effectiveFrom` inclusive, so there is no
 * moment where both apply and none where neither does.
 *
 * A rule that has NEVER been active is a draft, and a draft can be edited freely — nothing
 * was ever charged under it.
 *
 * ── MAKER-CHECKER (AR-56) ──────────────────────────────────────────────────────────
 * One person used to be able to switch on the tax every buyer pays (GST adds about 18% of the
 * fee). Now the changes that START or CHANGE a charge are filed as a `TaxRuleChange` by one
 * administrator (PLATFORM_CONFIG) and applied only when a DIFFERENT administrator holding
 * FEE_SCHEDULE_APPROVE approves it, with a fresh second factor - the fee-schedule pattern
 * (AR-09), judged on identity by the same `approvalIndependenceFailure`, super admin included.
 *
 *   needs a checker   switching a rule ON (including creating one with `active: true`, which
 *                     creates it OFF and files the activation); changing who or when a LIVE
 *                     rule charges (group, place, currency, category, priority, dates);
 *                     superseding a LIVE rule.
 *   does not          drafts (never charged anybody); relabelling; switching a rule OFF,
 *                     which must never be blocked; deleting a rule that is off.
 *
 * Approval re-checks, under a per-rule lock, that the rule has not changed since the request
 * was filed (`baseUpdatedAt`) and that the request is the one submitted (`payloadHash`), so a
 * checker approves exactly what they read. Rules already in the database keep their state.
 */
@Injectable()
export class TaxRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Who would be charging tax without being registered to.
   *
   * ── WHY AN ADMINISTRATOR NEEDS THIS ON THIS SCREEN ─────────────────────────────
   * Tax rules are platform-wide; a tax registration belongs to one organizer. Switching a
   * rule on therefore starts collecting GST from every seller it matches — including any who
   * have never recorded a GSTIN.
   *
   * That is a real problem in both directions. A seller who is not registered may not
   * lawfully collect the tax, and the buyer gets a document that says in as many words "this
   * is not a tax invoice" — so they paid tax they cannot claim back. The receipt has always
   * been honest about it; nothing told the person switching the rule on.
   *
   * Reported rather than refused. Whether to sell at all through an unregistered organizer
   * is a business and legal decision, and one this service is in no position to make.
   */
  async unregisteredSellerCount(): Promise<number> {
    return this.prisma.organization.count({
      where: {
        OR: [{ taxRegistrationNumber: null }, { taxRegistrationNumber: '' }],
        status: { not: 'SUSPENDED' },
      },
    });
  }

  /** Every rule, current first, with whatever an administrator needs to judge it. */
  async list() {
    const rows = await this.prisma.taxRule.findMany({
      orderBy: [{ country: 'asc' }, { priority: 'asc' }, { effectiveFrom: 'desc' }],
    });
    const now = new Date();
    return rows.map((r) => ({
      ...r,
      /**
       * Whether this rule would be applied to a sale happening right now.
       *
       * `active` alone is misleading: a rule can be active and not yet in force, or active
       * and long superseded. An administrator looking for "what are we charging today" needs
       * the answer, not the flag.
       */
      inForceNow:
        r.active &&
        (!r.effectiveFrom || r.effectiveFrom <= now) &&
        (!r.effectiveTo || r.effectiveTo > now),
    }));
  }

  async create(actorUserId: string, input: TaxRuleInput) {
    this.assertBandShape(input);
    this.assertNamesClassification(input);
    // Switching it on is a second person's decision: created OFF, activation filed below.
    const wantsActive = input.active === true;

    const created = await this.prisma.taxRule.create({
      data: {
        label: input.label,
        rateBasisPoints: input.rateBasisPoints,
        appliesTo: input.appliesTo as TaxBase,
        taxGroup: input.taxGroup ?? '',
        country: input.country ?? '*',
        region: input.region ?? '*',
        currency: input.currency ?? '*',
        category: input.category ?? '*',
        minUnitMinor: input.minUnitMinor ?? null,
        maxUnitMinor: input.maxUnitMinor ?? null,
        inclusive: input.inclusive ?? false,
        split: input.split ?? 'NONE',
        priority: input.priority ?? 100,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
        /*
          Created switched OFF unless somebody says otherwise.

          Adding a row and charging tax with it are different decisions, and a form that does
          both in one click will eventually be submitted by someone who only meant the first.
        */
        active: false,
      },
    });

    await this.audit.record({
      actorUserId,
      action: 'TAX_RULE_CREATED',
      entityType: 'TaxRule',
      entityId: created.id,
      metadata: { label: created.label, rateBasisPoints: created.rateBasisPoints },
    });
    if (wantsActive) {
      const pendingChange = await this.fileChange(actorUserId, created, 'UPDATE', {
        active: true,
      });
      return { ...created, pendingChange };
    }
    return created;
  }

  /**
   * Change a rule that has never charged anybody, or switch one on and off.
   *
   * The rate and what it is levied on are editable only while the rule is a draft. Once it
   * has been active, those become the province of `supersede`.
   */
  async update(actorUserId: string, id: string, patch: TaxRulePatch, note?: string) {
    const existing = await this.prisma.taxRule.findUnique({ where: { id } });
    if (!existing) throw new AppException(ErrorCodes.NOT_FOUND, 'Tax rule not found.');

    const changesTheCharge =
      (patch.rateBasisPoints != null && patch.rateBasisPoints !== existing.rateBasisPoints) ||
      (patch.appliesTo != null && patch.appliesTo !== existing.appliesTo) ||
      (patch.inclusive != null && patch.inclusive !== existing.inclusive) ||
      (patch.split != null && patch.split !== existing.split) ||
      (patch.minUnitMinor !== undefined && patch.minUnitMinor !== existing.minUnitMinor) ||
      (patch.maxUnitMinor !== undefined && patch.maxUnitMinor !== existing.maxUnitMinor);

    if (changesTheCharge && existing.active) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This rule is live, so its rate and basis cannot be edited in place — that would ' +
          'erase what was being charged before. Supersede it instead: the old rule is closed ' +
          'off at a date and a new one takes over, and both stay on file.',
      );
    }

    this.assertBandShape(nextRule(existing, patch));

    if (needsApproval(existing, patch)) {
      const pendingChange = await this.fileChange(actorUserId, existing, 'UPDATE', patch, note);
      return { ...existing, pendingChange };
    }

    const { updated, entry } = await this.applyUpdate(this.prisma, actorUserId, existing, patch);
    await this.audit.record(entry);
    return updated;
  }

  /** Write a patch to a rule. The caller has decided it may be written, and by whom. */
  private async applyUpdate(
    db: Db,
    actorUserId: string,
    existing: TaxRule,
    patch: TaxRulePatch,
    approval?: { changeId: string; submittedByUserId: string },
  ): Promise<{ updated: TaxRule; entry: AuditEntry }> {
    const next = nextRule(existing, patch);
    const updated = await db.taxRule.update({ where: { id: existing.id }, data: next });
    return {
      updated,
      entry: {
        actorUserId,
        action: patch.active === undefined ? 'TAX_RULE_UPDATED' : 'TAX_RULE_TOGGLED',
        entityType: 'TaxRule',
        entityId: existing.id,
        metadata: {
          before: { rateBasisPoints: existing.rateBasisPoints, active: existing.active },
          after: { rateBasisPoints: updated.rateBasisPoints, active: updated.active },
          ...(approval
            ? {
                changeId: approval.changeId,
                submittedByUserId: approval.submittedByUserId,
                approvedByUserId: actorUserId,
              }
            : {}),
        },
      },
    };
  }

  /**
   * Close one rule and open its successor at a new rate.
   *
   * A draft's successor is written at once. A LIVE rule's is a new rate on real sales, so it
   * is filed for a second person to approve (AR-56) and nothing changes until they do.
   */
  async supersede(
    actorUserId: string,
    id: string,
    input: { rateBasisPoints: number; effectiveFrom: Date; label?: string },
    note?: string,
  ) {
    const existing = await this.prisma.taxRule.findUnique({ where: { id } });
    if (!existing) throw new AppException(ErrorCodes.NOT_FOUND, 'Tax rule not found.');
    assertSupersedable(existing, input.effectiveFrom);
    this.assertBandShape({ rateBasisPoints: input.rateBasisPoints });

    if (existing.active) {
      const pendingChange = await this.fileChange(
        actorUserId,
        existing,
        'SUPERSEDE',
        {
          rateBasisPoints: input.rateBasisPoints,
          effectiveFrom: input.effectiveFrom,
          ...(input.label ? { label: input.label } : {}),
        },
        note,
      );
      return { closed: existing, successor: null, pendingChange };
    }

    const { closed, successor, entry } = await this.prisma.$transaction((tx) =>
      this.applySupersede(tx, actorUserId, existing, input),
    );
    await this.audit.record(entry);
    return { closed, successor };
  }

  /**
   * Close one rule and open its successor, at the same instant, on the caller's transaction.
   *
   * The two writes share a transaction because the alternative states are both wrong: an old
   * rule closed with no successor charges nothing, and a successor opened before the old one
   * closes charges twice. Neither is a state anybody should be able to observe.
   */
  private async applySupersede(
    db: Prisma.TransactionClient,
    actorUserId: string,
    existing: TaxRule,
    input: { rateBasisPoints: number; effectiveFrom: Date; label?: string },
    approval?: { changeId: string; submittedByUserId: string },
  ) {
    const closed = await db.taxRule.update({
      where: { id: existing.id },
      // Exclusive upper bound against the successor's inclusive lower bound: at the
      // changeover instant exactly one rule applies.
      data: { effectiveTo: input.effectiveFrom },
    });
    const successor = await db.taxRule.create({
      data: {
        label: input.label ?? existing.label,
        rateBasisPoints: input.rateBasisPoints,
        appliesTo: existing.appliesTo,
        taxGroup: existing.taxGroup,
        country: existing.country,
        region: existing.region,
        currency: existing.currency,
        category: existing.category,
        minUnitMinor: existing.minUnitMinor,
        maxUnitMinor: existing.maxUnitMinor,
        inclusive: existing.inclusive,
        split: existing.split,
        priority: existing.priority,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
        // Inherits whether it is live: superseding a rule that was charging must not
        // silently stop charging, and superseding a draft must not silently start.
        active: existing.active,
      },
    });
    const entry: AuditEntry = {
      actorUserId,
      action: 'TAX_RULE_SUPERSEDED',
      entityType: 'TaxRule',
      entityId: existing.id,
      metadata: {
        from: existing.rateBasisPoints,
        to: input.rateBasisPoints,
        at: input.effectiveFrom.toISOString(),
        successorId: successor.id,
        ...(approval
          ? {
              changeId: approval.changeId,
              submittedByUserId: approval.submittedByUserId,
              approvedByUserId: actorUserId,
            }
          : {}),
      },
    };
    return { closed, successor, entry };
  }

  // -- Maker-checker (AR-56) ------------------------------------------------------------

  /** Filed changes, newest first: the pending queue, or the history. */
  async listChanges(status?: TaxRuleChange['status']) {
    return this.prisma.taxRuleChange.findMany({
      where: status ? { status } : {},
      orderBy: { submittedAt: 'desc' },
      take: 200,
    });
  }

  /** Maker: file a change for a checker. Nothing about the rule changes yet. */
  private async fileChange(
    actorUserId: string,
    rule: TaxRule,
    action: TaxRuleChange['action'],
    payload: TaxRulePatch | SupersedePayload,
    note?: string,
  ) {
    const stored = toStoredPayload(payload);
    const change = await this.prisma.taxRuleChange.create({
      data: {
        taxRuleId: rule.id,
        action,
        payload: stored as Prisma.InputJsonValue,
        payloadHash: payloadHash(stored),
        baseUpdatedAt: rule.updatedAt,
        submittedByUserId: actorUserId,
        submissionNote: note?.trim() || null,
      },
    });
    await this.audit.record({
      actorUserId,
      action: 'TAX_RULE_CHANGE_SUBMITTED',
      entityType: 'TaxRule',
      entityId: rule.id,
      metadata: { changeId: change.id, action, payload: stored },
    });
    return {
      id: change.id,
      action,
      status: change.status,
      message:
        'Filed for approval. Another administrator with the approval duty must approve it before it takes effect.',
    };
  }

  /**
   * Checker: apply a filed change, in one transaction or not at all.
   *
   * Serialised per rule by an advisory lock and checked again inside it: still pending, the
   * payload is the one submitted, the rule has not moved since it was filed, and the approver
   * is not the maker - judged on identity, never role.
   */
  async approveChange(actorUserId: string, changeId: string, note?: string) {
    const first = await this.pendingChange(changeId);
    await this.assertIndependent(actorUserId, first, 'approve');
    const cleanNote = note?.trim() || null;
    const audits: AuditEntry[] = [];

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tax-rule:${first.taxRuleId}`}))`;
      const change = await tx.taxRuleChange.findUnique({ where: { id: changeId } });
      if (!change || change.status !== 'PENDING_APPROVAL') throw notPending();
      if (independenceFailure(actorUserId, change)) throw independenceError(false);
      if (payloadHash(change.payload) !== change.payloadHash) {
        throw stale('CHANGED_SINCE_SUBMISSION');
      }
      const rule = await tx.taxRule.findUnique({ where: { id: change.taxRuleId } });
      if (!rule) throw new AppException(ErrorCodes.NOT_FOUND, 'Tax rule not found.');
      if (rule.updatedAt.getTime() !== change.baseUpdatedAt.getTime()) throw stale('RULE_MOVED');

      const approval = { changeId, submittedByUserId: change.submittedByUserId };
      let outcome: Record<string, unknown>;
      let resultTaxRuleId: string | null = null;
      if (change.action === 'SUPERSEDE') {
        const input = fromStoredSupersede(change.payload);
        assertSupersedable(rule, input.effectiveFrom);
        const applied = await this.applySupersede(tx, actorUserId, rule, input, approval);
        audits.push(applied.entry);
        resultTaxRuleId = applied.successor.id;
        outcome = { closed: applied.closed, successor: applied.successor };
      } else {
        const patch = fromStoredPatch(change.payload);
        this.assertBandShape(nextRule(rule, patch));
        const applied = await this.applyUpdate(tx, actorUserId, rule, patch, approval);
        audits.push(applied.entry);
        outcome = { rule: applied.updated };
      }

      const claimed = await tx.taxRuleChange.updateMany({
        where: { id: changeId, status: 'PENDING_APPROVAL' },
        data: {
          status: 'APPROVED',
          decidedByUserId: actorUserId,
          decidedAt: new Date(),
          decisionNote: cleanNote,
          resultTaxRuleId,
        },
      });
      if (claimed.count !== 1) throw notPending();
      audits.push({
        actorUserId,
        action: 'TAX_RULE_CHANGE_APPROVED',
        entityType: 'TaxRule',
        entityId: change.taxRuleId,
        metadata: {
          changeId,
          action: change.action,
          submittedByUserId: change.submittedByUserId,
          note: cleanNote,
        },
      });
      for (const entry of audits) await this.audit.recordInTransaction(tx, entry);
      return { changeId, status: 'APPROVED' as const, ...outcome };
    });
    for (const entry of audits) this.audit.afterCommit(entry);
    return result;
  }

  /** Checker: refuse a filed change, with the reason. Changes no rule. */
  async rejectChange(actorUserId: string, changeId: string, note: string) {
    const reason = note?.trim() ?? '';
    if (reason.length < 5) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Say why the change is rejected, so its maker can fix it.',
        HttpStatus.BAD_REQUEST,
        { reason: 'NOTE_REQUIRED' },
      );
    }
    const change = await this.pendingChange(changeId);
    await this.assertIndependent(actorUserId, change, 'reject');
    return this.decide(change, actorUserId, 'REJECTED', reason);
  }

  /** Maker: take back a change they filed. Only its submitter may. */
  async withdrawChange(actorUserId: string, changeId: string) {
    const change = await this.pendingChange(changeId);
    if (change.submittedByUserId !== actorUserId) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Only the administrator who filed this change can withdraw it. To stop it, reject it with a reason.',
        HttpStatus.FORBIDDEN,
        { reason: 'NOT_A_MAKER' },
      );
    }
    return this.decide(change, actorUserId, 'WITHDRAWN', null);
  }

  private async decide(
    change: TaxRuleChange,
    actorUserId: string,
    status: 'REJECTED' | 'WITHDRAWN',
    note: string | null,
  ) {
    const claimed = await this.prisma.taxRuleChange.updateMany({
      where: { id: change.id, status: 'PENDING_APPROVAL' },
      data: { status, decidedByUserId: actorUserId, decidedAt: new Date(), decisionNote: note },
    });
    if (claimed.count !== 1) throw notPending();
    await this.audit.record({
      actorUserId,
      action: status === 'REJECTED' ? 'TAX_RULE_CHANGE_REJECTED' : 'TAX_RULE_CHANGE_WITHDRAWN',
      entityType: 'TaxRule',
      entityId: change.taxRuleId,
      metadata: { changeId: change.id, action: change.action, note },
    });
    return { changeId: change.id, status };
  }

  private async pendingChange(changeId: string): Promise<TaxRuleChange> {
    const change = await this.prisma.taxRuleChange.findUnique({ where: { id: changeId } });
    if (!change) throw new AppException(ErrorCodes.NOT_FOUND, 'Tax rule change not found.');
    if (change.status !== 'PENDING_APPROVAL') throw notPending();
    return change;
  }

  private async assertIndependent(
    actorUserId: string,
    change: TaxRuleChange,
    attempted: 'approve' | 'reject',
  ) {
    const failure = independenceFailure(actorUserId, change);
    if (!failure) return;
    await this.audit.record({
      actorUserId,
      action: 'TAX_RULE_CHANGE_APPROVAL_REFUSED',
      entityType: 'TaxRule',
      entityId: change.taxRuleId,
      metadata: { changeId: change.id, attempted, reason: failure },
    });
    throw independenceError(attempted === 'reject');
  }

  /**
   * Delete a rule that never charged anybody.
   *
   * A rule that has been active is kept, deactivated, because it is the only record of what
   * the platform was charging and why. Bookings snapshot their own tax lines, so deleting
   * would not corrupt a total — it would just make the configuration unexplainable, which is
   * the thing an auditor asks about.
   */
  async remove(actorUserId: string, id: string) {
    const existing = await this.prisma.taxRule.findUnique({ where: { id } });
    if (!existing) throw new AppException(ErrorCodes.NOT_FOUND, 'Tax rule not found.');
    if (existing.active) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'A live tax rule cannot be deleted. Switch it off first — and if it has ever charged ' +
          'anybody, keep it: it is the only record of what was being charged.',
      );
    }

    await this.prisma.taxRule.delete({ where: { id } });
    await this.audit.record({
      actorUserId,
      action: 'TAX_RULE_DELETED',
      entityType: 'TaxRule',
      entityId: id,
      metadata: { label: existing.label, rateBasisPoints: existing.rateBasisPoints },
    });
    return { deleted: true };
  }

  /**
   * A band that cannot match anything is a rule that silently does nothing.
   *
   * Inverted bounds are the obvious case. The subtler one is a rule that is scoped by band
   * but priced at a rate somebody meant to be an exemption — that IS valid (zero is a rate),
   * so it is deliberately not refused here.
   */
  /**
   * A rule in a tax GROUP on the ticket base must name the tax classification it rates.
   *
   * A group on tickets holds alternatives chosen by what the ticket is - India's cinema, sport
   * and performance rates. The engine lets only a rule NAMING a ticket's classification rate it,
   * so a '*' or misspelt category there would be a rule that never charges anything, which
   * looks configured and is not. Refused here, where the person typing it can still fix it. (A
   * '*' catch-all is exactly what used to tax every cinema ticket at 18%: H-8.)
   *
   * Checked on create only: switching an existing rule off must never be blocked.
   */
  private assertNamesClassification(rule: TaxRuleInput): void {
    const onTickets = rule.appliesTo === 'TICKETS' || rule.appliesTo === 'TICKETS_AND_FEES';
    if (!onTickets || !(rule.taxGroup ?? '').trim()) return;
    if (!isTaxCategory((rule.category ?? '').trim())) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A ticket rule in a tax group must name one tax classification (' +
          TAX_CATEGORIES.join(', ') +
          '). A catch-all would never be applied.',
      );
    }
  }

  private assertBandShape(rule: {
    minUnitMinor?: number | null;
    maxUnitMinor?: number | null;
    rateBasisPoints?: number;
  }): void {
    const { minUnitMinor: min, maxUnitMinor: max } = rule;
    if (min != null && max != null && min > max) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `That band never matches anything: its lower bound (${min}) is above its upper (${max}).`,
      );
    }
    if (rule.rateBasisPoints != null && rule.rateBasisPoints > 10_000) {
      // 100% is not a rate anybody means to type; it is a decimal-point slip.
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A rate above 100% is almost certainly a typo. Rates are BASIS POINTS: 1800 = 18%.',
      );
    }
  }
}

interface SupersedePayload {
  rateBasisPoints: number;
  effectiveFrom: Date;
  label?: string;
}

/** The rule a patch would produce. One definition for the direct write and the approval. */
function nextRule(existing: TaxRule, patch: TaxRulePatch) {
  return {
    label: patch.label ?? existing.label,
    rateBasisPoints: patch.rateBasisPoints ?? existing.rateBasisPoints,
    appliesTo: (patch.appliesTo ?? existing.appliesTo) as TaxBase,
    taxGroup: patch.taxGroup ?? existing.taxGroup,
    country: patch.country ?? existing.country,
    region: patch.region ?? existing.region,
    currency: patch.currency ?? existing.currency,
    category: patch.category ?? existing.category,
    minUnitMinor: patch.minUnitMinor === undefined ? existing.minUnitMinor : patch.minUnitMinor,
    maxUnitMinor: patch.maxUnitMinor === undefined ? existing.maxUnitMinor : patch.maxUnitMinor,
    inclusive: patch.inclusive ?? existing.inclusive,
    split: patch.split ?? existing.split,
    priority: patch.priority ?? existing.priority,
    effectiveFrom: patch.effectiveFrom === undefined ? existing.effectiveFrom : patch.effectiveFrom,
    effectiveTo: patch.effectiveTo === undefined ? existing.effectiveTo : patch.effectiveTo,
    active: patch.active ?? existing.active,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) =>
    v instanceof Date ? v.getTime() : v === undefined ? null : (v as unknown);
  return norm(a) === norm(b);
}

/**
 * Whether this patch starts a charge, or changes who or when a LIVE rule charges (AR-56).
 *
 * Switching a rule OFF never needs a second person: it is how a wrong rate is stopped, and it
 * must be possible at once. Rate, basis and band changes on a live rule are refused outright
 * (they must be superseded), so they never reach here for a live rule; on a draft they are
 * edits to something that charges nobody.
 */
export function needsApproval(
  existing: Pick<TaxRule, 'active' | (typeof SCOPE_FIELDS)[number]>,
  patch: TaxRulePatch,
): boolean {
  if (patch.active === false) return false;
  if (patch.active === true && !existing.active) return true;
  if (!existing.active) return false;
  return SCOPE_FIELDS.some(
    (field) => patch[field] !== undefined && !sameValue(patch[field], existing[field]),
  );
}

function assertSupersedable(existing: Pick<TaxRule, 'effectiveTo'>, effectiveFrom: Date) {
  if (existing.effectiveTo && existing.effectiveTo <= effectiveFrom) {
    throw new AppException(
      ErrorCodes.CONFLICT,
      'That rule already ended before the date you gave, so there is nothing to supersede.',
    );
  }
}

/** JSON-safe, key-sorted payload: dates as ISO strings, undefined dropped. */
function toStoredPayload(payload: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    const value = (payload as Record<string, unknown>)[key];
    if (value === undefined) continue;
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/** sha256 of a stored payload, independent of key order. */
export function payloadHash(payload: unknown): string {
  const stored = toStoredPayload((payload ?? {}) as object);
  return createHash('sha256').update(JSON.stringify(stored)).digest('hex');
}

const DATE_FIELDS = new Set(['effectiveFrom', 'effectiveTo']);

function fromStoredPatch(payload: Prisma.JsonValue): TaxRulePatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries((payload ?? {}) as Record<string, unknown>)) {
    out[key] = DATE_FIELDS.has(key) && typeof value === 'string' ? new Date(value) : value;
  }
  return out as TaxRulePatch;
}

function fromStoredSupersede(payload: Prisma.JsonValue): SupersedePayload {
  const p = fromStoredPatch(payload);
  return {
    rateBasisPoints: p.rateBasisPoints as number,
    effectiveFrom: p.effectiveFrom as Date,
    ...(p.label ? { label: p.label } : {}),
  };
}

/** The fee-schedule independence rule, applied to a filed change: its submitter is its maker. */
function independenceFailure(
  actorUserId: string,
  change: Pick<TaxRuleChange, 'submittedByUserId'>,
) {
  return approvalIndependenceFailure(actorUserId, {
    createdByUserId: change.submittedByUserId,
    updatedByUserId: null,
    submittedByUserId: change.submittedByUserId,
    contributorUserIds: [],
  });
}

function notPending() {
  return new AppException(
    ErrorCodes.CONFLICT,
    'This change is not waiting for approval (it was already approved, rejected or withdrawn).',
    HttpStatus.CONFLICT,
    { reason: 'NOT_PENDING' },
  );
}

function independenceError(reject: boolean) {
  return new AppException(
    ErrorCodes.FORBIDDEN,
    reject
      ? 'You filed this change, so you cannot reject it. Withdraw it instead.'
      : 'You filed this change, so you cannot approve it. Another administrator who holds the approval duty must approve it.',
    HttpStatus.FORBIDDEN,
    { reason: 'NOT_INDEPENDENT' },
  );
}

function stale(reason: 'RULE_MOVED' | 'CHANGED_SINCE_SUBMISSION') {
  return new AppException(
    ErrorCodes.CONFLICT,
    'This tax rule changed after the change was filed, so nothing was applied. Reject this change and file it again.',
    HttpStatus.CONFLICT,
    { reason },
  );
}

export interface TaxRuleInput {
  label: string;
  rateBasisPoints: number;
  appliesTo: TaxBase | string;
  taxGroup?: string;
  country?: string;
  region?: string;
  currency?: string;
  category?: string;
  minUnitMinor?: number | null;
  maxUnitMinor?: number | null;
  inclusive?: boolean;
  split?: string;
  priority?: number;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  active?: boolean;
}

export type TaxRulePatch = Partial<TaxRuleInput>;
