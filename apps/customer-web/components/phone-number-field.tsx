'use client';

import { useEffect, useState } from 'react';
import { useCity, visitorCountry } from '@eticketsgo/web-kit';
import { Input, Select } from '@/components/ui';
import {
  PHONE_COUNTRIES,
  isPhoneCountry,
  phoneCountryGuess,
  readTypedNumber,
  toE164,
} from '@/lib/phone-number';

export interface PhoneNumberState {
  /** ISO code shown in the select; '' while nobody - person or guess - has placed them. */
  country: string;
  national: string;
  /** The full number, or '' while either half is missing. */
  e164: string;
  setCountry: (code: string) => void;
  /** Feed the number box's raw value here: a pasted +44... sets the country as well. */
  type: (typed: string) => void;
  /** Start again from a stored number (or from nothing, back on the guess). */
  reset: (e164?: string | null) => void;
}

/**
 * A phone number as country + national digits, opening on the country the visitor is in.
 *
 * ── WHERE THE COUNTRY COMES FROM ───────────────────────────────────────────────────
 * The same answer the header's city picker already fetched (`useCity().locatedCountry`: the
 * network edge's country, else the device region), then the browser's own zone and language
 * while that request is in flight or if it fails. No second request, and never a hard-coded
 * +91 or +1.
 *
 * The guess is only a starting point. The moment the person picks a country, or pastes a
 * number that names one, their answer wins and a late-arriving guess cannot move it.
 *
 * The browser half is read after hydration, never during render: the zone does not exist on
 * the server, and a first render that disagrees with the server's is a hydration error.
 */
export function usePhoneNumber(): PhoneNumberState {
  const { locatedCountry } = useCity();
  const [browser, setBrowser] = useState<string | null>(null);
  useEffect(() => setBrowser(visitorCountry()), []);
  const [chosen, setChosen] = useState<string | null>(null);
  const [national, setNational] = useState('');

  const country = chosen ?? phoneCountryGuess(locatedCountry, browser) ?? '';
  return {
    country,
    national,
    e164: toE164(country, national),
    setCountry: (code) => setChosen(code),
    type: (typed) => {
      const read = readTypedNumber(typed, country);
      if (read.country) setChosen(read.country);
      setNational(read.national);
    },
    reset: (e164) => {
      const read = e164 ? readTypedNumber(e164) : { national: '' };
      setChosen(read.country && isPhoneCountry(read.country) ? read.country : null);
      setNational(read.national);
    },
  };
}

/**
 * Country + number, side by side where there is room.
 *
 * One column on a phone, two from `sm`. The column widths are explicit: an implicit grid track
 * sizes to its widest child, which a country name is.
 */
export function PhoneNumberField({
  phone,
  ids,
  label,
  countryLabel,
  countryPlaceholder,
  required,
  autoFocus,
  error,
  onEdit,
  countryOnly = false,
}: {
  phone: PhoneNumberState;
  ids: { country: string; number: string };
  label: string;
  countryLabel: string;
  countryPlaceholder: string;
  required?: boolean;
  autoFocus?: boolean;
  error?: string;
  /** Called on any change, so a form can clear an error about the number. */
  onEdit?: () => void;
  /** Only the country select, for a moment when no number can be used. */
  countryOnly?: boolean;
}) {
  return (
    <div
      className={
        countryOnly
          ? 'grid grid-cols-1'
          : 'grid grid-cols-1 gap-3 sm:grid-cols-[11rem_minmax(0,1fr)]'
      }
    >
      <Select
        id={ids.country}
        label={countryLabel}
        value={phone.country}
        onChange={(e) => {
          phone.setCountry(e.target.value);
          onEdit?.();
        }}
        required={required}
      >
        <option value="">{countryPlaceholder}</option>
        {PHONE_COUNTRIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name} +{c.callingCode}
          </option>
        ))}
      </Select>
      {!countryOnly && (
        <Input
          id={ids.number}
          label={label}
          type="tel"
          inputMode="tel"
          // The national part only: the country is the field beside it.
          autoComplete="tel-national"
          autoFocus={autoFocus}
          value={phone.national}
          onChange={(e) => {
            phone.type(e.target.value);
            onEdit?.();
          }}
          required={required}
          error={error}
        />
      )}
    </div>
  );
}
