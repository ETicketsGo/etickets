import {
  CheckCircle2,
  CircleDashed,
  Clock,
  Flag,
  PauseCircle,
  Ticket,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

/**
 * How each status LOOKS on the calendar: a colour and an icon, never the colour alone.
 *
 * The tones follow the console's StatusBadge (published is green, under review and paused amber,
 * cancelled red, draft grey) so a status reads the same here as on the events list. Statuses
 * sharing a tone are told apart by the icon and by the words every chip carries in its
 * accessible name. Only semantic tokens: `bg-tint-*` pairs with `text-status-*` at a contrast
 * `token-contrast.test.ts` asserts, and a restyle of the tokens restyles the calendar.
 */
interface StatusLook {
  icon: LucideIcon;
  /** Chip background and left rule. */
  chip: string;
  /** The icon's colour, readable on `chip`. */
  accent: string;
}

const SUCCESS = {
  chip: 'bg-tint-success border-status-success',
  accent: 'text-status-success',
};
const WARNING = {
  chip: 'bg-tint-warning border-status-warning',
  accent: 'text-status-warning',
};
const ERROR = { chip: 'bg-tint-error border-status-error', accent: 'text-status-error' };
const NEUTRAL = { chip: 'bg-background-subtle border-text-muted', accent: 'text-text-secondary' };

const LOOKS: Record<string, StatusLook> = {
  DRAFT: { icon: CircleDashed, ...NEUTRAL },
  UNDER_REVIEW: { icon: Clock, ...WARNING },
  PUBLISHED: { icon: CheckCircle2, ...SUCCESS },
  PAUSED: { icon: PauseCircle, ...WARNING },
  SOLD_OUT: { icon: Ticket, ...WARNING },
  CANCELLED: { icon: XCircle, ...ERROR },
  COMPLETED: { icon: Flag, ...SUCCESS },
};

export function statusLook(status: string): StatusLook {
  return LOOKS[status] ?? { icon: CircleDashed, ...NEUTRAL };
}
