import { StatusBadge as KitStatusBadge } from '@eticketsgo/web-kit';
import { statusWords } from '../lib/words';

/**
 * The shared status badge, with the state in words ("Under review", not "UNDER REVIEW").
 *
 * Same props and colours as the web-kit badge; only the default label differs. The organizer
 * console and storefront are left alone - this is the admin console's reading of it.
 */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <KitStatusBadge status={status} label={label ?? statusWords(status)} />;
}
