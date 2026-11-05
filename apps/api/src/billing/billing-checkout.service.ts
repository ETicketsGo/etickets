import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OrganizerBillingAccount, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { redirectUrl } from '../common/console-urls';
import { SubscriptionService } from './subscription.service';
import { billingCountryOf, ensureBillingAccount } from './billing-account';
import { assertIndiaSellerReady } from './billing-seller';
import { CreditPackPricesService } from './credit-pack-prices.service';
import { BillingTaxService } from './billing-tax.service';
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
 *
 * Tax is worked out BEFORE the provider is called (BillingTaxService). No applicable tax rule
 * for the organizer's jurisdiction, and no Stripe Tax for a US account, means no checkout: it
 * is refused with BILLING_TAX_NOT_CONFIGURED rather than charged with no tax.
 */
@Injectable()
export class BillingCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly registry: BillingProviderRegistry,
    private readonly subscriptions: SubscriptionService,
    private readonly tax: BillingTaxService,
    private readonly packPrices: CreditPackPricesService,
  ) {}

  private assertEnabled(country: string) {
    if (
      this.config.get<string>('BILLING_ENABLED') === 'true' &&
      !this.registry.liveMarketOpen(country)
    ) {
      // PRODUCTION: this country is not in BILLING_LIVE_MARKETS.
      throw new AppException(
        ErrorCodes.BILLING_NOT_ENABLED,
        'Paying for a plan is not open in your country yet.',
        HttpStatus.CONFLICT,
      );
    }
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
    // India: no checkout while a GST tax invoice could not be issued for it (PRODUCTION).
    assertIndiaSellerReady((n) => this.config.get<string>(n), country);
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
    const tax = await this.tax.quote({
      organizationId,
      country: account.country,
      currency: price.currency,
      amountMinor: price.amountMinor,
    });
    const provider = await this.registry.forCountry(account.country);
    const customerRef = await this.customerFor(account, provider);
    return provider.createCheckout({
      tax,
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

  /**
   * What a plan price costs with tax, itemised, before the organizer is sent to pay: the same
   * quote the checkout uses, plus - where the provider's plan carries the amount (Razorpay) -
   * what that plan will actually charge, so the console can refuse to continue on a mismatch.
   * Reads only: nothing is created here, not even the billing account.
   */
  async quotePlan(organizationId: string, priceId: string) {
    const [org, account] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { registeredCountry: true },
      }),
      this.prisma.organizerBillingAccount.findUnique({ where: { organizationId } }),
    ]);
    const country =
      account?.country && account.country !== 'XX'
        ? account.country
        : (billingCountryOf(org?.registeredCountry) ?? 'XX');
    this.assertEnabled(country);
    const price = await this.prisma.billingPrice.findUnique({ where: { id: priceId } });
    if (!price || !price.active || price.country !== country) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'That price is not offered in your country.',
        HttpStatus.NOT_FOUND,
      );
    }
    const tax = await this.tax.quote({
      organizationId,
      country,
      currency: price.currency,
      amountMinor: price.amountMinor,
    });
    const provider = await this.registry.forCountry(country);
    const ref = provider.mode === 'live' ? price.providerPriceRefLive : price.providerPriceRefTest;
    let providerChargeMinor: number | null = null;
    if (provider.planCharge && ref && tax.mode === 'MANUAL') {
      try {
        const charge = await provider.planCharge(ref);
        providerChargeMinor = charge.currency === price.currency ? charge.amountMinor : -1;
      } catch {
        providerChargeMinor = null;
      }
    }
    return {
      priceId: price.id,
      interval: price.interval,
      currency: price.currency,
      mode: tax.mode,
      netMinor: tax.netMinor,
      taxMinor: tax.taxMinor,
      totalMinor: tax.totalMinor,
      lines: tax.lines.map((l) => ({
        label: l.label,
        rateBasisPoints: l.rateBasisPoints,
        amountMinor: l.amountMinor,
      })),
      placeOfSupply: tax.jurisdiction.region,
      interState: tax.jurisdiction.interState,
      /** India: REGISTERED (GST added) or UNREGISTERED (no GST; total = price). Else null. */
      sellerGstStatus: tax.sellerGstStatus,
      /** What the provider's plan charges per cycle; null when it could not be read here. */
      providerChargeMinor,
      /** False: the provider would charge something else, and the checkout will be refused. */
      chargeMatches: providerChargeMinor === null ? null : providerChargeMinor === tax.totalMinor,
    };
  }

  /**
   * Where a plan checkout stands, for the console's "waiting for your payment" panel. The
   * plan is ACTIVE only when OUR subscription says so, which only a verified provider payment
   * applied by the webhook processor can make true. The provider's record of the checkout
   * (Razorpay: created, authenticated, expired...) only says whether to keep waiting. Nothing
   * here changes any state, and nothing the browser sends is taken as proof of payment.
   */
  async checkoutStatus(
    organizationId: string,
    ref: string,
  ): Promise<{
    state: 'ACTIVE' | 'PENDING' | 'PROCESSING' | 'FAILED' | 'EXPIRED' | 'UNKNOWN';
    planActive: boolean;
  }> {
    const account = await this.prisma.organizerBillingAccount.findUnique({
      where: { organizationId },
    });
    const current = account
      ? await this.prisma.organizerSubscription.findUnique({ where: { currentKey: account.id } })
      : null;
    const planActive =
      !!current && current.source === 'PROVIDER' && LIVE_PAID.includes(current.status);
    if (planActive && (!ref || current!.providerSubscriptionRef === ref)) {
      return { state: 'ACTIVE', planActive };
    }
    if (!account || !/^sub_[A-Za-z0-9]{6,40}$/.test(ref)) {
      return { state: 'UNKNOWN', planActive };
    }
    const provider = await this.registry.byKey(account.provider);
    if (provider.key !== 'RAZORPAY_BILLING' || !provider.fetchSubscription) {
      return { state: 'UNKNOWN', planActive };
    }
    const rec = await provider.fetchSubscription(ref);
    // Another organization's checkout is "not found", never a status: refs are not a way in.
    if (!rec.verified || rec.organizationId !== organizationId) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Checkout not found.', HttpStatus.NOT_FOUND);
    }
    switch (rec.status) {
      case 'INCOMPLETE':
        return { state: 'PENDING', planActive };
      case 'AUTHENTICATED':
      case 'ACTIVE':
        // Paid or authorised at the provider; the plan starts when the webhook is applied.
        return { state: 'PROCESSING', planActive };
      case 'PAST_DUE':
      case 'HALTED':
        return { state: 'FAILED', planActive };
      default:
        return { state: 'EXPIRED', planActive };
    }
  }

  async startCreditPackCheckout(
    organizationId: string,
    packCode: string,
  ): Promise<BillingCheckoutSession> {
    const account = await this.prisma.$transaction((tx) =>
      ensureBillingAccount(tx, organizationId),
    );
    this.assertEnabled(account.country);
    // Only a PUBLISHED price is on sale; an unpublished pack is refused (owner decision).
    const { pack, price } = await this.packPrices.publishedPrice(packCode, account.country);
    const tax = await this.tax.quote({
      organizationId,
      country: account.country,
      currency: price.currency,
      amountMinor: price.amountMinor,
    });
    const provider = await this.registry.forCountry(account.country);
    if (!provider.createCreditPackCheckout) {
      throw new AppException(
        ErrorCodes.BILLING_PROVIDER_UNAVAILABLE,
        'Credit packs cannot be bought here yet.',
        HttpStatus.CONFLICT,
      );
    }
    const customerRef = await this.customerFor(account, provider);
    const purchaseRef = `pk_${randomUUID().replace(/-/g, '')}`;
    /*
      The quote is recorded BEFORE the provider is asked, so the payment is later checked
      against exactly what this checkout said - not against a price staff may have changed in
      between.
    */
    await this.prisma.creditPackPurchase.create({
      data: {
        purchaseRef,
        organizationId,
        accountId: account.id,
        packCode: pack.code,
        credits: pack.credits,
        country: account.country,
        currency: price.currency,
        netMinor: tax.netMinor,
        taxMinor: tax.taxMinor,
        totalMinor: tax.totalMinor,
        taxLines: tax.lines as unknown as Prisma.InputJsonValue,
        taxMode: tax.mode,
        provider: provider.key,
      },
    });
    const session = await provider.createCreditPackCheckout({
      organizationId,
      accountId: account.id,
      customerRef,
      packCode: pack.code,
      description: pack.name,
      amountMinor: price.amountMinor,
      currency: price.currency,
      purchaseRef,
      successUrl: this.returnUrl('credits=success'),
      cancelUrl: this.returnUrl('credits=cancelled'),
      tax,
    });
    await this.prisma.creditPackPurchase.update({
      where: { purchaseRef },
      data: { providerSessionRef: session.sessionRef },
    });
    return session;
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
