'use client';

import { INDIA_STATES } from '@eticketsgo/shared-types';

/**
 * "Which state are you in?", asked only where the answer changes anything.
 *
 * ── WHY THIS IS ASKED, AND WHY IT IS OPTIONAL ──────────────────────────────────────
 * India taxes a platform's service where the RECIPIENT is. A Telangana buyer and a
 * Maharashtra buyer paying the same convenience fee are owed to different governments —
 * CGST + SGST within one state, IGST across a border. The AMOUNT does not change, which is
 * precisely why this can be optional: a blank answer never overcharges anybody, it only
 * misattributes at filing. Left blank, the sale is treated as intra-state, which is also
 * what the law does for a buyer with no address on record.
 *
 * So it is one dropdown, marked optional, with the reason stated in a sentence. Making it
 * required would add friction to every Indian checkout to fix a filing detail the buyer has
 * no stake in — and a required field people do not understand gets answered wrongly, which
 * is worse than not asking.
 *
 * ── WHY IT IS NOT SHOWN OUTSIDE INDIA ──────────────────────────────────────────────
 * Nowhere else on this platform does anything with it. A US buyer asked for their state on
 * a checkout that ignores it is being asked to do work for no reason, and a field that
 * collects data nothing reads is a liability rather than a feature.
 */
export function BuyerRegionField({
  value,
  onChange,
  /** The country the sale is IN — the venue's, not the browser's. */
  country,
  label = 'Your state',
  hint = 'Optional. Used only to state the place of supply on your invoice — it does not change what you pay.',
  id = 'buyer-region',
  prefilled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  country: string | null | undefined;
  label?: string;
  hint?: string;
  id?: string;
  /** True when the value came from the customer's last purchase rather than from them now. */
  prefilled?: boolean;
}) {
  // Matched loosely because this field is typed by hand in several places.
  const inIndia = (country ?? '').trim().toLowerCase().replace(/\s+/g, '') === 'india';
  if (!inIndia) return null;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-caption font-medium text-text-secondary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-hint`}
        className="rounded-md border border-border bg-background px-3 py-2 text-[0.9375rem] text-text-primary"
      >
        <option value="">Prefer not to say</option>
        {INDIA_STATES.map((s) => (
          <option key={s.code} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className="text-caption text-text-muted">
        {/*
          A prefilled field says so. Silently filling a form on somebody's behalf is how
          people submit an answer they never gave — and this one ends up on an invoice. Saying
          where it came from turns the question into something to glance at and correct.
        */}
        {prefilled ? `${'Filled in from your last booking. '}${hint}` : hint}
      </p>
    </div>
  );
}
