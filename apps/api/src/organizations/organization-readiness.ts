/**
 * What an organizer still has to tell us, and what each gap costs them.
 *
 * ── WHY THIS IS ONE LIST AND NOT A SCREEN'S OPINION ────────────────────────────────
 * The facts the platform needs are checked in four different places - approval, tax
 * invoicing, payouts and the seller identity card - and each of them phrased the gap its own
 * way or not at all. An organizer saw "Complete" on one screen and an admin saw a warning on
 * another, and nobody could answer "what do I still have to do".
 *
 * So the gaps are computed once, here, from the organization row. Both consoles read the
 * same list: the organizer's dashboard shows it as their own to-do, and the admin's
 * organizer page shows it as what to chase. A pure function, so it needs no database and can
 * be tested as arithmetic.
 *
 * ── EVERY ITEM SAYS WHAT IT COSTS ──────────────────────────────────────────────────
 * "Add your address" is a chore. "Without it your buyers get plain receipts instead of tax
 * invoices" is a reason. The second is what makes somebody do it, and it is also the honest
 * statement: none of these block an organizer from selling today, and pretending otherwise
 * to force completion would be a lie the product tells.
 */
export type ReadinessSeverity = 'BLOCKING' | 'IMPORTANT' | 'SUGGESTED';

export interface ReadinessItem {
  /** Stable id, so a console can link to the right screen without matching on prose. */
  key: string;
  severity: ReadinessSeverity;
  /** What is missing, in the organizer's words. */
  title: string;
  /** What it costs them until it is done. Never "this is required" with no reason. */
  consequence: string;
  /** Where to fix it, relative to the organizer console. */
  fixPath: string;
}

export interface ReadinessInput {
  status?: string | null;
  legalName?: string | null;
  legalEntityType?: string | null;
  registeredCountry?: string | null;
  registeredAddressLine1?: string | null;
  registeredCity?: string | null;
  taxRegistrationNumber?: string | null;
  financeContactEmail?: string | null;
  grievanceOfficerName?: string | null;
  grievanceOfficerEmail?: string | null;
  contactEmail?: string | null;
  /** Whether a bank account is on file for any currency. */
  hasPayoutAccount?: boolean;
  /** Whether anybody here has checked that account. */
  payoutAccountVerified?: boolean;
  logoUrl?: string | null;
  description?: string | null;
}

const blank = (value?: string | null) => !value || !value.trim();

export function organizationReadiness(org: ReadinessInput): ReadinessItem[] {
  const items: ReadinessItem[] = [];

  /*
    ── BLOCKING: the organizer cannot be paid, or cannot be approved ────────────────
    These are the ones where something they expect to happen will not happen.
  */
  if (!org.hasPayoutAccount) {
    items.push({
      key: 'payout-account',
      severity: 'BLOCKING',
      title: 'Add the bank account your money is sent to',
      consequence: 'Your settlements cannot be paid until we know where to send them.',
      fixPath: '/organizer/payouts',
    });
  }

  if (blank(org.legalName) || blank(org.legalEntityType) || blank(org.registeredCountry)) {
    items.push({
      key: 'legal-identity',
      severity: org.status === 'APPROVED' ? 'IMPORTANT' : 'BLOCKING',
      title: 'Say who you legally are',
      consequence:
        org.status === 'APPROVED'
          ? 'Your registered name and legal form appear on every document your buyers receive.'
          : 'The platform cannot approve you until it knows your registered name, legal form and country.',
      fixPath: '/organizer/settings',
    });
  }

  /*
    ── IMPORTANT: something the buyer or an authority will ask for ──────────────────
  */
  if (blank(org.registeredAddressLine1) || blank(org.registeredCity)) {
    items.push({
      key: 'registered-address',
      severity: 'IMPORTANT',
      title: 'Add your registered address',
      consequence:
        'An invoice has to carry the seller address. Without it, documents stay receipts.',
      fixPath: '/organizer/settings',
    });
  }

  if (blank(org.financeContactEmail)) {
    items.push({
      key: 'finance-contact',
      severity: 'IMPORTANT',
      title: 'Add a finance contact',
      consequence: 'Whoever we write to about a payout, a refund or a tax question.',
      fixPath: '/organizer/settings',
    });
  }

  /*
    ── WHY A COMPLAINTS CONTACT IS IMPORTANT AND NOT SUGGESTED ──────────────────────
    It is the one item here that somebody outside the platform can require. India's e-commerce
    rules make a named, contactable grievance officer a condition of selling to the public, and
    the other markets expect the substance of it. Not BLOCKING, because refusing to let an
    existing organizer sell over a form field would be the platform inventing an enforcement
    nobody asked it for - but it is chased, and an admin sees the same gap.
  */
  if (blank(org.grievanceOfficerName) || blank(org.grievanceOfficerEmail)) {
    items.push({
      key: 'grievance-officer',
      severity: 'IMPORTANT',
      title: 'Name who answers a customer complaint',
      consequence:
        'A marketplace has to be able to say who handles a complaint about you and how to reach them. Without it, complaints come to us and we cannot pass them on.',
      fixPath: '/organizer/settings',
    });
  }

  if (blank(org.contactEmail)) {
    items.push({
      key: 'support-contact',
      severity: 'IMPORTANT',
      title: 'Add a support email for your customers',
      consequence:
        'Ticket holders are shown this address when they need to reach you about an event.',
      fixPath: '/organizer/settings',
    });
  }

  if (org.hasPayoutAccount && !org.payoutAccountVerified) {
    items.push({
      key: 'payout-account-unverified',
      severity: 'IMPORTANT',
      title: 'Your bank account has not been checked yet',
      consequence:
        'We verify it before the first transfer. Nothing is needed from you unless we ask.',
      fixPath: '/organizer/payouts',
    });
  }

  /*
    ── SUGGESTED: it makes them look like a business somebody buys from ─────────────
    Never dressed up as a requirement. An organizer with no logo sells tickets perfectly well.
  */
  if (blank(org.taxRegistrationNumber)) {
    items.push({
      key: 'tax-registration',
      severity: 'SUGGESTED',
      title: 'Add your tax registration, if you have one',
      consequence:
        'With one on file your buyers get tax invoices. Without it they get valid receipts, which is fine if you are not registered.',
      fixPath: '/organizer/settings',
    });
  }

  if (blank(org.logoUrl)) {
    items.push({
      key: 'logo',
      severity: 'SUGGESTED',
      title: 'Add your profile picture',
      consequence: 'It appears on your event pages and on your public profile.',
      fixPath: '/organizer/settings',
    });
  }

  if (blank(org.description)) {
    items.push({
      key: 'description',
      severity: 'SUGGESTED',
      title: 'Write a line about who you are',
      consequence: 'Shown on your organizer page, where somebody decides whether to trust you.',
      fixPath: '/organizer/settings',
    });
  }

  return items;
}

/** The worst severity present, for a badge that says whether anything needs doing. */
export function readinessSummary(items: ReadinessItem[]): {
  blocking: number;
  important: number;
  suggested: number;
} {
  return {
    blocking: items.filter((i) => i.severity === 'BLOCKING').length,
    important: items.filter((i) => i.severity === 'IMPORTANT').length,
    suggested: items.filter((i) => i.severity === 'SUGGESTED').length,
  };
}
