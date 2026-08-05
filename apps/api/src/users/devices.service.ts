import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * Mobile push-device registry.
 *
 * Provider-neutral: the app sends a token and says who issued it. No APNs key, FCM
 * configuration or Expo credential exists in this repo, and none is invented here —
 * this is the storage and ownership half of push, which is the half that can be built
 * and tested without them. See apps/customer-mobile/docs/NOTIFICATIONS.md.
 *
 * ── TOKENS ARE SECRETS-ADJACENT ───────────────────────────────────────────────────
 * A push token lets its holder send a notification to that device. It is never logged
 * in full, never returned to a client in full, and never exposed on any list endpoint.
 * Everything user-facing uses `maskToken`.
 */
export interface RegisterDeviceInput {
  token: string;
  provider?: string;
  platform: string;
  appVersion?: string;
  locale?: string;
  timezone?: string;
  permissionStatus?: string;
}

export interface DeviceView {
  id: string;
  platform: string;
  provider: string;
  appVersion: string | null;
  locale: string | null;
  timezone: string | null;
  permissionStatus: string;
  disabled: boolean;
  lastSeenAt: string;
  createdAt: string;
  /** Last six characters only. Enough to recognise a device, useless for sending to it. */
  tokenPreview: string;
}

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register or refresh a device.
   *
   * Keyed on the TOKEN, not on the user, and that is what makes the awkward cases work:
   *
   *   - The same app reopening sends the same token → one row is updated, not a second
   *     created. Without this, a device accumulates a row per launch and the user gets
   *     one notification per row.
   *   - A phone that is signed out of account A and into account B sends the same token
   *     under a new user → the row is REASSIGNED. Leaving it on A would send A's booking
   *     notifications to a phone B is now holding, which is a privacy incident, not a
   *     duplicate-delivery annoyance.
   *   - Re-registering a token previously marked invalid clears `disabled`: the client
   *     just proved it is live.
   *
   * Naturally idempotent, so a retry after a dropped response is safe.
   */
  async register(userId: string, input: RegisterDeviceInput): Promise<DeviceView> {
    const now = new Date();
    const data = {
      userId,
      provider: input.provider ?? 'expo',
      platform: input.platform,
      appVersion: input.appVersion ?? null,
      locale: input.locale ?? null,
      timezone: input.timezone ?? null,
      permissionStatus: input.permissionStatus ?? 'undetermined',
      disabled: false,
      lastSeenAt: now,
    };

    const device = await this.prisma.userDevice.upsert({
      where: { token: input.token },
      create: { token: input.token, ...data },
      update: data,
    });

    // Identifier and platform only — never the token.
    this.logger.log(
      `device registered: user=${userId} device=${device.id} platform=${device.platform}`,
    );

    return toView(device);
  }

  /**
   * Update mutable facts about a device the caller owns.
   *
   * The token itself is NOT updatable. A new token is a new registration — allowing a
   * PATCH to rewrite it would let one request move a device row onto an arbitrary token
   * without proving the client holds it.
   */
  async update(
    userId: string,
    deviceId: string,
    patch: {
      appVersion?: string;
      locale?: string;
      timezone?: string;
      permissionStatus?: string;
      disabled?: boolean;
    },
  ): Promise<DeviceView> {
    await this.assertOwned(userId, deviceId);

    const device = await this.prisma.userDevice.update({
      where: { id: deviceId },
      data: { ...patch, lastSeenAt: new Date() },
    });

    return toView(device);
  }

  /**
   * Deregister a device. Called on logout.
   *
   * Idempotent: removing a device that is already gone is a success, because a client
   * retrying a logout must not be handed an error for work already done.
   */
  async remove(userId: string, deviceId: string): Promise<{ removed: boolean }> {
    // Scoped by userId in the WHERE clause rather than fetch-then-check, so a device id
    // belonging to someone else deletes nothing instead of racing.
    const result = await this.prisma.userDevice.deleteMany({ where: { id: deviceId, userId } });
    return { removed: result.count > 0 };
  }

  /** Deregister by token, for a logout that knows the token but not the row id. */
  async removeByToken(userId: string, token: string): Promise<{ removed: boolean }> {
    const result = await this.prisma.userDevice.deleteMany({ where: { token, userId } });
    return { removed: result.count > 0 };
  }

  /**
   * The caller's own devices.
   *
   * Scoped to the caller with no way to widen it — there is no id parameter and no
   * admin variant here, so the endpoint cannot be turned into a device enumerator.
   */
  async listMine(userId: string): Promise<DeviceView[]> {
    const devices = await this.prisma.userDevice.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });
    return devices.map(toView);
  }

  /**
   * Confirm the device exists AND belongs to the caller.
   *
   * Both cases raise the same 404. A distinct 403 for "exists but is not yours" would
   * confirm the existence of another user's device id to anyone probing.
   */
  private async assertOwned(userId: string, deviceId: string): Promise<void> {
    const device = await this.prisma.userDevice.findUnique({
      where: { id: deviceId },
      select: { userId: true },
    });
    if (!device || device.userId !== userId) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Device not found.', HttpStatus.NOT_FOUND);
    }
  }
}

/** Last six characters. Recognisable to the owner, useless to a sender. */
export function maskToken(token: string): string {
  return token.length <= 6 ? '******' : `…${token.slice(-6)}`;
}

function toView(device: {
  id: string;
  token: string;
  provider: string;
  platform: string;
  appVersion: string | null;
  locale: string | null;
  timezone: string | null;
  permissionStatus: string;
  disabled: boolean;
  lastSeenAt: Date;
  createdAt: Date;
}): DeviceView {
  return {
    id: device.id,
    platform: device.platform,
    provider: device.provider,
    appVersion: device.appVersion,
    locale: device.locale,
    timezone: device.timezone,
    permissionStatus: device.permissionStatus,
    disabled: device.disabled,
    lastSeenAt: device.lastSeenAt.toISOString(),
    createdAt: device.createdAt.toISOString(),
    tokenPreview: maskToken(device.token),
  };
}
