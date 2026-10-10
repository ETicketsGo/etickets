import { StatusPill } from '@eticketsgo/web-kit';
import { moneyStatusLabel, moneyStatusTone, type MoneyEntity } from '../lib/money-status';

/** A money state as a pill, in the shared vocabulary. See `lib/money-status.ts`. */
export function MoneyStatusPill({
  entity,
  status,
  size,
}: {
  entity: MoneyEntity;
  status: string;
  size?: 'sm' | 'md';
}) {
  return (
    <StatusPill tone={moneyStatusTone(entity, status)} size={size}>
      {moneyStatusLabel(entity, status)}
    </StatusPill>
  );
}
