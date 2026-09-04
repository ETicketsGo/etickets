import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import {
  resolvePolicy,
  specificity,
  type PolicyRow,
} from '../pricing/cinema-policy/cinema-pricing-policy.resolver';

/**
 * Managing cinema pricing policies from the back office.
 *
 * ── THE RULE THAT SHAPES EVERY METHOD HERE ─────────────────────────────────────────
 * An ACTIVE policy that real bookings were priced under is never edited. It is SUPERSEDED
 * by a new version, and the old row stays exactly as it was.
 *
 * Editing one in place would rewrite the financial interpretation of every order already
 * sold under it — including invoices in customers' hands. Bookings do carry their own
 * snapshot, so the damage would be limited to reports and audits rather than to totals, but
 * "the audit trail now disagrees with the invoice" is not a smaller problem, it is a worse
 * kind of one.
 *
 * DRAFT rows are freely editable, because nothing has ever been priced by them.
 */
export interface PolicyInput {
  country: string;
  region: string;
  district: string;
  city: string;
  currency: string;
  localBodyType?: PolicyRow['localBodyType'];
  cinemaFormat?: PolicyRow['cinemaFormat'];
  climateType?: PolicyRow['climateType'];
  seatCategory?: string | null;
  maintenanceChargeMinor: number;
  maintenanceTreatment: PolicyRow['maintenanceTreatment'];
  maintenanceTaxCategory?: string | null;
  onlineFeePolicy: PolicyRow['onlineFeePolicy'];
  onlineFeeCapMinor?: number | null;
  ticketPriceMinMinor?: number | null;
  ticketPriceMaxMinor?: number | null;
  ticketPriceRule?: string | null;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  regulatoryReference: string;
  regulatoryDocumentUrl?: string | null;
  notes?: string | null;
}

