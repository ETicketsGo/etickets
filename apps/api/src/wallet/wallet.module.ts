import { Module } from '@nestjs/common';
import { TicketsModule } from '../tickets/tickets.module';
import { WalletPassController } from './wallet-pass.controller';
import { WalletPassService } from './wallet-pass.service';
import { WalletConfigService } from './wallet-config.service';
import { AppleWalletAdapter } from './provider/apple-wallet.adapter';
import { GoogleWalletAdapter } from './provider/google-wallet.adapter';

/**
 * Wallet-pass sandbox (ADR-035). Projects existing valid tickets into Apple/Google
 * wallet pass descriptors via environment-based adapters. Reuses the ticket source of
 * truth + QR signing + authorization (TicketsModule). Global Config/Audit are provided
 * app-wide. No secret material is embedded — providers fail closed when unconfigured.
 */
@Module({
  imports: [TicketsModule],
  controllers: [WalletPassController],
  providers: [WalletPassService, WalletConfigService, AppleWalletAdapter, GoogleWalletAdapter],
})
export class WalletModule {}
