'use client';

import { useEffect, useRef } from 'react';
import { MARKETS, marketFor, marketFromHint, type Market } from '@eticketsgo/shared-types';
import { Select } from './components';
import { visitorCountry } from './locale';

/**
 * Where a venue is: country, subdivision, and the clock it keeps.
 *
 * ── WHY THESE THREE TRAVEL TOGETHER ────────────────────────────────────────────────
 * They were three unrelated fields and two of them were unreachable. Country was a free-text
 * box, so "India", "india", "IN" and a typo all saved; region could not be set at all, though
 * it decides whether an Indian sale is CGST + SGST or IGST; and timezone was never asked, so
 * every venue took the schema default of Asia/Kolkata — meaning a show in Chicago was stored,
 * displayed and printed on a ticket in Indian time.
 *
 * Each of those is only answerable once you know the country. Which subdivisions exist, what
 * they are called, and which clocks are plausible are all facts about the country, so asking
 * them separately is how they end up disagreeing. One component, one answer at a time.
 *
 * ── WHAT CHANGING THE COUNTRY DOES ─────────────────────────────────────────────────
 * Clears the region and moves the timezone to the new country's primary zone. Keeping a
 * Telangana region on a Canadian venue would be nonsense that validates, and keeping
 * Asia/Kolkata on it is the original bug. Both are corrected in the same keystroke, visibly,
 * before anything is saved.
 */

export interface LocationValue {
  country: string;
  region: string;
  timezone: string;
}

/**
 * The country to open on, and it is a GUESS.
 *
 * Derived from the browser locale — the same hint the storefront uses for ordering cities —
 * which reports language settings rather than a location. It is right often enough to save
 * most organizers a click and wrong often enough that it must never be more than a default:
 * the field stays a dropdown, and nothing is priced, taxed or routed on the strength of it.
 */
export function defaultLocation(): LocationValue {
  const market = marketFromHint(visitorCountry());
  return { country: market.name, region: '', timezone: market.timezones[0] };
}

/** The value for an existing record, tolerating whatever spelling is stored. */
export function locationFrom(venue: {
  country?: string | null;
  region?: string | null;
  timezone?: string | null;
}): LocationValue {
  const market = marketFor(venue.country);
  return {
    // An unrecognised country is kept as it was typed rather than silently replaced. It is
    // somebody's data, and a market we have not added yet is not the same as a mistake.
    country: market?.name ?? (venue.country ?? '').trim(),
    region: venue.region ?? '',
    timezone: venue.timezone || market?.timezones[0] || '',
  };
}

export function LocationFields({
  value,
  onChange,
  idPrefix = 'loc',
  /** Shown under the country field. Use it to say what the country decides here. */
  countryHint,
  disabled,
}: {
  value: LocationValue;
  onChange: (next: LocationValue) => void;
  idPrefix?: string;
  countryHint?: string;
  disabled?: boolean;
}) {
  const market = marketFor(value.country);

  /*
    A country the platform does not sell in, already stored on this venue.

    Offered as an extra option rather than dropped. Silently replacing it with India on the
    next save would rewrite a fact about somebody's venue because a dropdown could not
    represent it — and the organizer would have no way to tell it had happened.
  */
  const unknownCountry = value.country && !market ? value.country : null;

  const selectCountry = (name: string): void => {
    const next = MARKETS.find((m) => m.name === name);
    if (!next) {
      onChange({ ...value, country: name });
      return;
    }
    onChange({ country: next.name, region: '', timezone: next.timezones[0] });
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Select
        id={`${idPrefix}-country`}
        label="Country"
        value={value.country}
        onChange={(e) => selectCountry(e.target.value)}
        disabled={disabled}
        hint={countryHint}
      >
        {unknownCountry && <option value={unknownCountry}>{unknownCountry}</option>}
        {MARKETS.map((m) => (
          <option key={m.code} value={m.name}>
            {m.name}
          </option>
        ))}
      </Select>

      <RegionField
        market={market}
        value={value.region}
        onChange={(region) => onChange({ ...value, region })}
        id={`${idPrefix}-region`}
        disabled={disabled}
      />

      <TimezoneField
        market={market}
        value={value.timezone}
        onChange={(timezone) => onChange({ ...value, timezone })}
        id={`${idPrefix}-timezone`}
        disabled={disabled}
      />
    </div>
  );
}

/**
 * The subdivision, when the country has one worth asking about.
 *
 * Singapore has no state, province or equivalent in an address. A form that asks anyway is a
 * form built for somewhere else, which is exactly the impression a platform entering a market
 * cannot afford — so the field is absent rather than empty.
 */
function RegionField({
  market,
  value,
  onChange,
  id,
  disabled,
}: {
  market: Market | null;
  value: string;
  onChange: (value: string) => void;
  id: string;
  disabled?: boolean;
}) {
  if (!market || market.regions.length === 0) return null;

  // A stored value the list does not contain — a renamed state, or a row from before the
  // list existed. Shown, so editing the venue's name does not quietly discard it.
  const unlisted = value && !market.regions.some((r) => r.name === value) ? value : null;

  return (
    <Select
      id={id}
      label={market.regionLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      hint={
        market.code === 'IN'
          ? 'Where the event is held decides the place of supply on every invoice.'
          : undefined
      }
    >
      <option value="">Not specified</option>
      {unlisted && <option value={unlisted}>{unlisted}</option>}
      {market.regions.map((r) => (
        <option key={r.name} value={r.name}>
          {r.name}
        </option>
      ))}
    </Select>
  );
}

/**
 * The clock the venue keeps, asked only where there is a choice.
 *
 * India, the UK, the UAE and Singapore each have one zone, so asking would be asking somebody
 * to confirm the only possible answer. The United States has seven and the default cannot be
 * guessed from the country — which is the entire reason the previous behaviour, silently
 * keeping Asia/Kolkata, was wrong rather than merely imprecise.
 */
function TimezoneField({
  market,
  value,
  onChange,
  id,
  disabled,
}: {
  market: Market | null;
  value: string;
  onChange: (value: string) => void;
  id: string;
  disabled?: boolean;
}) {
  /*
    Keep the field's value in step with the country when the country has only one zone.

    Without this, editing a venue whose stored timezone predates this component — every venue
    created before it, all Asia/Kolkata — would leave a US venue showing "Asia/Kolkata" with
    no control to correct it, because a one-zone country renders nothing.
  */
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!market || market.timezones.length !== 1) return;
    const only = market.timezones[0];
    if (value === only || applied.current === only) return;
    applied.current = only;
    onChange(only);
  }, [market, value, onChange]);

  if (!market || market.timezones.length < 2) return null;

  return (
    <Select
      id={id}
      label="Timezone"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      hint="Show times are stored and displayed in the venue’s own clock, never the reader’s."
    >
      {market.timezones.map((tz) => (
        <option key={tz} value={tz}>
          {tz.replace(/_/g, ' ')}
        </option>
      ))}
    </Select>
  );
}
