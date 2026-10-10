import {
  CalendarClock,
  ClipboardCheck,
  MapPin,
  Sparkles,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import { IconTile, type TileTone } from '@eticketsgo/web-kit';

const STEPS: readonly [LucideIcon, TileTone, string, string][] = [
  [Sparkles, 'teal', 'Basics', 'Title, category and pictures'],
  [MapPin, 'blue', 'Where and when', 'Venue, dates and times'],
  [Ticket, 'purple', 'Tickets', 'Free, paid or reserved seats'],
  [ClipboardCheck, 'amber', 'Review', 'Check, then save or submit'],
];

/**
 * What happens after the first choice, beside the choices.
 *
 * A first-time organizer asked "how long is this and when does it go live?" before choosing
 * anything. Four steps, and the one rule that matters most - nothing sells until it is
 * approved - said before they start, from the same answer the Review step gives
 * (`whatHappensNext`): an organization an administrator set to publish without review is told
 * that instead.
 */
export function HowItWorks({ publishes }: { publishes: boolean }) {
  return (
    <section
      aria-labelledby="how-it-works"
      className="h-full rounded-lg border border-border bg-background-surface p-4 sm:p-5"
    >
      <h2 id="how-it-works" className="text-ui font-semibold text-text-primary">
        How it works
      </h2>
      <ol className="mt-3 grid gap-3 lg:grid-cols-2 2xl:grid-cols-1">
        {STEPS.map(([icon, tone, title, line], i) => (
          <li key={title} className="flex items-center gap-3">
            <IconTile icon={icon} tone={tone} size="sm" />
            <span className="min-w-0 text-caption">
              <span className="block font-semibold text-text-primary">
                {i + 1}. {title}
              </span>
              <span className="block text-text-secondary">{line}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-4 flex items-start gap-2 rounded-md bg-background-subtle px-3 py-2 text-caption text-text-secondary">
        <CalendarClock aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
        {publishes
          ? 'Your organization publishes without a review, so tickets go on sale when you submit.'
          : 'Nothing goes on sale until our team approves it. Your draft is saved as you go.'}
      </p>
    </section>
  );
}
