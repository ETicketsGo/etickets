import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/**
 * The commercial terms a settlement runs under, and who may change them.
 *
 * ── WHY THESE ARE NOT ENVIRONMENT VARIABLES ────────────────────────────────────────
 * The holding period and the minimum payout are terms, not deployment settings. They are
 * negotiated per organizer - a venue that sells out months ahead is not on the terms a
 * promoter with one show gets - and they change without a release. As env vars they were one
 * number for every organizer on the platform, changeable only by a deploy, with no record of
 * who changed it or when. Finance cannot work that way and neither can support.
 *
 * ── HOW A VALUE IS RESOLVED ────────────────────────────────────────────────────────
 * The organization's own row, then the platform row, then the environment default. Each
 * field resolves on its own: an override that changes only the hold does not pin the minimum
 * to whatever it happened to be the day somebody created the override.
 */
export interface EffectivePayoutSettings {
  /** Days after an event's last show before its revenue may be settled. */
  holdDays: number;
  /** Currency -> the smallest payout worth raising, in minor units. */
  minPayoutMinor: Record<string, number>;
  /** Whether the platform raises this organizer's settlements by itself. Off unless set. */
  autoGenerate: boolean;
  /** DAILY | WEEKLY | MONTHLY. */
  runFrequency: string;
  /** WEEKLY: ISO weekday 1-7. MONTHLY: day of month 1-28. */
  runAnchorDay: number;
  /** When this organization's run last happened. Read from its OWN row, never inherited. */
  lastRunAt: Date | null;
  /** Where each value came from, so an admin screen can say "inherited" rather than imply a choice. */
  source: { holdDays: SettingSource; minPayoutMinor: SettingSource; autoGenerate: SettingSource };
}

export type SettingSource = 'organization' | 'platform' | 'default';

/** What an admin may write. Null clears an override back to inherited. */
export interface PayoutSettingsInput {
  holdDays?: number | null;
  minPayoutMinor?: Record<string, number> | null;
  autoGenerate?: boolean | null;
  runFrequency?: string | null;
  runAnchorDay?: number | null;
}

/** How often a settlement run comes round. */
export const RUN_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;

/** The environment default, used until somebody configures the platform row. */
const DEFAULT_HOLD_DAYS = 7;

