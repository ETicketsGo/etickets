import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Role,
  isCountryConsistent,
  mapStripeAccountToOnboardingStatus,
  marketFor,
  type ConnectOnboardingStatus,
} from '@eticketsgo/shared-types';
import type { CreateConnectAccountInput } from '@eticketsgo/validation';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import { redirectUrl } from '../../common/console-urls';
import type { RequestUser } from '../../common/decorators';
import {
  type ConnectedAccountSnapshot,
  type PaymentProvider,
} from '../provider/payment-provider.interface';
import { PaymentProviderResolver } from '../provider/payment-provider.resolver';

/** Client-safe onboarding status (never exposes sensitive Stripe data). */
export interface OrganizerPaymentStatus {
  organizationId: string;
  provider: string;
  hasAccount: boolean;
  accountType: string;
  onboardingStatus: ConnectOnboardingStatus;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[];
  disabledReason: string | null;
  /** Derived: may this organizer sell paid tickets / receive settlements? */
  canSellPaidTickets: boolean;
  country: string;
  currency: string;
}

// Owner + manager may view; account/link creation is owner-only (payout setup).
const VIEW_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];
const MANAGE_ROLES = [Role.ORGANIZER_OWNER];

/** A provider that implements the required Connect operations (Stripe). */
type ConnectCapableProvider = PaymentProvider &
  Required<
    Pick<PaymentProvider, 'createConnectedAccount' | 'getConnectedAccount' | 'createOnboardingLink'>
  >;

/** The sentence for every "this server cannot use the provider" cause. Names no provider. */
const NOT_CONFIGURED_MESSAGE =
  'Payout setup is not switched on for this site yet. Contact ETicketsGo support.';

/*
  The Stripe SDK's error classes, by the `type` each instance carries. Matched by name rather
  than `instanceof` so the classification does not depend on which copy of the SDK threw.

  PLATFORM: Stripe refused OUR request or OUR credentials. That is our configuration - the
  QA refusal "Stripe no longer recommends Accounts v1 ... enable Accounts v1 support in the
  Dashboard" is one - and nothing the organizer does will change it.
  TRANSIENT: Stripe was unreachable, failed, or rate-limited us. Trying again can work.
*/
const STRIPE_PLATFORM_ERRORS = new Set([
  'StripeInvalidRequestError',
  'StripePermissionError',
  'StripeAuthenticationError',
]);
const STRIPE_TRANSIENT_ERRORS = new Set([
  'StripeConnectionError',
  'StripeAPIError',
  'StripeRateLimitError',
  'StripeIdempotencyError',
]);
/** Stripe request parameters that come from OUR organization row, as its field names. */
const ORGANIZATION_PARAMS: Record<string, string> = { email: 'contactEmail' };

/**
 * A provider failure during payout setup, as a refusal the organizer can act on.
 *
 * Stripe's own sentence goes to the log with the correlation id, never to the organizer: it
 * names our platform's settings and products ("Accounts v1", "the Dashboard"), and the person
 * reading the console can do nothing about either. It used to be returned verbatim in a 502,
 * and before that swallowed into a bare "Something went wrong."
 */
export function payoutSetupFailure(err: unknown, logger: Logger, step: string): AppException {
  const e = (err ?? {}) as { type?: unknown; message?: unknown; param?: unknown; code?: unknown };
  const type = typeof e.type === 'string' ? e.type : '';
  const detail = typeof e.message === 'string' ? e.message : 'unknown error';
  logger.error(
    `Stripe refused ${step}: [${type || 'non-Stripe error'}${typeof e.code === 'string' ? ` ${e.code}` : ''}] ${detail.slice(0, 500)}`,
  );

  const field = typeof e.param === 'string' ? ORGANIZATION_PARAMS[e.param] : undefined;
  if (type === 'StripeInvalidRequestError' && field) {
    return new AppException(
      ErrorCodes.ORGANIZATION_DETAILS_INCOMPLETE,
      'Your organization details are incomplete. Check them in Settings, then try again.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { fields: [field] },
    );
  }
  if (STRIPE_PLATFORM_ERRORS.has(type)) {
    return new AppException(
      ErrorCodes.PAYMENT_PROVIDER_NOT_CONFIGURED,
      NOT_CONFIGURED_MESSAGE,
      HttpStatus.SERVICE_UNAVAILABLE,
      { retryable: false },
    );
  }
  return new AppException(
    ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
    'The payout provider is not answering right now. Try again in a few minutes.',
    STRIPE_TRANSIENT_ERRORS.has(type) ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_GATEWAY,
    { retryable: true },
  );
}

/**
 * Organizer-facing Stripe Connect onboarding. Reuses the active PAYMENT_PROVIDER
 * (Stripe for the US marketplace). Stores only non-secret account identifiers +
 * capability flags on OrganizerPaymentAccount, synced from Stripe.
 */
