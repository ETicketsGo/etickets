import { HttpStatus, Injectable } from '@nestjs/common';
import { currencyForCountry } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { BILLING_COUNTRIES } from './billing-account';
import { EMAIL_CREDIT_PACKS, creditPackByCode } from './credit-packs';

/**
 * Staff-set prices for the email credit packs, per country (owner decision 2026-10-27).
 *
 * Every write needs BILLING_MANAGE and a recent second factor (the controller), and leaves an
 * audit row in the same transaction. A price starts UNPUBLISHED: setting one never puts a pack
 * on sale; publishing is its own, deliberate step. `expectedVersion` refuses a write made from
 * a page that is out of date, so two people editing one price cannot silently overwrite.
 */
@Injectable()
export class CreditPackPricesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Every pack, with its price row (or none) for each billing country. */
  async list() {
    const rows = await this.prisma.creditPackPrice.findMany();
    return EMAIL_CREDIT_PACKS.map((pack) => ({
      code: pack.code,
      name: pack.name,
      credits: pack.credits,
      prices: BILLING_COUNTRIES.map((country) => {
        const row = rows.find((r) => r.packCode === pack.code && r.country === country);
        return {
          country,
          currency: row?.currency ?? currencyForCountry(country) ?? null,
          amountMinor: row?.amountMinor ?? null,
          published: row?.published ?? false,
          publishedAt: row?.publishedAt ?? null,
          version: row?.version ?? 0,
          updatedAt: row?.updatedAt ?? null,
        };
      }),
    }));
  }

  private assertTarget(packCode: string, country: string) {
    if (!creditPackByCode(packCode)) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'No such credit pack.', HttpStatus.NOT_FOUND);
    }
    if (!(BILLING_COUNTRIES as readonly string[]).includes(country)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Credit packs are priced for India and the USA only.',
      );
    }
  }

  private staleCheck(current: number, expected: number | undefined) {
    if (expected !== undefined && expected !== current) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Somebody changed this price since you opened the page. Reload and try again.',
        HttpStatus.CONFLICT,
        { reason: 'STALE_VERSION', version: current },
      );
    }
  }

  /** Sets the price (before tax). Publication is unchanged: a new price starts unpublished. */
  async setPrice(
    packCode: string,
    country: string,
    input: { currency: string; amountMinor: number; expectedVersion?: number },
    actorUserId: string,
  ) {
    this.assertTarget(packCode, country);
    const currency = currencyForCountry(country);
    if (input.currency !== currency) {
      throw new AppException(ErrorCodes.VALIDATION_FAILED, `A ${country} price is in ${currency}.`);
    }
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new AppException(ErrorCodes.VALIDATION_FAILED, 'A price is a whole amount above zero.');
    }
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.creditPackPrice.findUnique({
        where: { packCode_country: { packCode, country } },
      });
      this.staleCheck(existing?.version ?? 0, input.expectedVersion);
      const row = existing
        ? await tx.creditPackPrice.update({
            where: { id: existing.id },
            data: {
              amountMinor: input.amountMinor,
              currency: input.currency,
              version: { increment: 1 },
              updatedByUserId: actorUserId,
            },
          })
        : await tx.creditPackPrice.create({
            data: {
              packCode,
              country,
              currency: input.currency,
              amountMinor: input.amountMinor,
              updatedByUserId: actorUserId,
            },
          });
      await this.audit.recordInTransaction(tx, {
        actorUserId,
        action: 'BILLING_CREDIT_PACK_PRICE_SET',
        entityType: 'CreditPackPrice',
        entityId: row.id,
        metadata: {
          packCode,
          country,
          currency: row.currency,
          from: existing?.amountMinor ?? null,
          to: row.amountMinor,
          published: row.published,
        },
      });
      return row;
    });
  }

  /** Puts a priced pack on sale in that country, or takes it off sale. */
  async setPublished(
    packCode: string,
    country: string,
    published: boolean,
    actorUserId: string,
    expectedVersion?: number,
  ) {
    this.assertTarget(packCode, country);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.creditPackPrice.findUnique({
        where: { packCode_country: { packCode, country } },
      });
      if (!existing) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'Set a price for this pack first.',
          HttpStatus.CONFLICT,
        );
      }
      this.staleCheck(existing.version, expectedVersion);
      if (existing.published === published) return existing;
      const row = await tx.creditPackPrice.update({
        where: { id: existing.id },
        data: {
          published,
          publishedAt: published ? new Date() : existing.publishedAt,
          version: { increment: 1 },
          updatedByUserId: actorUserId,
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorUserId,
        action: published ? 'BILLING_CREDIT_PACK_PUBLISHED' : 'BILLING_CREDIT_PACK_UNPUBLISHED',
        entityType: 'CreditPackPrice',
        entityId: row.id,
        metadata: { packCode, country, currency: row.currency, amountMinor: row.amountMinor },
      });
      return row;
    });
  }

  /** The published price a checkout may use, or a refusal. */
  async publishedPrice(packCode: string, country: string) {
    const pack = creditPackByCode(packCode);
    const row = pack
      ? await this.prisma.creditPackPrice.findUnique({
          where: { packCode_country: { packCode, country } },
        })
      : null;
    if (!pack || !row || !row.published) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'That credit pack is not on sale in your country.',
        HttpStatus.NOT_FOUND,
      );
    }
    return { pack, price: row };
  }
}
