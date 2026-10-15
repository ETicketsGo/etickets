/**
 * Whether what the door typed is a number printed on a ticket - a ticket serial (TKT-...) or a
 * booking reference (ETG-...) - rather than the reading of a QR code.
 *
 * The QR code carries a signed token the server verifies. The numbers are printed beside it
 * so a person can read them, and a person at the door types them into the same box. Sent to
 * the scan endpoint they can only ever be "Invalid", which reads as a forged ticket; they are
 * a lookup instead.
 */
export function looksLikeTicketNumber(value: string): boolean {
  return /^(TKT|ETG)-[A-Z0-9-]+$/i.test(value.trim());
}