@Injectable()
export class OrganizerConnectService {
  private readonly logger = new Logger(OrganizerConnectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly resolver: PaymentProviderResolver,
  ) {}

  /**
   * The provider this service is about, resolved by NAME.
   *
   * Every route on the controller is `/stripe/...`, so the answer is never in doubt — but
   * this injected `PAYMENT_PROVIDER`, the single globally configured provider, which is
   * `mock`. With Stripe fully configured, asking for an organizer's connected account
   * answered `501 The active payment provider (mock) does not support connected accounts`,
   * naming a provider the caller never mentioned.
   *
   * The same single-provider assumption broke the Stripe webhook endpoint. Routing on this
   * platform is per booking, from currency — there is no one active provider to ask.
   */
  private get providerName(): string {
    return 'stripe';
  }

  private connectProvider(): ConnectCapableProvider {
    /*
      Constructing throws when Stripe's secrets are missing. That plain Error used to reach the
      exception filter as a 500 "Something went wrong." - the organizer could not tell it from a
      bug. A missing key, and the not-activated stand-in (which has no Connect methods), are the
      same fact for the organizer: this site cannot set up Stripe payouts yet.
    */
    let provider: PaymentProvider;
    try {
      provider = this.resolver.get(this.providerName);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (!/requires [A-Z0-9_]+ to be set/.test(message)) throw err;
      this.logger.error(`Stripe payout setup is not configured on this server: ${message}`);
      throw new AppException(
        ErrorCodes.PAYMENT_PROVIDER_NOT_CONFIGURED,
        NOT_CONFIGURED_MESSAGE,
        HttpStatus.SERVICE_UNAVAILABLE,
        { retryable: false },
      );
    }
    if (
      !provider.createConnectedAccount ||
      !provider.getConnectedAccount ||
      !provider.createOnboardingLink
    ) {
      this.logger.error(`The ${provider.name} adapter on this server has no connected accounts.`);
      throw new AppException(
        ErrorCodes.PAYMENT_PROVIDER_NOT_CONFIGURED,
        NOT_CONFIGURED_MESSAGE,
        HttpStatus.SERVICE_UNAVAILABLE,
        { retryable: false },
      );
    }
    return provider as ConnectCapableProvider;
  }

