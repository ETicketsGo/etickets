import { HttpStatus, Injectable } from '@nestjs/common';
import {
  BillingUnit,
  CostSource,
  countSmsSegments,
  costMicrosFor,
  normaliseMarket,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AppException, ErrorCodes } from '../../common/errors';

export interface RateQuery {
  provider: string;
  channel: string;
  /** ISO-3166 alpha-2 or a display name; `null` matches only wildcard rates. */
  country?: string | null;
  /** WhatsApp utility/authentication/marketing, where a provider prices by class. */
  category?: string | null;
  at: Date;
}

export interface ResolvedRate {
  id: string;
  unitPriceMicro: number;
  currency: string;
  billingUnit: BillingUnit;
}

export interface CostEstimate {
  costMicro: number | null;
  costCurrency: string | null;
  costSource: CostSource;
  billedUnits: number | null;
  rateId?: string;
}

/**
 * What a message cost, from a rate that was in force when it was sent.
 *
 * ── WHY THE RATE IS LOOKED UP BY DATE ──────────────────────────────────────────────
 * A price compiled into the application is a deploy every time a vendor renegotiates. Worse,
 * it silently reprices HISTORY: last month's cost report, recomputed today, would come back
 * a different number, and nobody could say which one was right. Looking the rate up as of
 * the moment of the send is what makes a report about March still true in December.
 *
 * ── WHY UNKNOWN IS NOT ZERO ────────────────────────────────────────────────────────
 * The single most important line in this file is the one that returns `UNKNOWN` rather than
 * `0` when no rate matches. "We have no rate for MSG91 WhatsApp in India" and "MSG91
 * WhatsApp in India is free" produce the same total and mean opposite things — the first says
 * the number on the screen is missing a component, the second says it is complete. Every
 * report built on this carries an unknown COUNT beside its total so a reader can tell whether
 * they are looking at the answer or at a floor.
 */
