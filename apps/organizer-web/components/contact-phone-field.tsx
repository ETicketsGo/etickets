'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { MARKETS, marketFor } from '@eticketsgo/shared-types';
import { Input, PHONE_COUNTRIES, readTypedNumber, Select, toE164 } from '@eticketsgo/web-kit';

/** The longest national number any country we sell in uses, with room for none longer. */
const MAX_NATIONAL_DIGITS = 12;

/** The country and national digits a stored value reads as, or null when it is not E.164. */
function read(
  value: string,
  preferred: string | null,
): { country: string; national: string } | null {
  if (!/^\+\d+$/.test(value)) return null;
  // The US and Canada share +1: keep the organization's own country when the code fits it.
  const own = MARKETS.find((m) => m.code === preferred && value.slice(1).startsWith(m.callingCode));
  const parsed = readTypedNumber(value, own?.code ?? null);
  return parsed.country ? { country: parsed.country, national: parsed.national } : null;
}

/**
 * A phone number on Settings: the country's dialling code, then the national number in digits.
 *
 * ── WHAT IS SAVED ─────────────────────────────────────────────────────────────────────
 * E.164 (`+12085550100`), built from the two halves - never the text as typed, so a number is
 * one shape however it was entered. Letters are refused at the key, with a message saying so,
 * rather than dropped silently.
 *
 * ── A NUMBER SAVED BEFORE THIS FIELD EXISTED ─────────────────────────────────────────
 * Shown as it is, with a note, and left exactly as it is until the person types a new one.
 * `onChange` fires only on an edit, so saving another field never rewrites it.
 */
export function ContactPhoneField({
  id,
  label,
  value,
  onChange,
  homeCountry,
  error,
}: {
  id: string;
  label: string;
  /** The stored value: E.164, an older free-text number, or ''. */
  value: string;
  onChange: (next: string) => void;
  /** The organization's country, for the dialling code a blank field opens on. */
  homeCountry: string | null | undefined;
  error?: string;
}) {
  const home = marketFor(homeCountry)?.code ?? null;
  const hintId = useId();
  const lastSent = useRef<string | null>(null);
  const initial = read(value, home);
  const [country, setCountry] = useState(initial?.country ?? home ?? '');
  const [national, setNational] = useState(initial?.national ?? '');
  const [legacy, setLegacy] = useState(value && !initial ? value : '');
  const [keyProblem, setKeyProblem] = useState<string | null>(null);

  // A new value from outside (a save, another organization): read it again. Our own edits
  // come back through `value` too and are skipped, so typing is never reset mid-number.
  useEffect(() => {
    if (value === lastSent.current) return;
    const r = read(value, home);
    setCountry(r?.country ?? home ?? '');
    setNational(r?.national ?? '');
    setLegacy(value && !r ? value : '');
    setKeyProblem(null);
  }, [value, home]);

  const send = (c: string, n: string) => {
    const next = n ? toE164(c, n) : '';
    lastSent.current = next;
    setLegacy('');
    onChange(next);
  };

  const onType = (typed: string) => {
    // A pasted international number names its own country.
    if (/^\s*(\+|00)/.test(typed)) {
      const r = readTypedNumber(typed, country);
      const digits = r.national.slice(0, MAX_NATIONAL_DIGITS);
      const c = r.country ?? country;
      setCountry(c);
      setNational(digits);
      setKeyProblem(null);
      send(c, digits);
      return;
    }
    if (/[^\d\s().-]/.test(typed)) {
      setKeyProblem('Use digits only. Letters and symbols are not part of a phone number.');
      return;
    }
    const digits = typed.replace(/\D/g, '');
    if (digits.length > MAX_NATIONAL_DIGITS) {
      setKeyProblem(`That is too long for a phone number (at most ${MAX_NATIONAL_DIGITS} digits).`);
      return;
    }
    setKeyProblem(null);
    setNational(digits);
    send(country, digits);
  };

  const shown = keyProblem ?? error;
  return (
    <div>
      {/*
        One label over both halves, and the two top-aligned: with the label on the dropdown alone
        and the row bottom-aligned, an error under the number pushed the dropdown out of line.
      */}
      <label htmlFor={id} className="mb-1.5 block text-[0.8125rem] font-medium text-text-secondary">
        {label}
      </label>
      <div className="grid grid-cols-[minmax(7.5rem,40%)_1fr] items-start gap-2">
        <Select
          id={`${id}-country`}
          aria-label={`${label}: country code`}
          value={country}
          onChange={(e) => {
            setCountry(e.target.value);
            if (national) send(e.target.value, national);
          }}
        >
          <option value="">Code</option>
          {PHONE_COUNTRIES.map((m) => (
            <option key={m.code} value={m.code}>
              {m.name} (+{m.callingCode})
            </option>
          ))}
        </Select>
        <Input
          id={id}
          aria-label={`${label}: number`}
          inputMode="numeric"
          autoComplete="tel-national"
          placeholder={legacy ? 'Type a new number to replace it' : 'Number, digits only'}
          value={national}
          error={shown ?? undefined}
          aria-describedby={legacy ? hintId : undefined}
          onChange={(e) => onType(e.target.value)}
        />
      </div>
      {legacy && !shown ? (
        <p id={hintId} className="mt-1.5 text-caption text-text-muted">
          Saved as &quot;{legacy}&quot;. It stays exactly as it is until you type a new number.
        </p>
      ) : null}
    </div>
  );
}
