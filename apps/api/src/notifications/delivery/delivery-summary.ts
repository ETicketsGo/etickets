import { DeliveryState, NotificationStatus, OutcomeClass } from '@eticketsgo/shared-types';

/**
 * What happened to one notification, in the words an operator acts on.
 *
 * -- WHY THIS IS DERIVED AT READ TIME ---------------------------------------------
 * The stored statuses were not truthful for long enough that history is full of rows that
 * say SENT about messages that went nowhere: WhatsApp skips with provider `none` and reason
 * `no_destination`, and every email and push the `log` transport printed. The write path now
 * records SKIPPED and LOGGED, but those rows stay as they were written -- nothing rewrites
 * production history -- so the honest answer has to be worked out from all the facts on the
 * row each time it is read. One function does it, so the search list and the detail view
 * cannot disagree.
 *
 * `delivered` is three-valued on purpose. `null` means nobody has told us either way -- an
 * email SES accepted and has not reported on, a push (which can never report) -- and folding
 * that into yes or no is exactly the kind of claim this exists to stop.
 */
export const DeliveryVerdict = {
  DELIVERED: 'DELIVERED',
  IN_APP: 'IN_APP',
  ACCEPTED: 'ACCEPTED',
  NOT_DELIVERED: 'NOT_DELIVERED',
  NOT_SENT: 'NOT_SENT',
  LOG_ONLY: 'LOG_ONLY',
  IN_PROGRESS: 'IN_PROGRESS',
  CANCELLED: 'CANCELLED',
} as const;
export type DeliveryVerdict = (typeof DeliveryVerdict)[keyof typeof DeliveryVerdict];

export interface DeliverySummary {
  verdict: DeliveryVerdict;
  /** true = it reached the person, false = it did not, null = not known. */
  delivered: boolean | null;
  /** One plain sentence. ASCII, no codes. */
  label: string;
}

export interface DeliveryFacts {
  channel: string;
  status: string;
  /** The notification's own provider column (null on rows older than it). */
  provider?: string | null;
  lastError?: string | null;
  /** The most recent attempt, when there is one. */
  latest?: {
    status: string;
    provider?: string | null;
    outcomeClass?: string | null;
  } | null;
}

/** Why nothing was sent, from the reason codes the channels and the sweep record. */
const SKIP_REASONS: Record<string, string> = {
  no_destination: 'there is no phone number on the account',
  no_deliverable_email: 'there is no email address on the account',
  no_device: 'the person has no device signed in to the app',
  destination_suppressed:
    'this address or number is blocked after a bounce, a spam report or an opt-out',
};

const CHANNEL_NAME: Record<string, string> = {
  email: 'email',
  sms: 'text message',
  whatsapp: 'WhatsApp message',
  push: 'push notification',
  in_app: 'in-app message',
};

export function summariseDelivery(facts: DeliveryFacts): DeliverySummary {
  const latest = facts.latest ?? null;
  const what = CHANNEL_NAME[facts.channel] ?? 'message';
  const providerOf = latest?.provider ?? facts.provider ?? null;
  const carrier = providerOf && providerOf !== 'pending' ? providerOf : 'the provider';

  if (facts.status === NotificationStatus.CANCELLED) {
    return { verdict: 'CANCELLED', delivered: false, label: 'Cancelled before it was sent.' };
  }
  if (
    facts.status === NotificationStatus.PENDING ||
    facts.status === NotificationStatus.SCHEDULED ||
    latest?.status === DeliveryState.ATTEMPTING
  ) {
    return {
      verdict: 'IN_PROGRESS',
      delivered: null,
      label:
        facts.status === NotificationStatus.SCHEDULED
          ? 'Scheduled. Not sent yet.'
          : 'Waiting to be sent.',
    };
  }

  // Log mode, whatever the row's status says: older rows recorded these as SENT.
  if (
    facts.status === NotificationStatus.LOGGED ||
    latest?.status === DeliveryState.LOGGED ||
    providerOf === 'log'
  ) {
    return {
      verdict: 'LOG_ONLY',
      delivered: false,
      label: `Not delivered. No ${what} provider is set up here, so it was only written to the server log.`,
    };
  }

  // A skip, whatever the row's status says: older rows recorded these as SENT as well.
  const skipped =
    facts.status === NotificationStatus.SKIPPED ||
    latest?.status === DeliveryState.SKIPPED ||
    latest?.outcomeClass === OutcomeClass.NO_DESTINATION ||
    latest?.outcomeClass === OutcomeClass.POLICY_SUPPRESSED ||
    facts.lastError === 'destination_suppressed' ||
    (facts.status === NotificationStatus.SENT && providerOf === 'none');
  if (skipped) {
    const why = (facts.lastError && SKIP_REASONS[facts.lastError]) || null;
    return {
      verdict: 'NOT_SENT',
      delivered: false,
      label: why ? `Not sent, because ${why}.` : 'Not sent. There was nowhere to send it.',
    };
  }

  if (facts.channel === 'in_app' && facts.status === NotificationStatus.SENT) {
    return { verdict: 'IN_APP', delivered: true, label: 'In the inbox in the app.' };
  }

  switch (latest?.status) {
    case DeliveryState.DELIVERED:
      return { verdict: 'DELIVERED', delivered: true, label: `Delivered by ${carrier}.` };
    case DeliveryState.READ:
      return { verdict: 'DELIVERED', delivered: true, label: 'Delivered and read.' };
    case DeliveryState.COMPLAINED:
      return {
        verdict: 'DELIVERED',
        delivered: true,
        label: 'Delivered, then reported as spam by the person.',
      };
    case DeliveryState.BOUNCED:
      return {
        verdict: 'NOT_DELIVERED',
        delivered: false,
        label: 'Not delivered. The address does not accept mail.',
      };
    case DeliveryState.UNDELIVERED:
      return {
        verdict: 'NOT_DELIVERED',
        delivered: false,
        label: `Not delivered. It was accepted by ${carrier} but could not be delivered.`,
      };
    case DeliveryState.REJECTED:
      return {
        verdict: 'NOT_DELIVERED',
        delivered: false,
        label: `Not delivered. It was refused by ${carrier}.`,
      };
  }

  if (facts.status === NotificationStatus.FAILED) {
    return {
      verdict: 'NOT_DELIVERED',
      delivered: false,
      label: 'Not delivered. The send failed. See the attempts for the reason.',
    };
  }

  if (facts.status === NotificationStatus.SENT && latest?.status === DeliveryState.ACCEPTED) {
    return {
      verdict: 'ACCEPTED',
      delivered: null,
      label:
        facts.channel === 'push'
          ? `Accepted by ${carrier}. Push services do not report delivery.`
          : `Accepted by ${carrier}. No delivery report yet.`,
    };
  }

  // SENT with no attempt on record: written before attempts were recorded.
  return {
    verdict: 'ACCEPTED',
    delivered: null,
    label: 'Recorded as sent before delivery tracking existed. Delivery is not known.',
  };
}
