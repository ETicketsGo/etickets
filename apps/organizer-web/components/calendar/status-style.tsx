import { statusTone, type StatusTone } from '@/lib/calendar';

/**
 * How each status LOOKS on the calendar: a coloured dot beside the session, and a pill with
 * the words wherever there is room for them.
 *
 * The dot is never the only carrier of the status. Every chip and block names it in its
 * accessible name, and the day panel, the agenda and the preview print it as a pill - so the
 * colour is a scanning aid for a sighted reader, not the information itself. Only semantic
 * tokens: `bg-status-*` for the dot, and the web-kit `StatusPill` for the words, whose pairs
 * `token-contrast.test.ts` asserts. The admin calendar uses the same table and classes.
 */
const DOT: Record<StatusTone, string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
  info: 'bg-status-info',
  neutral: 'bg-text-muted',
};

/** The rule down the left of a block in the week and day grid. */
const RULE: Record<StatusTone, string> = {
  success: 'border-l-status-success',
  warning: 'border-l-status-warning',
  error: 'border-l-status-error',
  info: 'border-l-status-info',
  neutral: 'border-l-text-muted',
};

export function statusDot(status: string): string {
  return DOT[statusTone(status)];
}

export function statusRule(status: string): string {
  return RULE[statusTone(status)];
}
