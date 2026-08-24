import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ManualTaxProvider } from './providers/manual-tax.provider';
import { ExternalTaxProvider } from './providers/external-tax.provider';
import { TAX_PROVIDER, type TaxProvider } from './tax-provider.interface';

/**
 * Selects the tax source from `TAX_PROVIDER` (default `manual`).
 *
 * Only the selected provider is constructed, so an installation using the TaxRule table
 * never needs a tax-service key, and one using a tax service fails fast at boot with a
 * missing key rather than at the first checkout.
 */
export function selectTaxProvider(config: ConfigService, prisma: PrismaService): TaxProvider {
  const name = config.get<string>('TAX_PROVIDER') ?? 'manual';
  switch (name) {
    case 'external':
      return new ExternalTaxProvider(config);
    case 'manual':
      return new ManualTaxProvider(prisma);
    default:
      // Refused rather than defaulted. A typo in TAX_PROVIDER must not silently fall back
      // to charging nothing — that is under-collection arriving through a config mistake.
      throw new Error(`Unknown TAX_PROVIDER '${name}'. Use 'manual' or 'external'.`);
  }
}

@Module({
  providers: [
    {
      provide: TAX_PROVIDER,
      inject: [ConfigService, PrismaService],
      useFactory: selectTaxProvider,
    },
  ],
  exports: [TAX_PROVIDER],
})
export class TaxModule {}
