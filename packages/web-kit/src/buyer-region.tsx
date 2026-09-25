'use client';

import { marketFor } from '@eticketsgo/shared-types';

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
  noneLabel = 'Prefer not to say',
  prefilledNote = 'Filled in from your last booking.',
  id = 'buyer-region',
  prefilled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  country: string | null | undefined;
  /*
    Every word the field shows can be passed in. The English defaults stayed on French Indian
    event pages on QA ("Your state", "Prefer not to say"), because only the label and hint
    were props and no caller passed even those. Defaults kept for callers that are English-only.
  */
  label?: string;
  hint?: string;
  /** The blank choice. */
  noneLabel?: string;
  /** Put before the hint when the value came from the last booking. */
  prefilledNote?: string;
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
        /*
          `w-full` is load-bearing, not tidying.

          A `<select>` sized `auto` is as wide as its WIDEST OPTION, and option text cannot wrap.
          This list contains "Andaman and Nicobar Islands", so the select told the layout it could
          never be narrower than about 357px - and that minimum propagated up through the card and
          the grid item around it: on a 411px phone the whole event page became 423px wide and
          scrolled sideways under the reader's thumb.

          Asking for the container's width instead stops the widest option deciding how wide an
          ancestor must be. It costs nothing to look at, because this is a block-level control that
          already filled its container - measured before and after, it renders at exactly the same
          size on a desktop event page. A long option now ellipsizes in the closed control, which is
          what every native picker does, and the open list is drawn by the platform at whatever
          width it needs.

          `min-w-0` is there for the case where a future caller puts this inside a flex row, where
          the automatic minimum size would bring the same problem back by a different route. It is
          not what fixes this one: removing it changes nothing, removing `w-full` brings the
          sideways scroll straight back, and `mobile-storefront.spec.ts` measures exactly that.
        */
        className="w-full min-w-0 rounded-md border border-border bg-background-surface px-3 py-2 text-[0.9375rem] text-text-primary"
      >
        <option value="">{noneLabel}</option>
        {/*
          Alphabetical, from the shared market list. `INDIA_STATES` is ordered by GST code —
          right for the reference file, wrong for a buyer scanning a dropdown at checkout, who
          opens it on Jammu and Kashmir and finds Assam above West Bengal.
        */}
        {(marketFor('India')?.regions ?? []).map((s) => (
          <option key={s.name} value={s.name}>
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
        {prefilled ? `${prefilledNote} ${hint}` : hint}
      </p>
    </div>
  );
}
