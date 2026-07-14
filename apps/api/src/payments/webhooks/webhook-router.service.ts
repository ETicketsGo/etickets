import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException, ErrorCodes } from '../../common/errors';
import { AuditService } from '../../audit/audit.service';
import { MetricsService } from '../../metrics/metrics.service';
import { PaymentsService } from '../payments.service';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';
import type { PaymentProvider } from '../provider/payment-provider.interface';

/**
 * Routes an inbound webhook to the correct provider adapter (ADR-023). The provider
 * is named in the URL (`/payments/webhook/:provider`), so multiple gateways can be
 * live at once — each verifies with its own scheme before we process the settlement
 * event. Verification/parsing stays inside the adapter; this router only assembles
 * the signature material from the request headers and records observability.
 */
@Injectable()
export class WebhookRouter {
  private readonly logger = new Logger(WebhookRouter.name);

  constructor(
    private readonly registry: PaymentProviderRegistry,
    private readonly payments: PaymentsService,
    private readonly metrics: MetricsService,
    private readonly audit: AuditService,
  ) {}

  async route(providerName: string, rawBody: string, headers: Record<string, string | undefined>) {
    const adapter = this.registry.get(providerName);
    if (!adapter) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        `Unknown or unconfigured payment provider '${providerName}'.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const signature = this.buildSignature(providerName, adapter, headers);

    let event;
    try {
      event = await adapter.verifyWebhook({ rawBody, signature });
    } catch (err) {
      this.metrics.recordPaymentWebhook(adapter.name, 'rejected');
      throw err;
    }
    this.metrics.recordPaymentWebhook(adapter.name, 'verified');

    const result = (await this.payments.processVerifiedEvent(event)) as { status?: string };
    this.metrics.recordPaymentWebhook(
      adapter.name,
      result?.status === 'failed' ? 'failed' : 'processed',
    );
    await this.audit.record({
      action: 'PAYMENT_WEBHOOK_PROCESSED',
      entityType: 'Payment',
      entityId: event.bookingId,
      metadata: { provider: adapter.name, type: event.type, result: result?.status },
    });
    this.logger.log(`Webhook ${adapter.name}/${event.type} → ${result?.status ?? 'ok'}`);
    return result;
  }

  /**
   * Build the signature material a provider's verifyWebhook expects. PayPal verifies
   * server-side from a bundle of transmission headers (passed as JSON); the others
   * use a single signature header.
   */
  private buildSignature(
    providerName: string,
    adapter: PaymentProvider,
    headers: Record<string, string | undefined>,
  ): string {
    const h = (name: string) => headers[name.toLowerCase()] ?? '';
    if (providerName.toLowerCase() === 'paypal') {
      return JSON.stringify({
        transmissionId: h('paypal-transmission-id'),
        transmissionTime: h('paypal-transmission-time'),
        certUrl: h('paypal-cert-url'),
        authAlgo: h('paypal-auth-algo'),
        transmissionSig: h('paypal-transmission-sig'),
      });
    }
    return h(adapter.webhookSignatureHeader);
  }
}
