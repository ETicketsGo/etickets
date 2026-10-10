import {
  Clapperboard,
  Drama,
  Frame,
  Music,
  Presentation,
  Trophy,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { EVENT_CATEGORIES, type EventCategory } from '../../lib/templates';

/**
 * What the organizer says they are organizing, before anything else.
 *
 * ── WHY THIS COMES FIRST ───────────────────────────────────────────────────────────
 * Owner's verdict on the five-step form (3/10): "start from what the organizer wants to
 * organize, then adapt". The old first screen asked for one of fourteen categories next to a
 * title box, and every event got the same questions in the same words afterwards - a concert
 * was asked about "sessions" and a conference about "ticket types".
 *
 * An experience is a DISPLAY group, not a new kind of event. Every one of them (except the
 * film) still creates the same event, sessions and ticket types through the same API calls,
 * with `Event.category` set to one of the categories the API already holds. What the
 * experience changes is the words, the examples, the defaults and which category choices are
 * offered - never a rule about what can be sold.
 *
 * The film is the exception, and deliberately: films are scheduled through the cinema
 * workflow (film, cinema and screen, showtimes, seat layout), which has its own pricing rules
 * and sale-eligibility checks. A second way to schedule a film from here would be a second
 * set of those rules, so that choice sends the organizer to the cinema workflow instead.
 */
export type ExperienceId =
  'concert' | 'movie' | 'stage' | 'conference' | 'sports' | 'exhibition' | 'community';

export interface Experience {
  id: ExperienceId;
  /** The choice as the organizer reads it. */
  label: string;
  /** One line: what kind of event this is. */
  description: string;
  /** What choosing it sets up, in the organizer's words. */
  setsUp: string;
  icon: LucideIcon;
  /** The categories offered for it, from the list the API already holds. The first is the default. */
  categories: readonly EventCategory[];
  /** Whether "Something else" (a typed category) is offered. */
  allowOther: boolean;
  /** What one date and time of this event is called. */
  sessionNoun: string;
  /** What one kind of ticket is called. Conferences sell passes. */
  ticketNoun: string;
  /** The first ticket row's name. */
  defaultTicketName: string;
  /** One-click names for a second ticket row. */
  ticketSuggestions: readonly string[];
  /** Placeholder examples. Never filled in for the organizer. */
  titleExample: string;
  descriptionExample: string;
  /** Movie only: handled by the cinema workflow, not by this flow. */
  routesToCinema?: boolean;
}

export const EXPERIENCES: readonly Experience[] = [
  {
    id: 'concert',
    label: 'Concert or live music',
    description: 'Gigs, live bands, DJ nights and music festivals.',
    setsUp: 'Artists, tickets and performances',
    icon: Music,
    categories: ['Music', 'Festival'],
    allowOther: false,
    sessionNoun: 'Performance',
    ticketNoun: 'Ticket type',
    defaultTicketName: 'General',
    ticketSuggestions: ['VIP', 'Early bird', 'Front row'],
    titleExample: 'e.g. Indie Night with The Local Band',
    descriptionExample: 'Who is playing, what to expect, when doors open.',
  },
  {
    id: 'movie',
    label: 'Movie screening',
    description: 'Films in a cinema, with showtimes on screens.',
    setsUp: 'Films, showtimes and seat layouts',
    icon: Clapperboard,
    categories: ['Film'],
    allowOther: false,
    sessionNoun: 'Showtime',
    ticketNoun: 'Ticket type',
    defaultTicketName: 'General',
    ticketSuggestions: [],
    titleExample: '',
    descriptionExample: '',
    routesToCinema: true,
  },
  {
    id: 'stage',
    label: 'Comedy or theatre',
    description: 'Stand-up, plays, musicals and stage shows.',
    setsUp: 'Performers, shows and seating',
    icon: Drama,
    categories: ['Comedy', 'Theatre'],
    allowOther: false,
    sessionNoun: 'Show',
    ticketNoun: 'Ticket type',
    defaultTicketName: 'General',
    ticketSuggestions: ['Premium', 'Early bird', 'Student'],
    titleExample: 'e.g. Saturday Stand-up Special',
    descriptionExample: 'Who is performing, how long the show runs, who it is for.',
  },
  {
    id: 'conference',
    label: 'Conference or workshop',
    description: 'Talks, summits, classes and hands-on workshops.',
    setsUp: 'Sessions, registrations and passes',
    icon: Presentation,
    categories: ['Conference', 'Workshop', 'Tech'],
    allowOther: false,
    sessionNoun: 'Day',
    ticketNoun: 'Pass',
    defaultTicketName: 'Standard pass',
    ticketSuggestions: ['Student pass', 'Early bird pass', 'Group pass', 'VIP pass'],
    titleExample: 'e.g. Product Design Summit 2027',
    descriptionExample: 'The agenda, the speakers, and who should attend.',
  },
  {
    id: 'sports',
    label: 'Sports',
    description: 'Matches, races, tournaments and fitness events.',
    setsUp: 'Fixtures, tickets and stands',
    icon: Trophy,
    categories: ['Sports'],
    allowOther: false,
    sessionNoun: 'Match',
    ticketNoun: 'Ticket type',
    defaultTicketName: 'General',
    ticketSuggestions: ['Premium', 'Child', 'Family'],
    titleExample: 'e.g. City Derby: Lions vs Falcons',
    descriptionExample: 'Who is playing, gate times, what to bring.',
  },
  {
    id: 'exhibition',
    label: 'Exhibition',
    description: 'Art shows, expos, fairs and trade shows.',
    setsUp: 'Opening days and entry tickets',
    icon: Frame,
    categories: ['Exhibition'],
    allowOther: false,
    sessionNoun: 'Opening',
    ticketNoun: 'Ticket type',
    defaultTicketName: 'General entry',
    ticketSuggestions: ['Child', 'Student', 'Family'],
    titleExample: 'e.g. Modern Prints: A Summer Show',
    descriptionExample: 'What is on show, opening hours, how long a visit takes.',
  },
  {
    id: 'community',
    label: 'Community or other',
    description: 'Meetups, food events, family days and anything else.',
    setsUp: 'Free or paid entry, and dates',
    icon: Users,
    categories: ['Community', 'Food & Drink', 'Kids & Family'],
    allowOther: true,
    sessionNoun: 'Session',
    ticketNoun: 'Ticket type',
    defaultTicketName: 'General',
    ticketSuggestions: ['Child', 'Supporter', 'Family'],
    titleExample: 'e.g. Neighbourhood Open Day',
    descriptionExample: 'What happens, who it is for, what to bring.',
  },
];

export function getExperience(id: string | null | undefined): Experience | undefined {
  return EXPERIENCES.find((e) => e.id === id);
}

/**
 * The experience a stored category belongs to.
 *
 * For a draft saved before experiences existed, and for a starter template that names a
 * category. A typed category (not on the list) is "community or other", where typing one is
 * offered. Empty is unknown.
 */
export function experienceForCategory(category: string): ExperienceId | '' {
  const value = category.trim();
  if (!value) return '';
  const found = EXPERIENCES.find((e) => (e.categories as readonly string[]).includes(value));
  return found ? found.id : 'community';
}

/** Every listed category belongs to exactly one experience - checked by the tests. */
export const ALL_GROUPED_CATEGORIES: readonly string[] = EXPERIENCES.flatMap((e) => e.categories);
export const UNGROUPED_CATEGORIES = EVENT_CATEGORIES.filter(
  (c) => !ALL_GROUPED_CATEGORIES.includes(c),
);

/**
 * The category to start with when an experience is chosen.
 *
 * Kept when the organizer had already picked one that belongs to it (they came back and chose
 * the same experience again); otherwise the experience's first category, which they can see
 * and change on the first step.
 */
export function categoryForExperience(experience: Experience, current: string): string {
  if ((experience.categories as readonly string[]).includes(current)) return current;
  return experience.categories[0] ?? '';
}

/** "Starter templates" deep-link with ?template=: which experience each one opens. */
export const TEMPLATE_EXPERIENCE: Record<string, ExperienceId> = {
  concert: 'concert',
  conference: 'conference',
  comedy: 'stage',
  workshop: 'conference',
  movie: 'movie',
};
