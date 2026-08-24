import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { RenderedNotification } from '../notification-channel.interface';
import { payloadPushTokens } from './recipient.util';

/** DI token for the push transport bound in notifications.module.ts. */
export const PUSH_TRANSPORT = Symbol('PUSH_TRANSPORT');

/** Which real/log transport `PUSH_PROVIDER` resolves to. */
export type PushProviderName = 'log' | 'fcm' | 'expo';

/**
 * An Expo push token, as `expo-notifications` issues it.
 *
 * The mobile app calls `getExpoPushTokenAsync`, so every row in `UserDevice` looks like
 * `ExponentPushToken[xxxxxxxx]` — NOT an FCM registration id. Sending one to FCM is a
 * guaranteed `messaging/invalid-argument`, which is why the transport has to match the
 * token the app actually produces.
 */
export const isExpoPushToken = (token: string): boolean =>
  /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token);

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
    case 'expo':
      return new ExpoPushTransport(config);
    case 'log':
    default:
      return new PushLogTransport();
  }
}

/**
 * Expo Push transport.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────
 * The mobile app registers with `getExpoPushTokenAsync`, so every stored token is an
 * `ExponentPushToken[...]`. The only real transport was FCM, which cannot deliver to one:
 * devices registered, tokens were stored, and no push could ever have arrived. Registration
 * succeeding is what made it look finished.
 *
 * Expo's service needs NO credentials for ordinary sends — the token itself authorises
 * delivery to that installation. `EXPO_ACCESS_TOKEN` is optional and only required once
 * "enhanced security for push notifications" is switched on in the Expo dashboard; it is
 * sent when present so enabling that setting later needs no code change.
 *
 * Expo caps a request at 100 messages, so sends are chunked. A per-ticket error is logged
 * rather than thrown — one dead installation among fifty must not fail the whole
 * notification and trigger a retry that re-sends to the other forty-nine.
 */
export class ExpoPushTransport implements PushTransport {
  private readonly logger = new Logger('Notification');
  private static readonly ENDPOINT = 'https://exp.host/--/api/v2/push/send';
  private static readonly CHUNK = 100;

  constructor(private readonly config: ConfigService) {}

  async send(msg: RenderedNotification): Promise<void> {
    const tokens = payloadPushTokens(msg).filter(isExpoPushToken);
    if (tokens.length === 0) {
      this.logger.warn(`[push:${msg.type}] no Expo device token; skipping`);
      return;
    }

    const accessToken = this.config.get<string>('EXPO_ACCESS_TOKEN');
    for (let i = 0; i < tokens.length; i += ExpoPushTransport.CHUNK) {
      const chunk = tokens.slice(i, i + ExpoPushTransport.CHUNK);
      const res = await fetch(ExpoPushTransport.ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(
          chunk.map((to) => ({
            to,
            title: msg.subject,
            body: msg.body,
            // The app routes on `type`; anything else travels as opaque data.
            data: { type: msg.type, ...(msg.payload ?? {}) },
          })),
        ),
      });

      if (!res.ok) {
        // A transport-level failure (auth, outage) SHOULD retry, so it throws.
        throw new Error(`Expo push failed: HTTP ${res.status}`);
      }

      const body = (await res.json()) as { data?: { status: string; message?: string }[] };
      const failures = (body.data ?? []).filter((t) => t.status !== 'ok');
      if (failures.length > 0) {
        // Per-device problems — an uninstalled app, a token from another project. Logged,
        // not thrown: retrying would re-deliver to every healthy device in the batch.
        this.logger.warn(
          `[push:${msg.type}] ${failures.length}/${chunk.length} Expo deliveries rejected` +
            (failures[0]?.message ? `: ${failures[0].message}` : ''),
        );
      }
    }
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
