import { Link } from '@/i18n/navigation';
import { BRAND_LINK } from '@/components/booking-brand';

/*
  The transactional SMS disclosure, WORD FOR WORD.

  This is the A2P 10DLC campaign's opt-in evidence: carriers compare what a person agreed to
  with what the campaign says they agreed to. It is therefore one component, shown unchanged at
  sign-up and on the Settings switch, in English, because that is the text that was registered.
  It names the sender, the purpose, frequency, rates, STOP and HELP, that consent is not a
  condition of purchase, and links the Terms and the Privacy Policy.
*/
export function SmsConsentStatement() {
  return (
    <>
      Send me transactional text messages from ETicketsGo about my bookings, tickets, event updates,
      cancellations, refunds, and account or service notifications. Message frequency varies.
      Message and data rates may apply. Reply{' '}
      <strong className="font-semibold text-brand-ink">STOP</strong> to opt out or{' '}
      <strong className="font-semibold text-brand-ink">HELP</strong> for help. Consent is not a
      condition of purchase.
    </>
  );
}

export function SmsConsentLinks() {
  return (
    <>
      See our{' '}
      <Link href="/terms" className={BRAND_LINK}>
        Terms &amp; Conditions
      </Link>{' '}
      and{' '}
      <Link href="/privacy" className={BRAND_LINK}>
        Privacy Policy
      </Link>
      .
    </>
  );
}