@Injectable()
export class NotificationRateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The rate in force for this send, most specific first.
   *
   * Specificity is ordered rather than computed: a rate naming both the country and the
   * message category beats one naming only the country, which beats a wildcard. Ties break on
   * `priority`, then on the most recent `effectiveFrom` — so correcting a rate is a new row
   * with a later start date, never an edit to the one that priced yesterday's messages.
   */
  async resolve(q: RateQuery): Promise<ResolvedRate | null> {
    const country = normaliseMarket(q.country) ?? '*';
    const category = q.category ?? '*';

    const candidates = await this.prisma.notificationRate.findMany({
      where: {
        active: true,
        provider: q.provider,
        channel: q.channel,
        country: { in: country === '*' ? ['*'] : [country, '*'] },
        category: { in: category === '*' ? ['*'] : [category, '*'] },
        effectiveFrom: { lte: q.at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: q.at } }],
      },
      orderBy: [{ priority: 'desc' }, { effectiveFrom: 'desc' }],
    });
    if (candidates.length === 0) return null;

    const score = (r: { country: string; category: string }) =>
      (r.country === '*' ? 0 : 2) + (r.category === '*' ? 0 : 1);
    const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));

    return {
      id: best.id,
      unitPriceMicro: best.unitPriceMicro,
      currency: best.currency,
      billingUnit: best.billingUnit as BillingUnit,
    };
  }

  /**
   * Price one attempt.
   *
   * `body` is passed for SMS only, and only so segments can be counted — one logical SMS is
   * not one billed SMS. A 200-character message is two segments; the same message with a
   * rupee sign in it is Unicode, drops to 70 characters per segment, and is three. Assuming
   * one message is one charge is out by a factor of three on exactly the messages an Indian
   * transactional template produces.
   */
  /**
   * Whether ANY active rate exists for a provider and channel.
   *
   * Distinct from `resolve`, which answers "what does this specific message cost" and needs a
   * market and a category. A readiness report is asking a coarser question -- can this channel
   * be costed at all -- and answering it with a full resolution would report "no rate" for a
   * provider that is priced everywhere except the one market being asked about.
   */
  async hasActiveRate(provider: string, channel: string): Promise<boolean> {
    const now = new Date();
    const found = await this.prisma.notificationRate.findFirst({
      where: {
        active: true,
        provider,
        channel,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { id: true },
    });
    return Boolean(found);
  }

  async estimate(q: RateQuery & { body?: string }): Promise<CostEstimate> {
    const rate = await this.resolve(q);
    if (!rate) {
      return {
        costMicro: null,
        costCurrency: null,
        costSource: CostSource.UNKNOWN,
        billedUnits: null,
      };
    }

    const quantity = this.quantityFor(rate.billingUnit, q.channel, q.body);
    const costMicro = costMicrosFor(rate.unitPriceMicro, rate.billingUnit, quantity);

    return {
      costMicro,
      costCurrency: rate.currency,
      /*
        A configured zero is a FACT -- push through Expo genuinely costs nothing -- and it is
        recorded as one, distinct from the absence of a rate. Both leave a total unchanged;
        only one of them means the total is complete.
      */
      costSource: rate.unitPriceMicro === 0 ? CostSource.CONFIGURED_FREE : CostSource.RATE_CARD,
      billedUnits: quantity,
      rateId: rate.id,
    };
  }

  /** How many billing units this message is, given how the provider counts. */
  private quantityFor(unit: BillingUnit, channel: string, body?: string): number {
    if (unit === BillingUnit.PER_SEGMENT) {
      /*
        Without the body there is nothing to count, and guessing "1" would understate every
        long or Unicode message. One segment is the floor, and `billedUnits` records what was
        actually counted so a reconciliation can see where an estimate came from.
      */
      if (!body) return 1;
      return countSmsSegments(body).segments;
    }
    // Everything else is one of whatever the provider counts: a message, a request, a
    // conversation, an email against a per-thousand price.
    void channel;
    return 1;
  }

  /**
   * Write a rate.
   *
   * ── WHY OVERLAP IS REFUSED ─────────────────────────────────────────────────────────
   * Two active rates covering the same provider, channel, country, category and instant make
   * the cost of a message depend on which row the database happened to return. That is not a
   * wrong number, it is an unstable one: the same report run twice gives two answers, and
   * nobody can tell which is right. Refusing at write time is the only point where it is
   * cheap to fix.
   */
  async create(input: {
    provider: string;
    channel: string;
    country?: string;
    category?: string;
    unitPriceMicro: number;
    currency: string;
    billingUnit: BillingUnit;
    effectiveFrom: Date;
    effectiveTo?: Date | null;
    priority?: number;
    active?: boolean;
    source?: string | null;
    notes?: string | null;
  }) {
    const country = input.country ?? '*';
    const category = input.category ?? '*';

    if (input.unitPriceMicro < 0) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A rate cannot be negative. A credit is a reconciliation, not a price.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A rate must end after it starts.',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (input.active !== false) {
      const clash = await this.prisma.notificationRate.findFirst({
        where: {
          active: true,
          provider: input.provider,
          channel: input.channel,
          country,
          category,
          // Two periods overlap unless one ends before the other starts.
          effectiveFrom: input.effectiveTo ? { lt: input.effectiveTo } : undefined,
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.effectiveFrom } }],
        },
      });
      if (clash) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          `An active rate already covers ${input.provider}/${input.channel}/${country}/${category} ` +
            `for that period. End the existing one first — a superseded rate gets an end date, ` +
            `never a delete, so past reports stay reproducible.`,
          HttpStatus.CONFLICT,
          { conflictsWith: clash.id },
        );
      }
    }

    return this.prisma.notificationRate.create({
      data: {
        provider: input.provider,
        channel: input.channel,
        country,
        category,
        unitPriceMicro: input.unitPriceMicro,
        currency: input.currency.toUpperCase(),
        billingUnit: input.billingUnit,
        priority: input.priority ?? 100,
        active: input.active ?? false,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        source: input.source ?? null,
        notes: input.notes ?? null,
      },
    });
  }

  /** End a rate rather than deleting it, so the period it priced stays reproducible. */
  async supersede(id: string, at: Date) {
    const res = await this.prisma.notificationRate.updateMany({
      where: { id, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
      data: { effectiveTo: at },
    });
    return { superseded: res.count === 1 };
  }

  async list(opts: { provider?: string; channel?: string; activeOnly?: boolean } = {}) {
    return this.prisma.notificationRate.findMany({
      where: {
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.channel ? { channel: opts.channel } : {}),
        ...(opts.activeOnly ? { active: true } : {}),
      },
      orderBy: [{ provider: 'asc' }, { channel: 'asc' }, { effectiveFrom: 'desc' }],
    });
  }
}
