import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { MockPaymentProvider } from './provider/mock-payment.provider';
import { PAYMENT_PROVIDER } from './provider/payment-provider.interface';
import { selectPaymentProvider } from './provider/payment-provider.factory';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [InventoryModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    // Mock stays registered (default provider + PaymentsService's dev mock-pay path).
    MockPaymentProvider,
    // Active provider, keyed on PAYMENT_PROVIDER_NAME (default 'mock'). Only the
    // selected provider is constructed, so Stripe/Razorpay keys are never required
    // unless that provider is chosen.
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService, MockPaymentProvider],
      useFactory: selectPaymentProvider,
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
