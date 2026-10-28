import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role, type ConnectOnboardingStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';
import { PaymentProviderResolver } from '../provider/payment-provider.resolver';
import { payoutCountryFor } from '../connect/payout-country';
import { razorpayLinkFailure, razorpayNotConfigured } from './razorpay-link-failure';

const PROVIDER = 'razorpay';
const MANAGE_ROLES = [Role.ORGANIZER_OWNER];
const VIEW_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

export interface RazorpayAccountStatus {
  organizationId: string;
  provider: 'razorpay';
  hasAccount: boolean;
  linkedAccountId: string | null;
  onboardingStatus: ConnectOnboardingStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[];
  routeEnabled: boolean;
  /** Organizer may be paid out via Route only when Route is enabled AND the account is active. */
  payoutReady: boolean;
  country: string;
  currency: string;
}

/**
 * Organizer India (Razorpay Route) payment account. Razorpay Linked Account creation +
 * KYC is a Razorpay Dashboard/partner flow (not fully API-onboardable for this account
 * configuration), so the organizer LINKS a dashboard-created linked-account id here and we
 * sync its activation state. Reuses OrganizerPaymentAccount (provider='razorpay'). Route
 * being enabled is required before any payout can actually execute (see SettlementService).
 */
@Injectable()
export class RazorpayConnectService {
  private readonly logger = new Logger(RazorpayConnectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly resolver: PaymentProviderResolver,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private routeEnabled(): boolean {
    return this.config.get<boolean>('RAZORPAY_ROUTE_ENABLED') ?? false;
  }

  /** Link a Razorpay Linked Account id (created via the Razorpay dashboard) + sync status. */
  async linkAccount(
    user: RequestUser,
    organizationId: string,
    linkedAccountId: string,
  ): Promise<RazorpayAccountStatus> {
    await this.access.assertMember(user, organizationId, MANAGE_ROLES);
    /*
      Razorpay Route pays out to Indian organizations only. Without this a US organization,
      or one with no country recorded, reached Razorpay and was refused there (as a 500).
    */
    await payoutCountryFor(this.prisma, organizationId, 'razorpay');
    linkedAccountId = linkedAccountId.trim();
    // Refuse early so a taken id costs no provider call; re-checked under a lock below.
    await this.assertNotOwnedByAnother(this.prisma, user, organizationId, linkedAccountId);
    let snapshot: Awaited<ReturnType<RazorpayConnectService['fetchSnapshot']>>;
    try {
      snapshot = await this.fetchSnapshot(linkedAccountId);
    } catch (err) {
      // Was uncaught: every Razorpay refusal, a mistyped acc_ id included, became a 500.
      throw razorpayLinkFailure(err, this.logger);
    }

    const account = await this.prisma.$transaction(async (tx) => {
      /*
        Two organizations linking the same id at the same moment would both pass a plain
        read-then-write check. A transaction-scoped advisory lock keyed on the id serialises
        them, so the loser sees the winner's row. (A partial unique index would be the real
        guarantee; it is held back until existing data is known to be clean - see the PR.)
      */
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`razorpay-linked:${linkedAccountId}`}))`;
      await this.assertNotOwnedByAnother(tx, user, organizationId, linkedAccountId);
      return tx.organizerPaymentAccount.upsert({
        where: { organizationId_provider: { organizationId, provider: PROVIDER } },
        create: {
          organizationId,
          provider: PROVIDER,
          providerAccountId: linkedAccountId,
          accountType: 'route_linked',
          onboardingStatus: snapshot.onboardingStatus,
          detailsSubmitted: snapshot.detailsSubmitted,
          chargesEnabled: snapshot.chargesEnabled,
          payoutsEnabled: snapshot.payoutsEnabled,
          requirementsDue: snapshot.requirementsDue,
          country: 'IN',
          defaultCurrency: 'inr',
        },
        update: {
          providerAccountId: linkedAccountId,
          onboardingStatus: snapshot.onboardingStatus,
          detailsSubmitted: snapshot.detailsSubmitted,
          chargesEnabled: snapshot.chargesEnabled,
          payoutsEnabled: snapshot.payoutsEnabled,
          requirementsDue: snapshot.requirementsDue,
        },
      });
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId,
      action: 'RAZORPAY_ACCOUNT_LINKED',
      entityType: 'OrganizerPaymentAccount',
      entityId: account.id,
      metadata: { linkedAccountId },
    });
    return this.toStatus(account);
  }

  /**
   * A Razorpay linked account is one legal entity's payee. It belongs to exactly one
   * organization: settlements pay out to it, and the webhook maps an account event back
   * to its owner by id (`findFirst`), so a shared id would pay, or report on, the wrong
   * organization. Re-saving an organization's own id is fine.
   */
  private async assertNotOwnedByAnother(
    db: Pick<PrismaService, 'organizerPaymentAccount'>,
    user: RequestUser,
    organizationId: string,
    linkedAccountId: string,
  ): Promise<void> {
    const owner = await db.organizerPaymentAccount.findFirst({
      where: {
        provider: PROVIDER,
        providerAccountId: linkedAccountId,
        organizationId: { not: organizationId },
      },
      select: { id: true, organizationId: true },
    });
    if (!owner) return;
    // The refusal is evidence; it names the owner for staff, never in the response.
    await this.audit.record({
      actorUserId: user.id,
      organizationId,
      action: 'RAZORPAY_ACCOUNT_LINK_REFUSED',
      entityType: 'OrganizerPaymentAccount',
      entityId: owner.id,
      metadata: { linkedAccountId, ownedByOrganizationId: owner.organizationId },
    });
    throw new AppException(
      ErrorCodes.CONFLICT,
      'This Razorpay linked account is already connected to another organization.',
      HttpStatus.CONFLICT,
    );
  }

  async getStatus(user: RequestUser, organizationId: string): Promise<RazorpayAccountStatus> {
    await this.access.assertMember(user, organizationId, VIEW_ROLES);
    const account = await this.prisma.organizerPaymentAccount.findUnique({
      where: { organizationId_provider: { organizationId, provider: PROVIDER } },
    });
    if (!account?.providerAccountId) return this.empty(organizationId);
    // Best-effort live refresh.
    try {
      const snapshot = await this.fetchSnapshot(account.providerAccountId);
      const updated = await this.prisma.organizerPaymentAccount.update({
        where: { id: account.id },
        data: {
          onboardingStatus: snapshot.onboardingStatus,
          detailsSubmitted: snapshot.detailsSubmitted,
          chargesEnabled: snapshot.chargesEnabled,
          payoutsEnabled: snapshot.payoutsEnabled,
          requirementsDue: snapshot.requirementsDue,
        },
      });
      return this.toStatus(updated);
    } catch {
      return this.toStatus(account);
    }
  }

  private async fetchSnapshot(linkedAccountId: string) {
    const provider = this.resolver.get(PROVIDER);
    if (!provider.getConnectedAccount) {
      // The not-activated stand-in: this server cannot use Razorpay, which no retry changes.
      this.logger.error(`The ${provider.name} adapter on this server has no linked accounts.`);
      throw razorpayNotConfigured();
    }
    const s = await provider.getConnectedAccount(linkedAccountId);
    const onboardingStatus: ConnectOnboardingStatus = s.disabledReason
      ? 'DISABLED'
      : s.chargesEnabled
        ? s.requirementsCurrentlyDue.length > 0
          ? 'RESTRICTED'
          : 'ENABLED'
        : s.detailsSubmitted
          ? 'PENDING_VERIFICATION'
          : 'ONBOARDING';
    return {
      onboardingStatus,
      detailsSubmitted: s.detailsSubmitted,
      chargesEnabled: s.chargesEnabled,
      payoutsEnabled: s.payoutsEnabled,
      requirementsDue: s.requirementsCurrentlyDue,
    };
  }

  private empty(organizationId: string): RazorpayAccountStatus {
    return {
      organizationId,
      provider: PROVIDER,
      hasAccount: false,
      linkedAccountId: null,
      onboardingStatus: 'NOT_STARTED',
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsDue: [],
      routeEnabled: this.routeEnabled(),
      payoutReady: false,
      country: 'IN',
      currency: 'inr',
    };
  }

  private toStatus(a: {
    organizationId: string;
    providerAccountId: string | null;
    onboardingStatus: ConnectOnboardingStatus;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    requirementsDue: string[];
  }): RazorpayAccountStatus {
    const routeEnabled = this.routeEnabled();
    return {
      organizationId: a.organizationId,
      provider: PROVIDER,
      hasAccount: Boolean(a.providerAccountId),
      linkedAccountId: a.providerAccountId,
      onboardingStatus: a.onboardingStatus,
      chargesEnabled: a.chargesEnabled,
      payoutsEnabled: a.payoutsEnabled,
      requirementsDue: a.requirementsDue,
      routeEnabled,
      payoutReady: routeEnabled && a.payoutsEnabled,
      country: 'IN',
      currency: 'inr',
    };
  }
}
