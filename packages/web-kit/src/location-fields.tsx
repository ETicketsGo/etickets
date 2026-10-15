'use client';

import { useEffect, useRef, useState } from 'react';
import {
  MARKETS,
  marketFor,
  marketFromHint,
  regionZone,
  sameClock,
  zoneForPlace,
  zoneInWords,
  type Market,
} from '@eticketsgo/shared-types';
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
 *
 * ── WHAT CHANGING THE STATE DOES ───────────────────────────────────────────────────
 * Moves the zone to the one that state keeps (`REGION_TIMEZONES`), unless the person picked a
 * zone themselves. The country's first zone is only a placeholder until then: it put a venue
 * in Meridian, Idaho on New York time, two hours wrong for every show.
 */

export interface LocationValue {
  country: string;
  region: string;
  timezone: string;
  /**
   * True once the person picked the zone themselves. Then a later change of state leaves it
   * alone: somebody who chose Mountain time for a venue in El Paso meant it. Absent or false,
   * the zone follows the state, because nobody chose it - it was a default.
   */
  timezoneChosen?: boolean;
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
    timezone:
      venue.timezone || zoneForPlace(venue.country, venue.region) || market?.timezones[0] || '',
    /*
      Not marked as chosen. A stored zone may be the old country default nobody looked at
      (every United States venue was saved on Eastern time), so changing the state while
      editing moves it - visibly - and a stored zone that contradicts the state is pointed out
      on the form. It is never rewritten just by opening the venue.
    */
  };
}

/**
 * The next value when the country changes: no region, and the new country's first zone until
 * a state says better.
 */
export function withCountry(value: LocationValue, name: string): LocationValue {
  const next = MARKETS.find((m) => m.name === name);
  if (!next) return { ...value, country: name };
  return { country: next.name, region: '', timezone: next.timezones[0] };
}

/**
 * The next value when the state or province changes. The zone follows it unless the person
 * picked a zone themselves - this is the step that used to leave an Idaho venue on New York
 * time, because nothing here looked at the state.
 */
export function withRegion(value: LocationValue, region: string): LocationValue {
  const zone = zoneForPlace(value.country, region);
  if (value.timezoneChosen || !zone) return { ...value, region };
  return { ...value, region, timezone: zone };
}

/** The next value when the person picks a zone. Theirs from now on, whatever the state. */
export function withChosenZone(value: LocationValue, timezone: string): LocationValue {
  return { ...value, timezone, timezoneChosen: true };
}

/** What the form says about the zone, as data, so the sentence and the tests agree. */
export interface ZoneStatus {
  /** The zone the state keeps, when the table knows. */
  expected: string | null;
  /** The zone is not the one the state keeps. */
  conflict: boolean;
  sentence: string;
}

