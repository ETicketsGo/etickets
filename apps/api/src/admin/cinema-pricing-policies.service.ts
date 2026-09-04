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
   * DRAFT → ACTIVE, refusing if it would create an ambiguity.
   *
   * The database cannot express "no two ACTIVE policies may overlap in scope" as a
   * constraint: the scopes are wildcards and date ranges, not values a unique index can
   * compare. So it is checked here, at the one moment a policy starts pricing anything —
   * and the resolver refuses at read time as well, because a row can reach ACTIVE by other
   * means and the money must be safe either way.
   */
  async activate(actorUserId: string, id: string) {
    const candidate = await this.mustFind(id);
    if (candidate.status !== 'DRAFT') {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `Only a DRAFT policy can be activated. This one is ${candidate.status}.`,
        HttpStatus.CONFLICT,
      );
    }

    /*
      An unresolved treatment is not a pricing instruction. Knowing the amount is not knowing
      what to do with it: ₹5 UNCONFIRMED either sits inside the ticket price or on top of it,
      and the two differ by ₹5 a ticket in the customer's favour or the state's.

      The database refuses this too. Checked here as well because a constraint violation
      reaches the admin as a Postgres error naming a constraint — technically a refusal, and
      useless to the person who has to fix it.
    */
    if (candidate.maintenanceTreatment === 'UNCONFIRMED') {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `This policy records a maintenance charge of ${candidate.maintenanceChargeMinor / 100} but not whether it is included in the ticket price or added to it. Resolve the treatment against ${candidate.regulatoryReference} before activating.`,
        HttpStatus.CONFLICT,
      );
    }

    const clash = await this.findAmbiguity(candidate as unknown as PolicyRow);
    if (clash) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `Activating this would make pricing ambiguous: "${clash.regulatoryReference}" is already active with the same scope and specificity. Supersede or narrow one of them first.`,
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
