import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

/** The public subscription material stored per browser (no secrets). */
export interface WebPushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** The payload a push carries to the service worker. */
export interface WebPushMessage {
  title: string;
  body: string;
  /** Deep link opened on notification click. */
  url?: string;
  tag?: string;
}

/** Result of a single dispatch, so the service can prune dead subscriptions. */
export interface WebPushResult {
  ok: boolean;
  /** True when the endpoint is permanently gone (HTTP 404/410) and should be deleted. */
  gone?: boolean;
}

/**
 * Provider abstraction for browser Web Push (mirrors the PaymentProvider /
 * PushTransport pattern). A real VAPID transport (self-hosted, no third party)
 * drops in behind this interface without touching callers.
 */
export interface WebPushDispatcher {
  readonly name: string;
  send(target: WebPushTarget, message: WebPushMessage): Promise<WebPushResult>;
}

/**
 * Default placeholder transport: records the intent to the log and reports success
 * without contacting any push service. Keeps the whole subscription → dispatch path
 * exercisable in every environment with zero external dependencies or credentials.
 */
export class LogWebPushDispatcher implements WebPushDispatcher {
  readonly name = 'log';
  private readonly logger = new Logger('WebPush');

  async send(target: WebPushTarget, message: WebPushMessage): Promise<WebPushResult> {
    this.logger.debug(
      `[web-push:log] "${message.title}" -> ${target.endpoint.slice(0, 48)}… (not delivered; placeholder)`,
    );
    return { ok: true };
  }
}

/**
 * Selects the Web Push transport by WEBPUSH_PROVIDER. Only 'log' is implemented
 * today; 'vapid' is reserved for a self-hosted VAPID transport and currently falls
 * back to the log placeholder (documented) so no external integration is shipped.
 */
export function selectWebPushDispatcher(config: ConfigService): WebPushDispatcher {
  const provider = config.get<string>('WEBPUSH_PROVIDER') ?? 'log';
  // 'vapid' intentionally not wired here — external delivery stays a placeholder.
  if (provider === 'vapid') {
    new Logger('WebPush').warn(
      'WEBPUSH_PROVIDER=vapid but no VAPID transport is wired; using the log placeholder.',
    );
  }
  return new LogWebPushDispatcher();
}

export const WEB_PUSH_DISPATCHER = Symbol('WEB_PUSH_DISPATCHER');