export function zoneStatus(value: LocationValue): ZoneStatus {
  const market = marketFor(value.country);
  const zone = value.timezone;
  const expected = regionZone(value.country, value.region);
  // Only a DIFFERENT clock is a conflict: an Idaho venue on America/Denver sells every show at
  // the right time, and a warning about it would teach people to ignore the warning.
  const conflict = !!(zone && expected && !sameClock(zone, expected));
  const needsRegion = !!market && market.timezones.length > 1 && !value.region;
  const ask = `Choose the ${(market?.regionLabel ?? 'region').toLowerCase()} and it is set from there.`;
  let sentence: string;
  if (!zone) {
    sentence = needsRegion ? `Not set yet. ${ask}` : 'Not set.';
  } else if (conflict) {
    sentence = value.timezoneChosen
      ? `${zoneInWords(zone)}, chosen by you. ${value.region} usually keeps ${zoneInWords(expected!)}.`
      : `${zoneInWords(zone)}. ${value.region} usually keeps ${zoneInWords(expected!)}. Check which one is right.`;
  } else if (expected) {
    sentence = `${zoneInWords(zone)}, from ${value.region}.`;
  } else if (needsRegion && !value.timezoneChosen) {
    sentence = `${zoneInWords(zone)} for now. ${ask}`;
  } else {
    sentence = `${zoneInWords(zone)}.`;
  }
  return { expected, conflict, sentence };
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

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Select
        id={`${idPrefix}-country`}
        label="Country"
        value={value.country}
        onChange={(e) => onChange(withCountry(value, e.target.value))}
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
        onChange={(region) => onChange(withRegion(value, region))}
        id={`${idPrefix}-region`}
        disabled={disabled}
      />

      <TimezoneField
        market={market}
        value={value}
        onChange={onChange}
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
          : market.timezones.length > 1
            ? 'Sets the time zone your show times are in.'
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
 * The clock the venue keeps, said in plain words and changeable.
 *
 * It was a dropdown labelled "Timezone" that opened on the country's first zone -
 * America/New_York for every United States venue - and nothing moved it when the state was
 * chosen. An Idaho venue was saved on New York time by a person who never looked at the field,
 * because nothing gave them a reason to. Now the zone is a sentence the person reads
 * ("Mountain time (Boise), from Idaho."), it follows the state, and "Change" opens the list.
 *
 * India, the UK, the UAE and Singapore have one zone, so there is nothing to choose; the
 * sentence still says which, so nobody has to wonder.
 */
function TimezoneField({
  market,
  value,
  onChange,
  id,
  disabled,
}: {
  market: Market | null;
  value: LocationValue;
  onChange: (value: LocationValue) => void;
  id: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  /*
    Keep the value in step with the country when the country has only one zone.

    Without this, editing a venue whose stored timezone predates this component — every venue
    created before it, all Asia/Kolkata — would leave a US venue showing "Asia/Kolkata" with
    no control to correct it, because a one-zone country renders no list.
  */
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!market || market.timezones.length !== 1) return;
    const only = market.timezones[0];
    if (value.timezone === only || applied.current === only) return;
    applied.current = only;
    onChange({ ...value, timezone: only });
  }, [market, value, onChange]);

  if (!market) return null;
  const status = zoneStatus(value);
  const choosable = market.timezones.length > 1;
  // A stored zone the list does not name (America/Indiana/Indianapolis, say) stays visible.
  const zones =
    value.timezone && !market.timezones.includes(value.timezone)
      ? [value.timezone, ...market.timezones]
      : market.timezones;
  const linkClass =
    'font-medium text-action-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background-subtle/50 p-3 sm:col-span-2">
      <p
        data-testid={`${id}-summary`}
        aria-live="polite"
        className="text-[0.9375rem] text-text-primary"
      >
        <span className="font-semibold">Time zone: </span>
        {status.sentence}
        {status.conflict && status.expected ? (
          <>
            {' '}
            <button
              type="button"
              className={linkClass}
              disabled={disabled}
              onClick={() =>
                onChange({ ...value, timezone: status.expected!, timezoneChosen: false })
              }
            >
              Use {zoneInWords(status.expected)}
            </button>
          </>
        ) : null}
        {choosable && !open ? (
          <>
            {' '}
            <button
              type="button"
              className={linkClass}
              disabled={disabled}
              aria-expanded={false}
              onClick={() => setOpen(true)}
            >
              Change
            </button>
          </>
        ) : null}
      </p>
      {choosable && open ? (
        <Select
          id={id}
          label="Time zone"
          value={value.timezone}
          onChange={(e) => onChange(withChosenZone(value, e.target.value))}
          disabled={disabled}
          hint="Show times are entered and shown in the venue's own clock, wherever the reader is."
        >
          {zones.map((tz) => (
            <option key={tz} value={tz}>
              {zoneInWords(tz)}
            </option>
          ))}
        </Select>
      ) : (
        <p className="text-caption text-text-muted">
          Show times are entered and shown in this clock, wherever the reader is.
        </p>
      )}
    </div>
  );
}
