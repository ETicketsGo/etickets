/**
 * What a ticket is, for tax: the vocabulary a `TaxRule.category` matches on.
 *
 * ── WHY A DEDICATED CLASSIFICATION ─────────────────────────────────────────────────
 * The rate on an admission depends on WHAT is being admitted to. India taxes a cinema seat, a
 * recognised sporting fixture, a concert and an IPL-style match differently, and none of that
 * can be read off anything else the platform stores:
 *
 *   - the event's free-text `category` is whatever the organizer typed ("Sports", "Cricket");
 *   - a seat category's `regulatoryClass` (REGULAR, RECLINER...) is a CINEMA PRICING class,
 *     which a state rate order bands on - it says nothing about the tax category, and the tax
 *     rules banded on "MOVIE" never matched it, so every cinema ticket would have fallen to
 *     the 18% catch-all;
 *   - the ticket price decides a BAND within a category, never the category itself.
 *
 * So the classification is declared by a person, on the event (and optionally on one ticket
 * type), and nothing guesses it. A sale in a market with active classified tax rules that
 * has no classification is refused rather than taxed at an assumed rate.
 *
 * ── WHY THE RATES ARE NOT HERE ─────────────────────────────────────────────────────
 * These are names. Rates, thresholds and dates live in `TaxRule` rows an owner activates on
 * professional advice; see docs/finance/INDIA-GST-CLASSIFICATION.md. A category here with no
 * active rule is not an error in this file - it is a sale the platform will refuse until
 * somebody qualified writes the rule.
 */
export const TAX_CATEGORIES = [
  'CINEMA',
  'SPORTS_RECOGNISED',
  'SPORTS_OTHER',
  'LIVE_PERFORMANCE',
  'AMUSEMENT',
  'OTHER_ENTERTAINMENT',
  'CONFERENCE',
] as const;

export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export function isTaxCategory(value: unknown): value is TaxCategory {
  return typeof value === 'string' && (TAX_CATEGORIES as readonly string[]).includes(value);
}

/**
 * What an organizer reads when choosing. Plain English, ASCII only (house rule).
 *
 * The hints say what belongs in a category in the words of the event, not of the law, and
 * name the borderline cases rather than leaving the organizer to guess them.
 */
export const TAX_CATEGORY_LABELS: Record<TaxCategory, { label: string; hint: string }> = {
  CINEMA: {
    label: 'Cinema (film screening)',
    hint: 'A film shown in a cinema or screening room.',
  },
  SPORTS_RECOGNISED: {
    label: 'Recognised sporting event',
    hint:
      'A match or tournament organised by a recognised national or international sports ' +
      'body. Check with your tax adviser if you are not sure.',
  },
  SPORTS_OTHER: {
    label: 'Other sporting event (for example a franchise league)',
    hint: 'A sporting event that is not organised by a recognised sports body, such as an IPL-style league.',
  },
  LIVE_PERFORMANCE: {
    label: 'Live performance',
    hint: 'Concert, music, theatre, drama, dance, ballet, circus, award show or pageant.',
  },
  AMUSEMENT: {
    label: 'Amusement or theme park',
    hint: 'Theme park, water park, rides or go-karting.',
  },
  OTHER_ENTERTAINMENT: {
    label: 'Other entertainment',
    hint: 'Any other recreational or cultural event not listed above.',
  },
  CONFERENCE: {
    label: 'Conference, workshop or exhibition',
    hint: 'A business, educational or trade event.',
  },
};

/**
 * The tax category a ticket is sold under: its own override, else its event's. Null means
 * nobody has said, which a market with classified tax rules refuses to sell.
 */
export function effectiveTaxCategory(
  ticketTypeCategory: string | null | undefined,
  eventCategory: string | null | undefined,
): string | null {
  return ticketTypeCategory?.trim() || eventCategory?.trim() || null;
}

/**
 * How a stored classification reads to a person. Null and unknown values are said plainly
 * rather than shown as a code: "Not set" is the state an organizer has to act on.
 */
export function taxCategoryLabel(value: string | null | undefined): string {
  if (!value) return 'Not set';
  return isTaxCategory(value) ? TAX_CATEGORY_LABELS[value].label : value;
}