  /**
   * The country a new connected account is opened in: where the organization is registered.
   *
   * It was hardcoded `US`, so a Canadian organizer was sent through United States onboarding,
   * and an Indian one selling in dollars (who is shown the card panel) had a US account
   * created for a business that is not in the US. Both are refused or corrected here, BEFORE
   * Stripe is asked to create anything.
   */
  private async stripeCountryFor(organizationId: string): Promise<string> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, registeredCountry: true },
    });
    if (!org) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organization not found.', HttpStatus.NOT_FOUND);
    }
    if (!org.registeredCountry?.trim()) {
      throw new AppException(
        ErrorCodes.ORGANIZATION_DETAILS_INCOMPLETE,
        'Your organization details are incomplete: add your country of registration in Settings, then try again.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { fields: ['registeredCountry'] },
      );
    }
    const market = marketFor(org.registeredCountry);
    const code = market?.code ?? org.registeredCountry.trim().toUpperCase();
    if (!market || !isCountryConsistent('stripe', code)) {
      throw new AppException(
        ErrorCodes.PAYOUT_COUNTRY_UNSUPPORTED,
        'Payout setup here is not available for your country yet.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { country: code },
      );
    }
    return code;
  }

  private async requireOrganization(
    organizationId: string,
  ): Promise<{ contactEmail: string | null }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, contactEmail: true },
    });
    if (!org) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organization not found.', HttpStatus.NOT_FOUND);
    }
    return org;
  }

  /**
   * Create (or return the existing) connected account for the organizer. Never
   * creates a duplicate: if a providerAccountId is already stored, it is returned.
   */
  async createOrGetAccount(
    user: RequestUser,
    organizationId: string,
    input: CreateConnectAccountInput,
  ): Promise<OrganizerPaymentStatus> {
    await this.access.assertMember(user, organizationId, MANAGE_ROLES);
    const provider = this.connectProvider();

    const existing = await this.prisma.organizerPaymentAccount.findUnique({
      where: { organizationId_provider: { organizationId, provider: provider.name } },
    });
    if (existing?.providerAccountId) {
      return this.toStatus(existing);
    }

    const org = await this.requireOrganization(organizationId);
    /*
      Classified, not "Something went wrong", and not Stripe's own sentence either.

      Onboarding failed on QA with a bare 500, then (after a first fix) with Stripe's text
      printed to the organizer: *"Stripe no longer recommends Accounts v1 for new Connect
      integrations... enable Accounts v1 support in the Dashboard"*. That sentence is for
      whoever runs our Stripe account, so it goes to the log (with the correlation id the
      organizer can quote); the organizer gets a code and words they can act on.
    */
    let created: { accountId: string };
    try {
      created = await provider.createConnectedAccount({
        organizationId,
        country: input.country,
        email: input.email ?? org.contactEmail ?? undefined,
      });
    } catch (err) {
      throw payoutSetupFailure(err, this.logger, 'to create a connected account');
    }

    const accountType = this.config.get<string>('STRIPE_CONNECT_ACCOUNT_TYPE') ?? 'express';
    const account = await this.prisma.organizerPaymentAccount.upsert({
      where: { organizationId_provider: { organizationId, provider: provider.name } },
      create: {
        organizationId,
        provider: provider.name,
        providerAccountId: created.accountId,
        accountType,
        onboardingStatus: 'ONBOARDING',
        country: input.country,
      },
      update: { providerAccountId: created.accountId, accountType, onboardingStatus: 'ONBOARDING' },
    });

    await this.audit.record({
      actorUserId: user.id,
      organizationId,
      action: 'CONNECT_ACCOUNT_CREATED',
      entityType: 'OrganizerPaymentAccount',
      entityId: account.id,
      metadata: { provider: provider.name, accountType },
    });

    return this.toStatus(account);
  }

  /** Create a hosted onboarding link, ensuring the account exists first. */
  async createOnboardingLink(
    user: RequestUser,
    organizationId: string,
  ): Promise<{ url: string; expiresAt?: number }> {
    await this.access.assertMember(user, organizationId, MANAGE_ROLES);
    const provider = this.connectProvider();
    const country = await this.stripeCountryFor(organizationId);

    // Ensure an account exists (idempotent) before generating the link.
    const status = await this.createOrGetAccount(user, organizationId, { country });
    const account = await this.prisma.organizerPaymentAccount.findUniqueOrThrow({
      where: { organizationId_provider: { organizationId, provider: provider.name } },
    });
    if (!account.providerAccountId) {
      throw new AppException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'The payout provider is not answering right now. Try again in a few minutes.',
        HttpStatus.BAD_GATEWAY,
        { retryable: true },
      );
    }
    void status;

    // Derived from ORGANIZER_WEB_URL, so an organizer part-way through Stripe's hosted
    // onboarding is returned to the console they came from rather than to localhost.
    const returnUrl = redirectUrl(this.config, {
      overrideVariable: 'STRIPE_CONNECT_RETURN_URL',
      site: 'organizer',
      path: '/organizer/payouts',
      query: 'onboarding=return',
      purpose: 'Stripe Connect onboarding return',
    });
    const refreshUrl = redirectUrl(this.config, {
      overrideVariable: 'STRIPE_CONNECT_REFRESH_URL',
      site: 'organizer',
      path: '/organizer/payouts',
      query: 'onboarding=refresh',
      purpose: 'Stripe Connect onboarding refresh',
    });
    // Stripe's refusal here was not caught at all: any failure became a 500.
    let link: { url: string; expiresAt?: number };
    try {
      link = await provider.createOnboardingLink({
        accountId: account.providerAccountId,
        returnUrl,
        refreshUrl,
      });
    } catch (err) {
      throw payoutSetupFailure(err, this.logger, 'to create an onboarding link');
    }

    await this.audit.record({
      actorUserId: user.id,
      organizationId,
      action: 'CONNECT_ONBOARDING_LINK_CREATED',
      entityType: 'OrganizerPaymentAccount',
      entityId: account.id,
    });
    return link;
  }

  /**
   * Return the organizer's safe onboarding status, refreshed live from the provider
   * so requirements/capabilities are current even before the account.updated webhook.
   */
  async getStatus(user: RequestUser, organizationId: string): Promise<OrganizerPaymentStatus> {
    await this.access.assertMember(user, organizationId, VIEW_ROLES);
    const account = await this.prisma.organizerPaymentAccount.findUnique({
      where: { organizationId_provider: { organizationId, provider: this.providerName } },
    });
    if (!account?.providerAccountId) {
      return this.emptyStatus(organizationId);
    }
    try {
      const snapshot = await this.connectProvider().getConnectedAccount(account.providerAccountId);
      const synced = await this.applySnapshot(account.id, snapshot);
      return this.toStatus(synced);
    } catch (err) {
      // A provider outage must not break the organizer's dashboard — fall back to the
      // last-synced DB state (kept fresh by the account.updated webhook).
      this.logger.warn(
        `Stripe account refresh failed for org ${organizationId}: ${err instanceof Error ? err.message : err}`,
      );
      return this.toStatus(account);
    }
  }

  /** Create a Stripe Express dashboard login link (only for supported account types). */
  async createDashboardLink(user: RequestUser, organizationId: string): Promise<{ url: string }> {
    await this.access.assertMember(user, organizationId, MANAGE_ROLES);
    const provider = this.connectProvider();
    const account = await this.prisma.organizerPaymentAccount.findUnique({
      where: { organizationId_provider: { organizationId, provider: provider.name } },
    });
    if (!account?.providerAccountId) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'No connected account exists yet. Complete payout setup first.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!provider.createDashboardLink) {
      throw new AppException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'Dashboard links are not supported by the active provider.',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
    try {
      return await provider.createDashboardLink(account.providerAccountId);
    } catch (err) {
      if (err instanceof AppException) throw err;
      throw payoutSetupFailure(err, this.logger, 'to create a dashboard link');
    }
  }

  /**
   * Sync an OrganizerPaymentAccount from a provider snapshot. Shared by getStatus and
   * the account.updated webhook (M4) so both paths converge on the same mapping.
   */
  async applySnapshot(accountRowId: string, snapshot: ConnectedAccountSnapshot) {
    const onboardingStatus = mapStripeAccountToOnboardingStatus({
      hasAccount: true,
      detailsSubmitted: snapshot.detailsSubmitted,
      chargesEnabled: snapshot.chargesEnabled,
      payoutsEnabled: snapshot.payoutsEnabled,
      requirementsCurrentlyDue: snapshot.requirementsCurrentlyDue,
      disabledReason: snapshot.disabledReason,
    });
    return this.prisma.organizerPaymentAccount.update({
      where: { id: accountRowId },
      data: {
        detailsSubmitted: snapshot.detailsSubmitted,
        chargesEnabled: snapshot.chargesEnabled,
        payoutsEnabled: snapshot.payoutsEnabled,
        requirementsDue: snapshot.requirementsCurrentlyDue,
        disabledReason: snapshot.disabledReason ?? null,
        onboardingStatus,
        ...(snapshot.defaultCurrency ? { defaultCurrency: snapshot.defaultCurrency } : {}),
        ...(snapshot.country ? { country: snapshot.country } : {}),
      },
    });
  }

  /** Resolve the account row for a Stripe connected-account id (webhook path). */
  findByProviderAccountId(providerAccountId: string) {
    return this.prisma.organizerPaymentAccount.findFirst({ where: { providerAccountId } });
  }

  /**
   * Sync a connected account from an account.updated webhook snapshot. Returns false
   * when we have no matching account row (event for an account we do not track).
   */
  async syncByProviderAccountId(
    providerAccountId: string,
    snapshot: ConnectedAccountSnapshot,
  ): Promise<boolean> {
    const row = await this.findByProviderAccountId(providerAccountId);
    if (!row) return false;
    const before = row.onboardingStatus;
    const updated = await this.applySnapshot(row.id, snapshot);
    if (updated.onboardingStatus !== before) {
      await this.audit.record({
        organizationId: row.organizationId,
        action: 'CONNECT_ACCOUNT_STATUS_CHANGED',
        entityType: 'OrganizerPaymentAccount',
        entityId: row.id,
        metadata: { from: before, to: updated.onboardingStatus },
      });
    }
    return true;
  }

  private emptyStatus(organizationId: string): OrganizerPaymentStatus {
    return {
      organizationId,
      provider: this.providerName,
      hasAccount: false,
      accountType: this.config.get<string>('STRIPE_CONNECT_ACCOUNT_TYPE') ?? 'express',
      onboardingStatus: 'NOT_STARTED',
      detailsSubmitted: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsDue: [],
      disabledReason: null,
      canSellPaidTickets: false,
      country: 'US',
      currency: 'usd',
    };
  }

  private toStatus(a: {
    organizationId: string;
    provider: string;
    providerAccountId: string | null;
    accountType: string;
    onboardingStatus: ConnectOnboardingStatus;
    detailsSubmitted: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    requirementsDue: string[];
    disabledReason: string | null;
    country: string;
    defaultCurrency: string;
  }): OrganizerPaymentStatus {
    return {
      organizationId: a.organizationId,
      provider: a.provider,
      hasAccount: Boolean(a.providerAccountId),
      accountType: a.accountType,
      onboardingStatus: a.onboardingStatus,
      detailsSubmitted: a.detailsSubmitted,
      chargesEnabled: a.chargesEnabled,
      payoutsEnabled: a.payoutsEnabled,
      requirementsDue: a.requirementsDue,
      disabledReason: a.disabledReason,
      canSellPaidTickets: a.chargesEnabled,
      country: a.country,
      currency: a.defaultCurrency,
    };
  }
}
