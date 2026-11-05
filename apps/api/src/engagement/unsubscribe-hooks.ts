import { Injectable, Logger } from '@nestjs/common';

/** What happened, without the address: a hash, the scope and the organizer. */
export interface UnsubscribedEvent {
  scope: 'global' | 'organizer';
  organizationId: string | null;
  /** `SuppressionService.hash('email', address)`. */
  emailHash: string;
  userId: string | null;
  oneClick: boolean;
  at: Date;
}

export interface UnsubscribeListener {
  onUnsubscribed(event: UnsubscribedEvent): Promise<void>;
}

/**
 * Who else wants to know that somebody unsubscribed.
 *
 * The unsubscribe itself (consent withdrawal, organizer suppression) is complete and committed
 * before any listener runs, and a listener that throws is logged and ignored: reporting an
 * unsubscribe in a campaign's stats must never be able to undo it. Registered at start-up by
 * the module that cares (campaigns), so engagement does not depend on campaigns.
 */
@Injectable()
export class UnsubscribeHooks {
  private readonly logger = new Logger('Unsubscribe');
  private readonly listeners: UnsubscribeListener[] = [];

  register(listener: UnsubscribeListener): void {
    if (!this.listeners.includes(listener)) this.listeners.push(listener);
  }

  async emit(event: UnsubscribedEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener.onUnsubscribed(event);
      } catch (err) {
        this.logger.warn(`unsubscribe listener failed: ${(err as Error)?.name ?? 'Error'}`);
      }
    }
  }
}