@Injectable()
export class CinemaPricingPoliciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Newest first, all statuses — an admin needs to see history, not only what is live. */
  async list() {
    return this.prisma.cinemaPricingPolicy.findMany({
      orderBy: [{ country: 'asc' }, { region: 'asc' }, { effectiveFrom: 'desc' }],
    });
  }

  /** Always DRAFT. A policy that arrives ACTIVE prices orders nobody decided to price. */
  async create(actorUserId: string, input: PolicyInput) {
    const row = await this.prisma.cinemaPricingPolicy.create({
      data: { ...input, status: 'DRAFT', version: 1 },
    });
    await this.audit.record({
      actorUserId,
      action: 'CINEMA_PRICING_POLICY_CREATED',
      entityType: 'CinemaPricingPolicy',
      entityId: row.id,
      metadata: { regulatoryReference: row.regulatoryReference, status: 'DRAFT' },
    });
    return row;
  }

  /** Drafts only. See the note at the top of this file. */
  async updateDraft(actorUserId: string, id: string, patch: Partial<PolicyInput>) {
    const existing = await this.mustFind(id);
    if (existing.status !== 'DRAFT') {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `Only a DRAFT policy can be edited. This one is ${existing.status} — supersede it with a new version instead, so what was already priced under it stays readable.`,
        HttpStatus.CONFLICT,
      );
    }
    const row = await this.prisma.cinemaPricingPolicy.update({ where: { id }, data: patch });
    await this.audit.record({
      actorUserId,
      action: 'CINEMA_PRICING_POLICY_DRAFT_UPDATED',
      entityType: 'CinemaPricingPolicy',
      entityId: id,
      metadata: { fields: Object.keys(patch) },
    });
    return row;
  }

  /**
   * Everything that must be true before a policy may price real money, checked in one place.
   *
   * ── WHY A LIST AND NOT A SEQUENCE OF THROWS ────────────────────────────────────────
   * Activation is the moment a jurisdiction starts being enforced. Refusing one reason at a
   * time turns preparing a launch into a guessing game — fix, retry, discover the next
   * blocker, repeat. Every reason is gathered so an admin sees the whole list at once, and so
   * the same list can be shown BEFORE the button is pressed rather than only after.
   */
  async activationPreflight(id: string): Promise<{
    ok: boolean;
    blockers: { code: string; message: string }[];
    warnings: { code: string; message: string }[];
  }> {
    const p = await this.mustFind(id);
    const blockers: { code: string; message: string }[] = [];
    const warnings: { code: string; message: string }[] = [];

    if (p.status !== 'DRAFT') {
      blockers.push({
        code: 'NOT_DRAFT',
        message: `Only a DRAFT policy can be activated. This one is ${p.status}.`,
      });
    }

    if (!p.regulatoryReference?.trim()) {
      blockers.push({
        code: 'NO_REFERENCE',
        message:
          'No regulatory reference. A policy that prices money must name the order it comes from, or nobody can check it later.',
      });
    }

    /*
      An unresolved treatment is not a pricing instruction. Knowing the amount is not knowing
      what to do with it: ₹5 UNCONFIRMED either sits inside the ticket price or on top of it,
      and the two differ by ₹5 a ticket in the customer's favour or the state's.

      The database refuses this too. Repeated here because a constraint violation reaches the
      admin as a Postgres error naming a constraint — technically a refusal, and useless to
      the person who has to act on it.
    */
    if (p.maintenanceTreatment === 'UNCONFIRMED') {
      blockers.push({
        code: 'MAINTENANCE_UNCONFIRMED',
        message: `This policy records a maintenance charge of ${p.maintenanceChargeMinor / 100} but not whether it is included in the ticket price or added to it. Resolve the treatment against ${p.regulatoryReference} before activating.`,
      });
    }
    if (p.maintenanceChargeMinor > 0 && p.maintenanceTreatment === 'NOT_APPLICABLE') {
      blockers.push({
        code: 'MAINTENANCE_CONTRADICTS_ITSELF',
        message:
          'The policy carries a maintenance amount and says maintenance does not apply. One of the two is wrong.',
      });
    }

    // A cap of "null" on a CAPPED policy is not a cap. It reads as unlimited to anything that
    // trusts the field, which is the failure mode this whole subsystem exists to prevent.
    if (p.onlineFeePolicy === 'CAPPED' && p.onlineFeeCapMinor == null) {
      blockers.push({
        code: 'CAP_MISSING',
        message:
          'The online fee is CAPPED but no maximum is recorded. Record the amount, or choose a policy that does not need one.',
      });
    }

    // A rate row — one written for a specific seat class — exists to state a maximum. Without
    // one it silently becomes a row that permits any price for that class.
    if (p.seatCategory && p.ticketPriceMaxMinor == null) {
      blockers.push({
        code: 'NO_CEILING',
        message: `This policy is written for seat class ${p.seatCategory} but records no maximum ticket price, so it would permit any price for that class.`,
      });
    }

    const clash = await this.findAmbiguity(p as unknown as PolicyRow);
    if (clash) {
      blockers.push({
        code: 'AMBIGUOUS',
        message: `Activating this would make pricing ambiguous: "${clash.regulatoryReference}" is already active with the same scope and specificity. Supersede or narrow one of them first.`,
      });
    }

    /*
      Has anybody actually read the order these numbers came from?

      `textReviewed` is false when values were transcribed from a summary rather than the
      order text. That is a perfectly reasonable state for QA — it is how the Andhra Pradesh
      table exists today — and an unacceptable one for production, where the platform would be
      enforcing prices nobody has checked against the source.

      Deliberately a hard block in production with NO override parameter. An override that
      exists only here would be an informal bypass invented for the convenience of the person
      being blocked, which is the opposite of an audit trail.
    */
    const doc = p.regulatoryDocumentId
      ? await this.prisma.regulatoryDocument.findUnique({ where: { id: p.regulatoryDocumentId } })
      : await this.prisma.regulatoryDocument.findUnique({
          where: { reference: p.regulatoryReference },
        });
    const appEnv = (process.env.APP_ENV ?? '').toLowerCase();
    const isProduction = appEnv === 'production' || appEnv === 'prod';
    if (!doc?.textReviewed) {
      const message = doc
        ? `The order "${doc.reference}" has not been reviewed against its source text (textReviewed is false), so these rates are transcribed rather than verified.`
        : `No regulatory document is recorded for "${p.regulatoryReference}", so there is nothing recording whether these rates were checked against the order.`;
      if (isProduction) {
        blockers.push({
          code: 'TEXT_NOT_REVIEWED',
          message: `${message} Production activation is refused until it is.`,
        });
      } else {
        warnings.push({ code: 'TEXT_NOT_REVIEWED', message });
      }
    }

    return { ok: blockers.length === 0, blockers, warnings };
  }

  async activate(actorUserId: string, id: string) {
    const preflight = await this.activationPreflight(id);
    if (!preflight.ok) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        preflight.blockers.map((b) => b.message).join(' '),
        HttpStatus.CONFLICT,
      );
    }

    const row = await this.prisma.cinemaPricingPolicy.update({
      where: { id },
      data: { status: 'ACTIVE' },
    });
    await this.audit.record({
      actorUserId,
      action: 'CINEMA_PRICING_POLICY_ACTIVATED',
      entityType: 'CinemaPricingPolicy',
      entityId: id,
      metadata: {
        regulatoryReference: row.regulatoryReference,
        effectiveFrom: row.effectiveFrom.toISOString(),
        // What was known and accepted at the moment of activation. An unreviewed order is a
        // warning outside production; recording it means the decision is auditable rather
        // than merely permitted.
        acceptedWarnings: preflight.warnings.map((w) => w.code),
        // Worth recording loudly: this can be the moment a whole country starts failing
        // closed for unclassified cinemas.
        note: 'Cinemas in this scope now resolve against it; unclassified ones fail closed.',
      },
    });
    return row;
  }

  /**
   * Replace an ACTIVE policy with a new version, preserving the old one.
   *
   * The old row becomes SUPERSEDED and keeps every value it had. The new row carries
   * `version + 1` and a link back, so a lineage can be walked from any booking's snapshot.
   */
  async supersede(actorUserId: string, id: string, input: PolicyInput) {
    const old = await this.mustFind(id);
    if (old.status !== 'ACTIVE') {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `Only an ACTIVE policy can be superseded. This one is ${old.status}.`,
        HttpStatus.CONFLICT,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      /*
        Both writes or neither. A superseded old row with no replacement leaves the scope
        uncovered, and every cinema in it fails closed until somebody notices — which is
        safe, but is an outage nobody chose.
      */
      await tx.cinemaPricingPolicy.update({
        where: { id },
        data: { status: 'SUPERSEDED', effectiveTo: input.effectiveFrom },
      });
      const row = await tx.cinemaPricingPolicy.create({
        data: { ...input, status: 'ACTIVE', version: old.version + 1, supersedesId: old.id },
      });
      await this.audit.record({
        actorUserId,
        action: 'CINEMA_PRICING_POLICY_SUPERSEDED',
        entityType: 'CinemaPricingPolicy',
        entityId: old.id,
        metadata: {
          replacedBy: row.id,
          fromVersion: old.version,
          toVersion: row.version,
          regulatoryReference: row.regulatoryReference,
        },
      });
      return row;
    });
  }

  /** Withdraw a policy without replacing it. The scope then fails closed, deliberately. */
  async disable(actorUserId: string, id: string) {
    const existing = await this.mustFind(id);
    const row = await this.prisma.cinemaPricingPolicy.update({
      where: { id },
      data: { status: 'DISABLED' },
    });
    await this.audit.record({
      actorUserId,
      action: 'CINEMA_PRICING_POLICY_DISABLED',
      entityType: 'CinemaPricingPolicy',
      entityId: id,
      metadata: {
        previousStatus: existing.status,
        note: 'Cinemas in this scope now resolve nothing and will refuse online sales.',
      },
    });
    return row;
  }

  /**
   * What would apply to a given cinema right now, and why.
   *
   * The screen an admin opens when an organizer says "why can't I publish?". It answers with
   * the resolver's own explanation rather than a second implementation of the same logic.
   */
  async inspect(query: {
    country: string;
    region?: string | null;
    district?: string | null;
    city?: string | null;
    currency?: string | null;
    localBodyType?: PolicyRow['localBodyType'];
    cinemaFormat?: PolicyRow['cinemaFormat'];
    climateType?: PolicyRow['climateType'];
    seatCategory?: string | null;
    at?: Date;
  }) {
    const active = (await this.prisma.cinemaPricingPolicy.findMany({
      where: { status: 'ACTIVE' },
    })) as unknown as PolicyRow[];
    const resolution = resolvePolicy(active, {
      country: query.country,
      region: query.region ?? null,
      district: query.district ?? null,
      city: query.city ?? null,
      currency: query.currency ?? 'INR',
      localBodyType: query.localBodyType ?? null,
      cinemaFormat: query.cinemaFormat ?? null,
      climateType: query.climateType ?? null,
      seatCategories: query.seatCategory ? [query.seatCategory] : [],
      at: query.at ?? new Date(),
    });
    return {
      status: resolution.status,
      explanation: resolution.explanation,
      policy: resolution.policy,
    };
  }

  private async mustFind(id: string) {
    const row = await this.prisma.cinemaPricingPolicy.findUnique({ where: { id } });
    if (!row) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Policy not found.', HttpStatus.NOT_FOUND);
    }
    return row;
  }

  /**
   * An ACTIVE policy with the identical scope AND the same specificity as the candidate.
   *
   * Same specificity is the test, not same fields: two rules that are equally specific are
   * exactly the pair the resolver cannot choose between. A narrower or broader neighbour is
   * fine — precedence handles it.
   */
  private async findAmbiguity(candidate: PolicyRow) {
    const actives = (await this.prisma.cinemaPricingPolicy.findMany({
      where: {
        status: 'ACTIVE',
        country: candidate.country,
        region: candidate.region,
        district: candidate.district,
        city: candidate.city,
        localBodyType: candidate.localBodyType,
        cinemaFormat: candidate.cinemaFormat,
        climateType: candidate.climateType,
        seatCategory: candidate.seatCategory,
      },
    })) as unknown as PolicyRow[];

    const want = specificity(candidate);
    return (
      actives.find(
        (a) =>
          specificity(a) === want &&
          // Overlapping in TIME as well as in scope. Two policies for one state that never
          // coexist are a schedule, not a clash.
          (!a.effectiveTo || a.effectiveTo > candidate.effectiveFrom) &&
          (!candidate.effectiveTo || candidate.effectiveTo > a.effectiveFrom),
      ) ?? null
    );
  }
}
