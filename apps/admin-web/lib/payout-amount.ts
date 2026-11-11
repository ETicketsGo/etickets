/**
 * The amount an admin typed when recording a payout, in minor units, or null when it is not a
 * plain amount. Every currency ETicketsGo pays out in (INR, USD, CAD) has two decimal places.
 *
 * Strict on purpose: "1,200.50" and "1200.5" are accepted, "12.345", "-5", "abc" and "" are not.
 * The API compares the result with the payout exactly, so a parse that guessed would turn a typo
 * into a refusal at best and a wrong record at worst.
 */
export function typedAmountToMinor(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/**
 * Whether the signed-in admin verified the bank account this payout would be paid into, so that
 * recording it needs the sole-operator steps (attestation, bank reference, typed amount).
 * Advisory for the dialog; the API decides.
 */
export function verifiedByViewer(
  accounts: readonly {
    organization?: { id: string } | null;
    currency: string;
    verifiedBy?: { id: string } | null;
  }[],
  payout: { organizationId: string; currency: string },
  viewerId: string | undefined,
): boolean {
  if (!viewerId) return false;
  const account = accounts.find(
    (a) => a.organization?.id === payout.organizationId && a.currency === payout.currency,
  );
  return !!account?.verifiedBy && account.verifiedBy.id === viewerId;
}
