'use client';

import { useQuery } from '@tanstack/react-query';
import { api, Select } from '@eticketsgo/web-kit';
import { TAX_CATEGORIES, TAX_CATEGORY_LABELS, type TaxCategory } from '@eticketsgo/shared-types';

/**
 * What the event is, for tax: Cinema, Live performance, Recognised sporting event...
 *
 * ── WHY IT IS ONLY SOMETIMES SHOWN ──────────────────────────────────────────────────
 * The answer only matters where active tax rules depend on it. GST is off in every market
 * today, so the organizer is not asked a tax question nothing reads. The API says when that
 * changes for this venue (`required`), and from then on checkout refuses an unclassified
 * ticket rather than charge an assumed rate - so the question is asked here first.
 *
 * Also shown whenever the event already HAS a classification, so it can be seen and changed
 * whatever the market's state.
 *
 * Never pre-filled from the event type or category. A guess here is exactly the defect this
 * field exists to remove.
 */
export function TaxClassificationField({
  venueId,
  value,
  onChange,
  disabled,
}: {
  venueId: string | null | undefined;
  /** '' is "not set". */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const requirement = useQuery({
    queryKey: ['tax-classification', venueId],
    queryFn: () => api.events.taxClassification(venueId!),
    enabled: Boolean(venueId),
    // A market switching GST on is rare; the answer does not need refetching on focus.
    staleTime: 5 * 60_000,
  });
  const required = requirement.data?.required ?? false;
  if (!required && !value) return null;

  const rated = new Set(requirement.data?.ratedCategories ?? []);
  const unrated = required && value !== '' && !rated.has(value);

  return (
    <Select
      label="Tax classification"
      value={value}
      required={required}
      disabled={disabled}
      error={
        required && !value
          ? 'Choose what kind of event this is. Tickets cannot be sold here until you do.'
          : unrated
            ? 'No tax rate is set up for this classification here yet, so its tickets cannot be sold. Contact support if it is the right one.'
            : undefined
      }
      hint="Decides the tax rate on each ticket. Ask your tax adviser if you are not sure."
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Choose a classification</option>
      {TAX_CATEGORIES.map((category: TaxCategory) => (
        <option key={category} value={category}>
          {TAX_CATEGORY_LABELS[category].label}
        </option>
      ))}
    </Select>
  );
}

/** The chosen classification as the API takes it: null clears it, never ''. */
export function taxCategoryBody(value: string): string | null {
  return value === '' ? null : value;
}
