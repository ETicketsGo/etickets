import { Injectable } from '@nestjs/common';
import type { TaxBase } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';

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
        active: input.active ?? false,
      },
    });

    await this.audit.record({
      actorUserId,
      action: 'TAX_RULE_CREATED',
      entityType: 'TaxRule',
      entityId: created.id,
      metadata: { label: created.label, rateBasisPoints: created.rateBasisPoints },
    });
    return created;
  }

  /**
   * Change a rule that has never charged anybody, or switch one on and off.
   *
   * The rate and what it is levied on are editable only while the rule is a draft. Once it
   * has been active, those become the province of `supersede`.
   */
  async update(actorUserId: string, id: string, patch: TaxRulePatch) {
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

    const next = {
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
      effectiveFrom:
        patch.effectiveFrom === undefined ? existing.effectiveFrom : patch.effectiveFrom,
      effectiveTo: patch.effectiveTo === undefined ? existing.effectiveTo : patch.effectiveTo,
      active: patch.active ?? existing.active,
    };
    this.assertBandShape(next);

    const updated = await this.prisma.taxRule.update({ where: { id }, data: next });
    await this.audit.record({
      actorUserId,
      action: patch.active === undefined ? 'TAX_RULE_UPDATED' : 'TAX_RULE_TOGGLED',
      entityType: 'TaxRule',
      entityId: id,
      metadata: {
        before: { rateBasisPoints: existing.rateBasisPoints, active: existing.active },
        after: { rateBasisPoints: updated.rateBasisPoints, active: updated.active },
      },
    });
    return updated;
  }

  /**
   * Close one rule and open its successor, at the same instant.
   *
   * The two writes are one transaction because the alternative states are both wrong: an
   * old rule closed with no successor charges nothing, and a successor opened before the old
   * one closes charges twice. Neither is a state anybody should be able to observe.
   */
  async supersede(
    actorUserId: string,
    id: string,
    input: { rateBasisPoints: number; effectiveFrom: Date; label?: string },
  ) {
    const existing = await this.prisma.taxRule.findUnique({ where: { id } });
    if (!existing) throw new AppException(ErrorCodes.NOT_FOUND, 'Tax rule not found.');
    if (existing.effectiveTo && existing.effectiveTo <= input.effectiveFrom) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'That rule already ended before the date you gave, so there is nothing to supersede.',
      );
    }

    const [closed, successor] = await this.prisma.$transaction([
      this.prisma.taxRule.update({
        where: { id },
        // Exclusive upper bound against the successor's inclusive lower bound: at the
        // changeover instant exactly one rule applies.
        data: { effectiveTo: input.effectiveFrom },
      }),
      this.prisma.taxRule.create({
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
      }),
    ]);

    await this.audit.record({
      actorUserId,
      action: 'TAX_RULE_SUPERSEDED',
      entityType: 'TaxRule',
      entityId: id,
      metadata: {
        from: existing.rateBasisPoints,
        to: input.rateBasisPoints,
        at: input.effectiveFrom.toISOString(),
        successorId: successor.id,
      },
    });
    return { closed, successor };
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
