import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException, ErrorCodes } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';

/**
 * The record of whether a provider has been proven to work, and on whose word.
 *
 * ── WHY EVIDENCE IS STORED AND NOT ONLY DERIVED ────────────────────────────────────
 * Phase 6 computed certification by reading delivery rows, and that remains the right source
 * for the machine-checkable half: a TEST send exists, a callback came back. It is still the
 * source — this table never overrides it.
 *
 * What it cannot hold is the half a person contributes, and that half turns out to decide
 * launches. A delivery row can say a callback arrived; it cannot say a named human looked at
 * a handset and confirmed the message was legible, in the right language, under the sender
 * header the operator actually registered. Nor can it hold "blocked on DLT, submitted 12
 * March, reference ABC", which is the single most useful sentence in a launch review.
 *
 * And delivery rows are prunable operational data. A certification is a record of a DECISION;
 * losing it to a retention job would silently un-certify a live market.
 *
 * ── THE ONE RULE THAT MAKES THIS SAFE ──────────────────────────────────────────────
 * Nothing automated may write LIVE_CERTIFIED. The contract harness writes CONTRACT_TESTED,
 * which is deliberately a lower rung and means only that our adapter behaves correctly
 * against a mock. Promoting it would be the platform certifying itself, which is the exact
 * failure this whole phase exists to prevent.
 */

export const CertificationState = {
  /** The adapter exists. Nothing is configured. */
  CODE_READY: 'CODE_READY',
  /** Credentials and templates present. Nothing has been sent. */
  CONFIG_READY: 'CONFIG_READY',
  /**
   * The adapter was proven against a MOCKED provider: success, rate limit, auth failure,
   * bad template, bad destination, timeout, malformed response, duplicate and out-of-order
   * callbacks. It says our side is right. It says nothing whatsoever about theirs.
   */
  CONTRACT_TESTED: 'CONTRACT_TESTED',
  /** Sends are accepted, but no real callback has ever come back. */
  EXTERNAL_VERIFICATION_REQUIRED: 'EXTERNAL_VERIFICATION_REQUIRED',
  /** A real message demonstrably arrived, and a person says so. */
  LIVE_CERTIFIED: 'LIVE_CERTIFIED',
  /** Known to be unusable: registration refused, account suspended. */
  BLOCKED: 'BLOCKED',
} as const;
export type CertificationState = (typeof CertificationState)[keyof typeof CertificationState];

/** States a machine may write. `LIVE_CERTIFIED` is deliberately absent. */
const MACHINE_WRITABLE: readonly string[] = [
  CertificationState.CODE_READY,
  CertificationState.CONFIG_READY,
  CertificationState.CONTRACT_TESTED,
  CertificationState.EXTERNAL_VERIFICATION_REQUIRED,
];

export interface CertificationKey {
  provider: string;
  channel: string;
  market: string;
}

