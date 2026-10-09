'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Badge,
  Select,
  countryDisplay,
  countryFilterOptions,
  parseCountryParam,
} from '@eticketsgo/web-kit';

/**
 * The country filter shared by the admin lists.
 *
 * ── WHY THE URL HOLDS IT ───────────────────────────────────────────────────────────
 * "Bookings in Canada" is a view somebody wants to come back to and send to a colleague. Held in
 * component state it was lost on every refresh and could not be linked to; in the query string it
 * is both. Only the country lives there - the status filters on these pages are seeded from the
 * link by the action centre and are otherwise local, and moving them too would change what those
 * links do.
 */
export function useCountryParam(): [string | undefined, (code: string | undefined) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const country = parseCountryParam(params.get('country'));

  const setCountry = (code: string | undefined) => {
    const next = new URLSearchParams(params.toString());
    if (code) next.set('country', code);
    else next.delete('country');
    const query = next.toString();
    // `replace`, not `push`: changing a filter is not a page the back button should step through.
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return [country, setCountry];
}

/** The dropdown. The markets come from the platform's market list, never typed out here. */
export function CountryFilter({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (code: string | undefined) => void;
}) {
  return (
    <Select
      aria-label="Country filter"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">Every country</option>
      {countryFilterOptions().map((c) => (
        <option key={c.code} value={c.code}>
          {c.name} ({c.code})
        </option>
      ))}
    </Select>
  );
}

/** A stored country value as code and name, or a muted "Not recorded". */
export function CountryLabel({ stored }: { stored: string | null | undefined }) {
  const country = countryDisplay(stored);
  if (!country) return <span className="text-caption text-text-muted">Not recorded</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-caption text-text-secondary">
      {country.code && <Badge tone="neutral">{country.code}</Badge>}
      <span>{country.name}</span>
    </span>
  );
}

/** "in India" for a heading, from a filter code. */
export function countryPhrase(code: string | undefined): string {
  if (!code) return '';
  return ` in ${countryDisplay(code)?.name ?? code}`;
}
