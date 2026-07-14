import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { RenderedNotification } from '../notification-channel.interface';
import { payloadPushTokens } from './recipient.util';

/** DI token for the push transport bound in notifications.module.ts. */
export const PUSH_TRANSPORT = Symbol('PUSH_TRANSPORT');

/** Which real/log transport `PUSH_PROVIDER` resolves to. */
export type PushProviderName = 'log' | 'fcm';

/** A single push-send transport. */
export interface PushTransport {
  send(msg: RenderedNotification): Promise<void>;
}

/**
 * Default transport — logs locally, reproducing the original PushChannel log so
 * existing tests/e2e are unaffected.
 */
export class PushLogTransport implements PushTransport {
  private readonly logger = new Logger('Notification');

  async send(msg: RenderedNotification): Promise<void> {
    this.logger.log(`[push:${msg.type}] -> user ${msg.userId ?? 'n/a'} :: ${msg.subject}`);
  }
}

/**
 * Firebase Cloud Messaging transport (`firebase-admin`). Requires FCM_PROJECT_ID,
 * FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY (service-account fields). The recipient
 * token(s) come from `payload.pushToken` / `payload.pushTokens`; when absent the
 * send is skipped (warn + return). Delivery errors propagate so retry works.
 */
export class FcmPushTransport implements PushTransport {
  private readonly logger = new Logger('Notification');
  private readonly messaging: Messaging;

  constructor(config: ConfigService) {
    const projectId = requireKey(config, 'FCM_PROJECT_ID');
    const clientEmail = requireKey(config, 'FCM_CLIENT_EMAIL');
    // Env-encoded private keys usually carry literal "\n"; restore real newlines.
    const privateKey = requireKey(config, 'FCM_PRIVATE_KEY').replace(/\\n/g, '\n');

    // Use a uniquely-named app so this never collides with any other
    // firebase-admin initialization in the process, and reuse it if present.
    const appName = 'eticketsgo-notifications';
    const existing = getApps().find((a) => a.name === appName);
    const app =
      existing ??
      initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) }, appName);
    this.messaging = getMessaging(app);
  }

  async send(msg: RenderedNotification): Promise<void> {
    const tokens = payloadPushTokens(msg);
    if (tokens.length === 0) {
      this.logger.warn(
        `[push:${msg.type}] no push recipient (payload.pushToken(s) missing) -> skipped for user ${
          msg.userId ?? 'n/a'
        }`,
      );
      return;
    }
    const notification = { title: msg.subject, body: msg.body };
    if (tokens.length === 1) {
      await this.messaging.send({ token: tokens[0], notification });
      return;
    }
    const result = await this.messaging.sendEachForMulticast({ tokens, notification });
    if (result.failureCount > 0) {
      const firstError = result.responses.find((r) => !r.success)?.error ?? undefined;
      throw new Error(
        `FCM multicast: ${result.failureCount}/${tokens.length} deliveries failed` +
          (firstError ? `: ${firstError.message}` : ''),
      );
    }
  }
}

/**
 * Resolves the active push transport from PUSH_PROVIDER (default `log`). Only the
 * selected provider is constructed; a selected provider with missing keys fails
 * fast at construction.
 */
export function selectPushTransport(config: ConfigService): PushTransport {
  const name = config.get<PushProviderName>('PUSH_PROVIDER') ?? 'log';
  switch (name) {
    case 'fcm':
      return new FcmPushTransport(config);
    case 'log':
    default:
      return new PushLogTransport();
  }
}

function requireKey(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new Error(
      `PUSH_PROVIDER=fcm requires ${key} to be set. ` +
        `Provide the Firebase service-account fields for your project.`,
    );
  }
  return value;
}
