import { Music, Presentation, Mic, Wrench, Clapperboard, type LucideIcon } from 'lucide-react';

/**
 * Starter templates for the create-event wizard. These are static, presentation-only
 * suggestions — they seed the wizard's initial title/category/description via the
 * `?template=` query param. No backend involvement; the wizard's own logic is untouched.
 */
export interface ExperienceTemplate {
  id: string;
  label: string;
  /** Real category value pre-filled into the wizard's Category field. */
  category: string;
  icon: LucideIcon;
  /** Suggested starting title the organizer can edit. */
  suggestedTitle: string;
  /** Suggested description the organizer can edit. */
  description: string;
  /** One-line pitch shown on the template card. */
  blurb: string;
}

export const EXPERIENCE_TEMPLATES: ExperienceTemplate[] = [
  {
    id: 'concert',
    label: 'Concert',
    category: 'Music',
    icon: Music,
    suggestedTitle: 'Live in Concert',
    description:
      'An unforgettable live music night. Add your line-up, set times, and ticket tiers (e.g. General, VIP, Front Row).',
    blurb: 'Live music with tiered tickets and multiple sessions.',
  },
  {
    id: 'conference',
    label: 'Conference',
    category: 'Conference',
    icon: Presentation,
    suggestedTitle: 'Annual Conference',
    description:
      'A multi-session professional conference. Outline your agenda, speakers, and pass types (e.g. Standard, Student, Group).',
    blurb: 'Multi-session agenda with delegate passes.',
  },
  {
    id: 'comedy',
    label: 'Comedy Night',
    category: 'Comedy',
    icon: Mic,
    suggestedTitle: 'Comedy Night',
    description:
      'A stand-up comedy evening. Add your performers and a couple of ticket tiers for seating.',
    blurb: 'Stand-up evening with simple seating tiers.',
  },
  {
    id: 'workshop',
    label: 'Workshop',
    category: 'Workshop',
    icon: Wrench,
    suggestedTitle: 'Hands-on Workshop',
    description:
      'A hands-on learning session with limited capacity. Describe what attendees will learn and set a modest quantity.',
    blurb: 'Small-capacity, hands-on learning session.',
  },
  {
    id: 'movie',
    label: 'Movie Release',
    category: 'Film',
    icon: Clapperboard,
    suggestedTitle: 'Premiere Screening',
    description:
      'A special screening or premiere. For recurring cinema shows with seat maps, use the Movies section instead.',
    blurb: 'Premiere or one-off screening.',
  },
];

/** Look up a template by its `?template=` id, tolerating null/unknown values. */
export function getTemplate(id: string | null | undefined): ExperienceTemplate | undefined {
  if (!id) return undefined;
  return EXPERIENCE_TEMPLATES.find((t) => t.id === id.toLowerCase());
}
