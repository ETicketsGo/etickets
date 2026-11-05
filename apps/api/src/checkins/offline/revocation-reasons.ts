/**
 * One entry in `CheckInDevice.revokeReasons`: "<ISO time> <REASON>".
 *
 * Owner decision (2026-10-26): a device keeps its FIRST revocation reason in `revokeReason`
 * (that is what the door phone is told), and every reason, the first included, is appended to
 * the history, so a later reason is never dropped and never overwrites the first.
 */
export function revokeReasonEntry(reason: string, at: Date = new Date()): string {
  return `${at.toISOString()} ${reason}`;
}
