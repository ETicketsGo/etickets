import { HttpStatus, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { BookingStatus, routeProviderForBooking } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import {
  BUYER_SALE_NOT_OPEN,
  SALE_NOT_OPEN_REASON,
} from '../pricing/cinema-policy/sale-eligibility';
import {
  PILOT_ENV,
  PILOT_WEBHOOK_WINDOW_MS,
  kolkataDay,
  parsePilotConfig,
  pilotSaleBlockers,
  type PilotBlocker,
  type PilotConfig,
  type PilotEnv,
  type PilotSale,
} from './pilot-config';

/**
 * One fixed key for `pg_advisory_xact_lock`. Every pilot booking create takes it inside its own
 * transaction, so "count today's sales, then add this one" runs one buyer at a time and two
 * buyers cannot each see room for themselves and jointly pass the cap. Arbitrary, but must not
 * change while two versions of the API run side by side.
 */
export const PILOT_DAILY_LOCK_KEY = 730_104_4211;

/** The audit action an automatic pause writes. Admin > Operations reads the newest one. */
export const PILOT_AUTO_PAUSE_ACTION = 'EVENT_AUTO_PAUSED';

/**
 * Statuses that hold money we took today. A partial refund still counts in full: the cap is
 * about exposure on the day, and counting more is the safe side.
 */
const COUNTED_PAID: BookingStatus[] = [
  BookingStatus.CONFIRMED,
  BookingStatus.PARTIALLY_REFUNDED,
  BookingStatus.DISPUTED,
];

type Db = Pick<Prisma.TransactionClient, 'booking'>;

export interface PilotStatus {
  mode: 'on' | 'off';
  /** False when pilot mode is on but a variable could not be read: nothing is sellable. */
  valid: boolean;
  problems: string[];
  limits: {
    organizationIds: string[];
    currencies: string[];
    providers: string[];
    gaOnly: boolean;
    maxOrderMinor: number;
    maxDailySalesMinor: number;
    /** How many buyer addresses are allowed. Never the addresses: they are personal data. */
    buyerAllowlistCount: number;
    autoPause: boolean;
    webhookRejectThreshold: number;
    webhookWindowMinutes: number;
  } | null;
  today: { day: string; sales: { currency: string; countedMinor: number; capMinor: number }[] };
  lastAutoPause: {
    at: string;
    eventId: string | null;
    organizationId: string | null;
    trigger: string | null;
  } | null;
}

/**
 * The pilot's sale limits, asked by quote, booking create and payment start.
 *
 * Off (PILOT_MODE unset or `off`) every method is a no-op and the sale path is the one the
 * platform had before. See `pilot-config.ts` for the rules and why misconfiguration closes
 * sales, and docs/go-live/PILOT-GUARD.md for the variables.
 *
 * Refusals use the shape the cinema-policy refusal already uses - 409, the buyer's "not open"
 * sentence, `reason: SALE_NOT_OPEN` - so the storefront needs no new branch to word it, plus the
 * pilot code in `blockers` for whoever reads the response or the log.
 */
@Injectable()
export class PilotGuardService implements OnModuleInit {
  private readonly logger = new Logger('PilotGuard');
  private readonly cfg: PilotConfig;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {
    // Read once: a limit that changed between a quote and the create would make them disagree.
    const env: PilotEnv = {};
    for (const name of PILOT_ENV) env[name] = this.read(name);
    this.cfg = parsePilotConfig(env);
  }

  onModuleInit(): void {
    if (this.cfg.mode === 'off') return;
    if (this.cfg.valid) {
      const l = this.cfg.limits;
      this.logger.warn(
        `Pilot mode is ON: ${l.organizationIds.length} organizer(s), ${l.currencies.join('/')} via ` +
          `${l.providers.join('/')}, order cap ${l.maxOrderMinor}, daily cap ${l.maxDailySalesMinor}` +
          `, auto-pause ${l.autoPause ? 'on' : 'off'}.`,
      );
    } else {
      this.logger.error(
        `Pilot mode is ON but misconfigured, so nothing can be sold: ${this.cfg.problems.join(' ')}`,
      );
    }
  }

  get pilotConfig(): PilotConfig {
    return this.cfg;
  }

  active(): boolean {
    return this.cfg.mode === 'on';
  }

  /**
   * Whether this organization is in the pilot. Misconfigured pilot mode answers from whatever
   * list it could read, so auto-pause can still act on the organizer it names.
   */
  isPilotOrganization(organizationId: string): boolean {
    if (this.cfg.mode === 'off') return false;
    const ids = this.cfg.valid ? this.cfg.limits.organizationIds : this.cfg.organizationIds;
    return ids.includes(organizationId);
  }

  /**
   * The gateway the payment start WOULD use for this currency, by the same rule it applies:
   * Razorpay's order flow when the currency routes there and a key is configured, otherwise
   * the routed provider, or the configured one for a currency the orchestrator settles.
   *
   * Asked before any money moves, so a quote, a create and a payment start all agree. In
   * pilot mode the only path PILOT_ALLOWED_PROVIDERS=razorpay accepts is Razorpay's own.
   */
  predictProvider(currency: string): string {
    const routed = routeProviderForBooking({ currency });
    if (routed === 'razorpay') {
      return this.read('RAZORPAY_KEY_ID')
        ? 'razorpay'
        : (this.read('PAYMENT_PROVIDER_NAME') ?? 'mock');
    }
    return routed ?? 'none';
  }

  /** Throws the SALE_NOT_OPEN refusal for these codes. */
  refuse(blockers: PilotBlocker[]): never {
    this.logger.warn(`Pilot refused a sale: ${blockers.join(', ')}`);
    throw new AppException(ErrorCodes.VALIDATION_FAILED, BUYER_SALE_NOT_OPEN, HttpStatus.CONFLICT, {
      reason: SALE_NOT_OPEN_REASON,
      blockers,
    });
  }

  /**
   * Everything a quote can know, the daily cap included (read, not locked: a quote takes no
   * stock). Booking create calls `assertSale` and then `reserveDailyCapacity` in its
   * transaction, which reach the same answer for the same cart on the same day.
   */
  async blockersFor(sale: PilotSale, now = new Date()): Promise<PilotBlocker[]> {
    if (this.cfg.mode === 'off') return [];
    const out = pilotSaleBlockers(this.cfg, sale);
    if (out.length === 0 && this.cfg.valid && sale.totalMinor > 0) {
      const counted = await this.countedToday(this.prisma, sale.currency, now);
      if (counted + sale.totalMinor > this.cfg.limits.maxDailySalesMinor) {
        out.push('PILOT_DAILY_LIMIT');
      }
    }
    return out;
  }

  /** The non-database rules; throws when any applies. */
  assertSale(sale: PilotSale, phase: 'all' | 'beforePrice' = 'all'): void {
    const out = pilotSaleBlockers(this.cfg, sale, phase);
    if (out.length > 0) this.refuse(out);
  }

  /**
   * Payment start, the last step before a gateway order exists. The same rules once more,
   * because a hold can outlive a change: the event may have been paused (by an admin or by the
   * auto-pause) after the booking was made, or the hold made before pilot mode was switched on.
   * The daily cap is not re-counted: this booking is already one of the holds it counts.
   */
  assertPaymentStart(input: {
    organizationId: string;
    eventStatus: string;
    seatBased: boolean;
    cinema: boolean;
    currency: string;
    totalMinor: number;
    paymentMethod: 'ONLINE' | 'CASH';
    buyerEmails: (string | null | undefined)[];
  }): void {
    if (this.cfg.mode === 'off') return;
    const out = pilotSaleBlockers(this.cfg, {
      organizationId: input.organizationId,
      reservedSeating: input.seatBased,
      cinema: input.cinema,
      currency: input.currency,
      provider: input.totalMinor > 0 ? this.predictProvider(input.currency) : null,
      paymentMethod: input.paymentMethod,
      totalMinor: input.totalMinor,
      buyerEmails: input.buyerEmails,
    });
    // SOLD_OUT is still on sale for a buyer already holding stock.
    const onSale = input.eventStatus === 'PUBLISHED' || input.eventStatus === 'SOLD_OUT';
    if (!onSale && !out.includes('PILOT_MISCONFIGURED')) {
      out.push('PILOT_EVENT_NOT_ON_SALE');
    }
    if (out.length > 0) this.refuse(out);
  }

  /**
   * Inside the booking transaction, before the booking row is written: take the pilot lock,
   * count today's sales, refuse if this order would pass the cap.
   *
   * The lock is transaction-scoped, so it is released by the commit that makes this booking
   * visible to the next buyer's count, or by the rollback that means it never existed.
   */
  async reserveDailyCapacity(
    tx: Prisma.TransactionClient,
    sale: { currency: string; totalMinor: number },
    now = new Date(),
  ): Promise<void> {
    if (this.cfg.mode === 'off' || !this.cfg.valid || sale.totalMinor <= 0) return;
    // `SELECT 1 FROM (...)`: the lock function returns void, which Prisma cannot deserialize.
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(${PILOT_DAILY_LOCK_KEY}::bigint)) AS l`;
    const counted = await this.countedToday(tx, sale.currency, now);
    if (counted + sale.totalMinor > this.cfg.limits.maxDailySalesMinor) {
      this.refuse(['PILOT_DAILY_LIMIT']);
    }
  }

  /**
   * Today's (Asia/Kolkata) pilot sales in one currency: paid bookings created today plus
   * unpaid ones still holding stock. An expired hold stops counting the moment it expires,
   * before the sweep has marked it EXPIRED, so a buyer who walked away frees the room.
   */
  async countedToday(db: Db, currency: string, now = new Date()): Promise<number> {
    if (this.cfg.mode === 'off') return 0;
    const ids = this.cfg.valid ? this.cfg.limits.organizationIds : this.cfg.organizationIds;
    if (ids.length === 0) return 0;
    const { start, end } = kolkataDay(now);
    const agg = await db.booking.aggregate({
      _sum: { totalMinor: true },
      where: {
        organizationId: { in: ids },
        currency: currency.toUpperCase(),
        createdAt: { gte: start, lt: end },
        OR: [
          { status: { in: COUNTED_PAID } },
          { status: BookingStatus.PENDING_PAYMENT, holdExpiresAt: { gt: now } },
        ],
      },
    });
    return agg._sum.totalMinor ?? 0;
  }

  /** Read-only, for Admin > Operations. Never throws. */
  async status(now = new Date()): Promise<PilotStatus> {
    const day = kolkataDay(now).label;
    const off: PilotStatus = {
      mode: 'off',
      valid: true,
      problems: [],
      limits: null,
      today: { day, sales: [] },
      lastAutoPause: null,
    };
    try {
      const lastAutoPause = await this.lastAutoPause();
      if (this.cfg.mode === 'off') return { ...off, lastAutoPause };
      if (!this.cfg.valid) {
        return { ...off, mode: 'on', valid: false, problems: this.cfg.problems, lastAutoPause };
      }
      const l = this.cfg.limits;
      const sales = await Promise.all(
        l.currencies.map(async (currency) => ({
          currency,
          countedMinor: await this.countedToday(this.prisma, currency, now),
          capMinor: l.maxDailySalesMinor,
        })),
      );
      return {
        mode: 'on',
        valid: true,
        problems: [],
        limits: {
          organizationIds: l.organizationIds,
          currencies: l.currencies,
          providers: l.providers,
          gaOnly: l.gaOnly,
          maxOrderMinor: l.maxOrderMinor,
          maxDailySalesMinor: l.maxDailySalesMinor,
          buyerAllowlistCount: l.buyerEmails.length,
          autoPause: l.autoPause,
          webhookRejectThreshold: l.webhookRejectThreshold,
          webhookWindowMinutes: PILOT_WEBHOOK_WINDOW_MS / 60000,
        },
        today: { day, sales },
        lastAutoPause,
      };
    } catch (err) {
      this.logger.error(
        `Pilot status could not be read: ${err instanceof Error ? err.message : err}`,
      );
      return this.cfg.mode === 'off'
        ? off
        : {
            ...off,
            mode: 'on',
            valid: this.cfg.valid,
            problems: this.cfg.valid ? ['Pilot status could not be read.'] : this.cfg.problems,
          };
    }
  }

  private async lastAutoPause(): Promise<PilotStatus['lastAutoPause']> {
    const row = await this.prisma.auditLog.findFirst({
      where: { action: PILOT_AUTO_PAUSE_ACTION },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, entityId: true, organizationId: true, metadata: true },
    });
    if (!row) return null;
    const meta = (row.metadata ?? {}) as { trigger?: unknown };
    return {
      at: row.createdAt.toISOString(),
      eventId: row.entityId,
      organizationId: row.organizationId,
      trigger: typeof meta.trigger === 'string' ? meta.trigger : null,
    };
  }

  private read(name: string): string | undefined {
    // The process env only when no ConfigService was given (a hand-built service in a test).
    const v: unknown = this.config ? this.config.get<string>(name) : process.env[name];
    return typeof v === 'string' ? v : v === undefined || v === null ? undefined : String(v);
  }
}
