import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OrganizerBillingAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { redirectUrl } from '../common/console-urls';
import { SubscriptionService } from './subscription.service';
import { ensureBillingAccount } from './billing-account';
import { creditPackByCode } from './credit-packs';
import { BillingProviderRegistry } from './provider/billing-provider.registry';
import {
  BILLING_NOT_ENABLED_MESSAGE,
  type BillingCheckoutSession,
  type BillingProvider,
} from './provider/billing-provider';

const LIVE_PAID = ['ACTIVE', 'PAST_DUE', 'GRACE'];

/**
 * What an organization OWNER starts with a provider: a plan checkout, a credit pack, the Stripe
 * Billing Portal, a cancellation. The controller has already checked membership and role.
 *
 * Nothing here grants anything. A checkout returns a hosted URL; the plan or the credits arrive
 * only when the provider's verified record of the payment is applied by the webhook processor.
 * The page the organizer returns to polls our state and never trusts the redirect.
 */
@Injectable()
export class BillingCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly registry: BillingProviderRegistry,
    private readonly subscriptions: SubscriptionService,
  ) {}

  private assertEnabled(country: string) {
    if (
      this.config.get<string>('BILLING_ENABLED') !== 'true' ||
      !this.registry.configuredFor(country)
    ) {
      throw new AppException(
        ErrorCodes.BILLING_NOT_ENABLED,
        BILLING_NOT_ENABLED_MESSAGE,
        HttpStatus.CONFLICT,
      );
    }
  }

  private returnUrl(query: string): string {
    return redirectUrl(this.config, {
      site: 'organizer',
      path: '/organizer/billing',
      query,
      purpose: 'billing checkout return',
    });
  }

  /**
   * Binds the account to this provider (one provider per account, for life) and returns its
   * provider customer, created on first need where the provider has customers we create
   * (Stripe). Razorpay creates its own customer at mandate authentication; its subscriptions
   * are bound to the account by the notes our server writes on them.
   */
  private async customerFor(
    account: OrganizerBillingAccount,
    provider: BillingProvider,
  ): Promise<string | null> {
    const realProvider = provider.key === 'STRIPE_BILLING' || provider.key === 'RAZORPAY_BILLING';
    if (realProvider && account.provider !== 'NONE' && account.provider !== provider.key) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This organization already pays through another provider. Contact ETicketsGo support.',
        HttpStatus.CONFLICT,
      );
    }
    if (!provider.ensureCustomer) {
      if (realProvider && account.provider === 'NONE') {
        await this.prisma.organizerBillingAccount.update({
          where: { id: account.id },
          data: { provider: provider.key },
        });
      }
      return account.providerCustomerRef;
    }
    if (account.providerCustomerRef && account.provider === provider.key) {
      return account.providerCustomerRef;
    }
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: account.organizationId },
      select: { name: true, legalName: true },
    });
    const ref = await provider.ensureCustomer({
      organizationId: account.organizationId,
      accountId: account.id,
      name: org.legalName || org.name,
      email: account.billingEmail,
      country: account.country,
    });
    await this.prisma.organizerBillingAccount.update({
      where: { id: account.id },
      data: { provider: provider.key, providerCustomerRef: ref },
    });
    return ref;
  }

  async startPlanCheckout(
    organizationId: string,
    priceId: string,
  ): Promise<BillingCheckoutSession> {
    const account = await this.prisma.$transaction((tx) =>
      ensureBillingAccount(tx, organizationId),
    );
    this.assertEnabled(account.country);
    const price = await this.prisma.billingPrice.findUnique({ where: { id: priceId } });
    if (!price || !price.active || price.country !== account.country) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'That price is not offered in your country.',
        HttpStatus.NOT_FOUND,
      );
    }
    const current = await this.prisma.organizerSubscription.findUnique({
      where: { currentKey: account.id },
    });
    if (current && current.source === 'PROVIDER' && LIVE_PAID.includes(current.status)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Your organization already pays for a plan. Manage it from Billing & plans.',
        HttpStatus.CONFLICT,
      );
    }
    const provider = await this.registry.forCountry(account.country);
    const customerRef = await this.customerFor(account, provider);
    return provider.createCheckout({
      organizationId,
      accountId: account.id,
      priceId: price.id,
      country: price.country,
      currency: price.currency,
      amountMinor: price.amountMinor,
      interval: price.interval,
      providerPriceRef:
        provider.mode === 'live' ? price.providerPriceRefLive : price.providerPriceRefTest,
      customerRef,
      successUrl: this.returnUrl('checkout=success'),
      cancelUrl: this.returnUrl('checkout=cancelled'),
    });
  }

  async startCreditPackCheckout(
    organizationId: string,
    packCode: string,
  ): Promise<BillingCheckoutSession> {
    const account = await this.prisma.$transaction((tx) =>
      ensureBillingAccount(tx, organizationId),
    );
    this.assertEnabled(account.country);
    const pack = creditPackByCode(packCode);
    const price = pack?.prices[account.country];
    if (!pack || !price) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'That credit pack is not offered in your country.',
        HttpStatus.NOT_FOUND,
      );
    }
    const provider = await this.registry.forCountry(account.country);
    if (!provider.createCreditPackCheckout) {
      throw new AppException(
        ErrorCodes.BILLING_PROVIDER_UNAVAILABLE,
        'Credit packs cannot be bought here yet.',
        HttpStatus.CONFLICT,
      );
    }
    const customerRef = await this.customerFor(account, provider);
    return provider.createCreditPackCheckout({
      organizationId,
      accountId: account.id,
      customerRef,
      packCode: pack.code,
      description: pack.name,
      amountMinor: price.amountMinor,
      currency: price.currency,
      purchaseRef: `pk_${randomUUID().replace(/-/g, '')}`,
      successUrl: this.returnUrl('credits=success'),
      cancelUrl: this.returnUrl('credits=cancelled'),
    });
  }

  /** The provider's hosted page to change the card or cancel. Stripe only. */
  async portal(organizationId: string): Promise<{ url: string }> {
    const account = await this.prisma.organizerBillingAccount.findUnique({
      where: { organizationId },
    });
    if (!account?.providerCustomerRef) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'There is no payment method on file for this organization.',
        HttpStatus.NOT_FOUND,
      );
    }
    const provider = await this.registry.byKey(account.provider);
    if (!provider.createPortal) {
      throw new AppException(
        ErrorCodes.BILLING_PROVIDER_UNAVAILABLE,
        'Your payment provider has no self-service page. To stop your plan, use Cancel plan.',
        HttpStatus.CONFLICT,
      );
    }
    return provider.createPortal(account.providerCustomerRef, this.returnUrl('portal=returned'));
  }

  /**
   * Cancels at the end of the paid period. The provider is asked first; our subscription moves
   * only after the provider's answer says the cancellation is in place.
   */
  async cancel(organizationId: string, actorUserId: string, reason: string | null) {
    const account = await this.prisma.organizerBillingAccount.findUnique({
      where: { organizationId },
    });
    const current = account
      ? await this.prisma.organizerSubscription.findUnique({ where: { currentKey: account.id } })
      : null;
    if (
      !account ||
      !current ||
      current.source !== 'PROVIDER' ||
      !current.providerSubscriptionRef ||
      !LIVE_PAID.includes(current.status)
    ) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'There is no paid plan to cancel.',
        HttpStatus.CONFLICT,
      );
    }
    if (current.cancelAtPeriodEnd) return current;
    const provider = await this.registry.byKey(account.provider);
    if (!provider.cancelAtPeriodEnd) {
      throw new AppException(
        ErrorCodes.BILLING_PROVIDER_UNAVAILABLE,
        'This plan cannot be cancelled here. Contact ETicketsGo support.',
        HttpStatus.CONFLICT,
      );
    }
    const rec = await provider.cancelAtPeriodEnd(current.providerSubscriptionRef);
    if (rec.subscriptionRef !== current.providerSubscriptionRef) {
      throw new AppException(
        ErrorCodes.BILLING_PROVIDER_UNAVAILABLE,
        'The payment provider did not confirm the cancellation. Try again.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    const ended = rec.status === 'CANCELLED' || rec.status === 'COMPLETED';
    return this.subscriptions.apply(
      organizationId,
      ended ? { type: 'CANCEL_NOW' } : { type: 'CANCEL_AT_PERIOD_END' },
      {
        auditAction: 'BILLING_CANCEL_REQUESTED',
        actorUserId,
        reason,
      },
    );
  }
}