@Injectable()
export class PayoutSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private envHoldDays(): number {
    const raw = this.config?.get<number>('PAYOUT_HOLD_DAYS');
    return Number.isFinite(raw) ? Math.max(0, Number(raw)) : DEFAULT_HOLD_DAYS;
  }

  /**
   * The terms that apply to one organization right now.
   *
   * Reads both scopes in one query rather than two round trips, because this is on the path
   * of every settlement generate.
   */
  async effectiveFor(
    organizationId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<EffectivePayoutSettings> {
    const rows = await client.payoutSetting.findMany({
      where: { OR: [{ organizationId }, { organizationId: null }] },
      select: {
        organizationId: true,
        holdDays: true,
        minPayoutMinor: true,
        autoGenerate: true,
        runFrequency: true,
        runAnchorDay: true,
        lastRunAt: true,
      },
    });
    const own = rows.find((row) => row.organizationId === organizationId);
    const platform = rows.find((row) => row.organizationId === null);

    const holdDays =
      own?.holdDays ?? platform?.holdDays ?? (this.envHoldDays() as number | null) ?? 0;
    const minimums = (own?.minPayoutMinor ?? platform?.minPayoutMinor ?? null) as Record<
      string,
      number
    > | null;

    return {
      holdDays: Math.max(0, holdDays),
      minPayoutMinor: normaliseMinimums(minimums),
      autoGenerate: own?.autoGenerate ?? platform?.autoGenerate ?? false,
      runFrequency: (own?.runFrequency ?? platform?.runFrequency ?? 'WEEKLY').toUpperCase(),
      runAnchorDay: own?.runAnchorDay ?? platform?.runAnchorDay ?? 1,
      /*
        The organization's OWN stamp, never the platform's. A shared cursor would mean the
        first organization swept each day stopped every other one from running.
      */
      lastRunAt: own?.lastRunAt ?? null,
      source: {
        holdDays:
          own?.holdDays != null
            ? 'organization'
            : platform?.holdDays != null
              ? 'platform'
              : 'default',
        minPayoutMinor:
          own?.minPayoutMinor != null
            ? 'organization'
            : platform?.minPayoutMinor != null
              ? 'platform'
              : 'default',
        autoGenerate:
          own?.autoGenerate != null
            ? 'organization'
            : platform?.autoGenerate != null
              ? 'platform'
              : 'default',
      },
    };
  }

  /** The stored rows, for an admin screen: the platform row and every override. */
  async list() {
    const rows = await this.prisma.payoutSetting.findMany({
      include: { organization: { select: { id: true, name: true } } },
      orderBy: [{ organizationId: 'asc' }],
    });
    return {
      environmentHoldDays: this.envHoldDays(),
      platform: rows.find((row) => row.organizationId === null) ?? null,
      organizations: rows.filter((row) => row.organizationId !== null),
    };
  }

  /**
   * Write the platform row, or one organization's override.
   *
   * Audited with the values before and after: these are commercial terms, and "who agreed to
   * a fourteen-day hold for this promoter" is a question somebody will ask months later.
   */
  async update(actor: RequestUser, organizationId: string | null, input: PayoutSettingsInput) {
    if (input.holdDays != null && (!Number.isInteger(input.holdDays) || input.holdDays < 0)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'The holding period must be a whole number of days, or zero.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (input.holdDays != null && input.holdDays > 365) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A holding period longer than a year is not a term, it is a refusal to pay.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const minimums = input.minPayoutMinor === undefined ? undefined : input.minPayoutMinor;
    if (minimums) {
      for (const [currency, amount] of Object.entries(minimums)) {
        if (!/^[A-Za-z]{3}$/.test(currency)) {
          throw new AppException(
            ErrorCodes.VALIDATION_FAILED,
            `"${currency}" is not a currency code.`,
            HttpStatus.BAD_REQUEST,
          );
        }
        if (!Number.isInteger(amount) || amount < 0) {
          throw new AppException(
            ErrorCodes.VALIDATION_FAILED,
            `The minimum for ${currency.toUpperCase()} must be a whole number of minor units, or zero.`,
            HttpStatus.BAD_REQUEST,
          );
        }
      }
    }

    if (organizationId) {
      const organization = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { id: true },
      });
      if (!organization) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          'Organization not found.',
          HttpStatus.NOT_FOUND,
        );
      }
    }

    const before = await this.prisma.payoutSetting.findFirst({
      where: { organizationId: organizationId ?? null },
    });

    if (input.runFrequency != null && !RUN_FREQUENCIES.includes(input.runFrequency as never)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `A settlement run is ${RUN_FREQUENCIES.join(', ')} - not "${input.runFrequency}".`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      input.runAnchorDay != null &&
      (!Number.isInteger(input.runAnchorDay) || input.runAnchorDay < 1)
    ) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'The run day is a whole number: 1 to 7 for weekly, 1 to 28 for monthly.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (input.runAnchorDay != null && input.runAnchorDay > 28) {
      /*
        Never the 29th to the 31st. A monthly run anchored to the 31st would skip February
        entirely, and nobody notices until an organizer asks where their money is.
      */
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A monthly run day above 28 would skip February. Pick 1 to 28.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const data = {
      holdDays: input.holdDays === undefined ? (before?.holdDays ?? null) : input.holdDays,
      autoGenerate:
        input.autoGenerate === undefined ? (before?.autoGenerate ?? null) : input.autoGenerate,
      runFrequency:
        input.runFrequency === undefined ? (before?.runFrequency ?? null) : input.runFrequency,
      runAnchorDay:
        input.runAnchorDay === undefined ? (before?.runAnchorDay ?? null) : input.runAnchorDay,
      minPayoutMinor:
        minimums === undefined
          ? ((before?.minPayoutMinor ?? Prisma.DbNull) as
              Prisma.InputJsonValue | typeof Prisma.DbNull)
          : minimums === null
            ? Prisma.DbNull
            : (normaliseMinimums(minimums) as Prisma.InputJsonValue),
      updatedByUserId: actor.id,
    };

    const saved = before
      ? await this.prisma.payoutSetting.update({ where: { id: before.id }, data })
      : await this.prisma.payoutSetting.create({ data: { ...data, organizationId } });

    await this.audit.record({
      actorUserId: actor.id,
      organizationId: organizationId ?? undefined,
      action: 'PAYOUT_SETTINGS_UPDATED',
      entityType: 'PayoutSetting',
      entityId: saved.id,
      metadata: {
        scope: organizationId ? 'organization' : 'platform',
        before: {
          holdDays: before?.holdDays ?? null,
          minPayoutMinor: before?.minPayoutMinor ?? null,
          autoGenerate: before?.autoGenerate ?? null,
          runFrequency: before?.runFrequency ?? null,
          runAnchorDay: before?.runAnchorDay ?? null,
        },
        after: {
          holdDays: saved.holdDays,
          minPayoutMinor: saved.minPayoutMinor,
          autoGenerate: saved.autoGenerate,
          runFrequency: saved.runFrequency,
          runAnchorDay: saved.runAnchorDay,
        },
      },
    });
    return saved;
  }
}

/** Currency codes upper-cased and amounts made whole, so lookups cannot miss on case. */
function normaliseMinimums(raw: Record<string, number> | null): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [currency, amount] of Object.entries(raw)) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 0) continue;
    out[currency.toUpperCase()] = Math.round(value);
  }
  return out;
}