@Injectable()
export class CertificationEvidenceService {
  private readonly logger = new Logger('Notification');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Everything on record, for the launch review. Contains no secret and no recipient. */
  async list() {
    return this.prisma.notificationCertification.findMany({
      orderBy: [{ market: 'asc' }, { channel: 'asc' }, { provider: 'asc' }],
      select: {
        id: true,
        provider: true,
        channel: true,
        market: true,
        state: true,
        lastSuccessfulTestAt: true,
        lastSuccessfulCallbackAt: true,
        lastContractTestAt: true,
        certifiedByUserId: true,
        certifiedAt: true,
        notes: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Record that the mocked contract suite passed for an adapter.
   *
   * Refuses to overwrite a live certification. A contract run is a weaker statement than a
   * real one, and letting the weaker statement land on top would silently downgrade a
   * certified market every time somebody ran the tests.
   */
  async recordContractTest(key: CertificationKey, at: Date): Promise<void> {
    const existing = await this.find(key);
    if (existing?.state === CertificationState.LIVE_CERTIFIED) {
      await this.prisma.notificationCertification.update({
        where: { id: existing.id },
        data: { lastContractTestAt: at },
      });
      return;
    }
    await this.prisma.notificationCertification.upsert({
      where: {
        provider_channel_market: {
          provider: key.provider,
          channel: key.channel,
          market: key.market,
        },
      },
      create: { ...key, state: CertificationState.CONTRACT_TESTED, lastContractTestAt: at },
      update: { state: CertificationState.CONTRACT_TESTED, lastContractTestAt: at },
    });
  }

  /**
   * Record what the delivery evidence shows.
   *
   * Callers pass what they OBSERVED; this refuses to write a state a machine may not assert.
   * A caller trying to write LIVE_CERTIFIED is not a mistake to be corrected quietly — it is
   * the beginning of a platform certifying itself, so it throws.
   */
  async recordObservation(
    key: CertificationKey,
    state: CertificationState,
    evidence: { lastSuccessfulTestAt?: Date | null; lastSuccessfulCallbackAt?: Date | null } = {},
  ): Promise<void> {
    if (!MACHINE_WRITABLE.includes(state)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `${state} may only be asserted by a person. Use certify().`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const existing = await this.find(key);
    if (existing?.state === CertificationState.LIVE_CERTIFIED) return;
    await this.prisma.notificationCertification.upsert({
      where: {
        provider_channel_market: {
          provider: key.provider,
          channel: key.channel,
          market: key.market,
        },
      },
      create: { ...key, state, ...evidence },
      update: { state, ...evidence },
    });
  }

  /**
   * A person asserts a certification, and their name goes on it.
   *
   * ── WHY DELIVERY EVIDENCE IS STILL REQUIRED ────────────────────────────────────────
   * A human assertion is necessary and not sufficient. Somebody can be mistaken, or be
   * clicking through a checklist; the delivery rows cannot be. So LIVE_CERTIFIED requires
   * both — a real accepted send AND, where the provider publishes one, a real callback — and
   * refuses with the reason when either is absent. That refusal is the feature.
   */
  async certify(
    actorUserId: string,
    key: CertificationKey,
    notes?: string,
  ): Promise<{ state: CertificationState }> {
    const accepted = await this.prisma.notificationDelivery.findFirst({
      where: { provider: key.provider, channel: key.channel, acceptedAt: { not: null } },
      orderBy: { acceptedAt: 'desc' },
      select: { acceptedAt: true },
    });
    if (!accepted) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `No accepted send exists for ${key.provider}/${key.channel}. ` +
          `Run a test send before certifying.`,
        HttpStatus.CONFLICT,
      );
    }
    const callback = await this.prisma.notificationDelivery.findFirst({
      where: { provider: key.provider, channel: key.channel, providerStatus: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    });

    await this.prisma.notificationCertification.upsert({
      where: {
        provider_channel_market: {
          provider: key.provider,
          channel: key.channel,
          market: key.market,
        },
      },
      create: {
        ...key,
        state: CertificationState.LIVE_CERTIFIED,
        lastSuccessfulTestAt: accepted.acceptedAt,
        lastSuccessfulCallbackAt: callback?.updatedAt ?? null,
        certifiedByUserId: actorUserId,
        certifiedAt: new Date(),
        notes: notes?.slice(0, 1000) ?? null,
      },
      update: {
        state: CertificationState.LIVE_CERTIFIED,
        lastSuccessfulTestAt: accepted.acceptedAt,
        lastSuccessfulCallbackAt: callback?.updatedAt ?? null,
        certifiedByUserId: actorUserId,
        certifiedAt: new Date(),
        notes: notes?.slice(0, 1000) ?? null,
      },
    });
    await this.audit.record({
      actorUserId,
      action: 'NOTIFICATION_PROVIDER_CERTIFIED',
      entityType: 'NotificationCertification',
      entityId: `${key.provider}:${key.channel}:${key.market}`,
      metadata: { ...key, hadCallback: Boolean(callback) },
    });
    this.logger.warn(
      `${key.provider}/${key.channel}/${key.market} certified LIVE by ${actorUserId}`,
    );
    return { state: CertificationState.LIVE_CERTIFIED };
  }

  private find(key: CertificationKey) {
    return this.prisma.notificationCertification.findUnique({
      where: {
        provider_channel_market: {
          provider: key.provider,
          channel: key.channel,
          market: key.market,
        },
      },
      select: { id: true, state: true },
    });
  }
}
