import type { RemovedMember } from '@eticketsgo/web-kit';

/**
 * What removing somebody took back with them, said in the toast.
 *
 * A removal used to say "Their access has ended" while their door phone kept admitting people
 * and their browser stayed signed in. The API now ends both and says how many; this repeats it.
 * An older API sends no `revoked`, and then only the first sentence is said.
 */
export function removalSummary(m: RemovedMember): string {
  const parts: string[] = [];
  const r = m.revoked;
  if (r && r.devices > 0)
    parts.push(`${r.devices} check-in device${r.devices === 1 ? '' : 's'} turned off`);
  if (r && r.activations > 0)
    parts.push(
      `${r.activations} offline check-in approval${r.activations === 1 ? '' : 's'} withdrawn`,
    );
  if (r?.signedOut) parts.push('signed out everywhere');
  const head = `${m.user.fullName} has been removed. Their access has ended`;
  return parts.length ? `${head}: ${parts.join(', ')}.` : `${head}.`;
}
