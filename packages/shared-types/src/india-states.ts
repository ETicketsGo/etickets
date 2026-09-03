/**
 * India's states and union territories, and a tolerant way to compare two of them.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Whether an Indian order is taxed CGST + SGST or IGST comes down to one comparison: is the
 * buyer's state the same as the supplier's? That comparison was a raw uppercase string
 * equality, and the three fields feeding it are filled in by three different people at three
 * different times — a venue's region typed by an organizer, an organization's registered
 * region typed during onboarding, and a buyer's state chosen at checkout.
 *
 * "TG", "36", "Telangana" and "telangana" are the same place and would have compared as four
 * different ones. The failure is silent and one-directional: every sale looks inter-state, so
 * every rupee of GST is attributed to the wrong government, and nothing about the amount
 * charged looks wrong to anybody.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────
 * Reference data, not tax law. The codes below are the GST state codes that appear on an
 * invoice and in a GSTIN's first two digits; they identify a place. No rate, threshold or
 * rule is expressed here, and none should be.
 */

export interface IndiaState {
  /** GST state code — the first two digits of a GSTIN registered there. */
  code: string;
  /** Common short form, as people write it. */
  abbr: string;
  name: string;
}

/**
 * Ordered by GST state code, which is how they appear on official lists.
 *
 * 25 (Daman and Diu) and 28 (the undivided Andhra Pradesh) are deliberately absent: both
 * were retired when their territories were reorganised, and offering a retired code as a
 * choice invites somebody to pick it.
 */
export const INDIA_STATES: readonly IndiaState[] = [
  { code: '01', abbr: 'JK', name: 'Jammu and Kashmir' },
  { code: '02', abbr: 'HP', name: 'Himachal Pradesh' },
  { code: '03', abbr: 'PB', name: 'Punjab' },
  { code: '04', abbr: 'CH', name: 'Chandigarh' },
  { code: '05', abbr: 'UK', name: 'Uttarakhand' },
  { code: '06', abbr: 'HR', name: 'Haryana' },
  { code: '07', abbr: 'DL', name: 'Delhi' },
  { code: '08', abbr: 'RJ', name: 'Rajasthan' },
  { code: '09', abbr: 'UP', name: 'Uttar Pradesh' },
  { code: '10', abbr: 'BR', name: 'Bihar' },
  { code: '11', abbr: 'SK', name: 'Sikkim' },
  { code: '12', abbr: 'AR', name: 'Arunachal Pradesh' },
  { code: '13', abbr: 'NL', name: 'Nagaland' },
  { code: '14', abbr: 'MN', name: 'Manipur' },
  { code: '15', abbr: 'MZ', name: 'Mizoram' },
  { code: '16', abbr: 'TR', name: 'Tripura' },
  { code: '17', abbr: 'ML', name: 'Meghalaya' },
  { code: '18', abbr: 'AS', name: 'Assam' },
  { code: '19', abbr: 'WB', name: 'West Bengal' },
  { code: '20', abbr: 'JH', name: 'Jharkhand' },
  { code: '21', abbr: 'OD', name: 'Odisha' },
  { code: '22', abbr: 'CG', name: 'Chhattisgarh' },
  { code: '23', abbr: 'MP', name: 'Madhya Pradesh' },
  { code: '24', abbr: 'GJ', name: 'Gujarat' },
  { code: '26', abbr: 'DNHDD', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', abbr: 'MH', name: 'Maharashtra' },
  { code: '29', abbr: 'KA', name: 'Karnataka' },
  { code: '30', abbr: 'GA', name: 'Goa' },
  { code: '31', abbr: 'LD', name: 'Lakshadweep' },
  { code: '32', abbr: 'KL', name: 'Kerala' },
  { code: '33', abbr: 'TN', name: 'Tamil Nadu' },
  { code: '34', abbr: 'PY', name: 'Puducherry' },
  { code: '35', abbr: 'AN', name: 'Andaman and Nicobar Islands' },
  { code: '36', abbr: 'TG', name: 'Telangana' },
  { code: '37', abbr: 'AP', name: 'Andhra Pradesh' },
  { code: '38', abbr: 'LA', name: 'Ladakh' },
  { code: '97', abbr: 'OT', name: 'Other Territory' },
];

const normalise = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, '');

/**
 * Every spelling of one state, so any of them compares equal to any other.
 *
 * An unknown value returns only itself. That is deliberate: a state this list has never
 * heard of must not quietly match something else, and outside India this function should do
 * nothing at all — a Canadian "ON" and an Indian "OD" have no business colliding.
 */
export function regionAliases(value: string): string[] {
  const needle = normalise(value);
  if (!needle) return [];
  for (const state of INDIA_STATES) {
    const forms = [state.code, state.abbr, state.name].map(normalise);
    if (forms.includes(needle)) return [...new Set(forms)];
  }
  return [needle];
}

/**
 * Whether two regions name the same place.
 *
 * Both sides go through the alias table, so a venue recorded as "Telangana" matches a buyer
 * who chose "TG" and a supplier registered as "36". Either side missing is `false` — not
 * knowing where somebody is is not evidence that they are somewhere else.
 */
export function regionMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  const left = regionAliases(a);
  return regionAliases(b).some((form) => left.includes(form));
}

/** The canonical record for a region written in any of its forms, or null if unrecognised. */
export function indiaState(value: string | null | undefined): IndiaState | null {
  if (!value?.trim()) return null;
  const needle = normalise(value);
  return INDIA_STATES.find((s) => [s.code, s.abbr, s.name].map(normalise).includes(needle)) ?? null;
}
