import { marketFor, regionFor, unambiguousZoneFor } from './markets';

/**
 * The clock a venue keeps, from its state or province.
 *
 * -- THE DEFECT THIS FIXES -----------------------------------------------------------------
 * A venue in Meridian, Idaho was stored as America/New_York. The form set the zone to the
 * country's FIRST zone when the country was chosen and never looked at the state, so every
 * United States venue started on Eastern time and stayed there unless somebody noticed a
 * dropdown they had no reason to open. Every show time at that venue would have been sold two
 * hours wrong. The state was already on the form; it simply was not consulted.
 *
 * -- SPLIT STATES ---------------------------------------------------------------------------
 * Some states keep more than one clock. Each maps to the zone most of its PEOPLE keep, because
 * that is where most venues are. The person sees the zone in plain words beside the field and
 * can change it, so a venue in the minority part (Pensacola, El Paso, Coeur d'Alene) costs one
 * click, never a silent wrong answer:
 *
 *   Idaho          America/Boise      the populous south (Boise, Meridian, Nampa). The panhandle is Pacific.
 *   Florida        America/New_York   the panhandle west of the Apalachicola is Central.
 *   Texas          America/Chicago    El Paso and Hudspeth counties are Mountain.
 *   Indiana        America/New_York   Indianapolis keeps Eastern time with daylight saving, exactly as
 *                                     New York does; the north-west and south-west corners are Central.
 *                                     The market list names one Eastern zone, so this uses it.
 *   Michigan       America/New_York   four Upper Peninsula counties are Central.
 *   Kentucky       America/New_York   Louisville and Lexington are Eastern; the west is Central.
 *   Tennessee      America/Chicago    Nashville and Memphis are Central; Knoxville and Chattanooga Eastern.
 *   Kansas, Nebraska, North Dakota, South Dakota
 *                  America/Chicago    the western edges are Mountain.
 *   Oregon         America/Los_Angeles  Malheur County is Mountain.
 *   Arizona        America/Phoenix    no daylight saving. The Navajo Nation does observe it.
 *   Alaska         America/Anchorage  the Aleutians west of 169.5W are on Hawaii-Aleutian time.
 *
 *   Ontario        America/Toronto    the far north-west (Kenora, Rainy River) is Central.
 *   Quebec         America/Toronto    Montreal keeps Toronto's rules; the tz database links them.
 *   Saskatchewan   America/Regina     Central time all year, no daylight saving. Lloydminster differs.
 *   British Columbia America/Vancouver  the north-east (Fort St John, Dawson Creek) and Cranbrook differ.
 *   New Brunswick, Nova Scotia, Prince Edward Island
 *                  America/Halifax    Atlantic time. Moncton keeps identical rules.
 *   Newfoundland and Labrador
 *                  America/St_Johns   most of Labrador is on Atlantic time.
 *   Yukon          America/Whitehorse Mountain standard time all year since 2020 - NOT Vancouver.
 *   Northwest Territories America/Edmonton  Yellowknife keeps Edmonton's rules.
 *   Nunavut        America/Toronto    Iqaluit, the capital and largest town, keeps Eastern time.
 *
 * -- WHAT IS NOT HERE ------------------------------------------------------------------------
 * Countries with one zone (India, the UK, the UAE, Singapore): the country is the answer and
 * `unambiguousZoneFor` already gives it. New Zealand's regions all keep Auckland time; the
 * Chatham Islands are not a region on the list.
 */
export const REGION_TIMEZONES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  US: {
    Alabama: 'America/Chicago',
    Alaska: 'America/Anchorage',
    Arizona: 'America/Phoenix',
    Arkansas: 'America/Chicago',
    California: 'America/Los_Angeles',
    Colorado: 'America/Denver',
    Connecticut: 'America/New_York',
    Delaware: 'America/New_York',
    'District of Columbia': 'America/New_York',
    Florida: 'America/New_York',
    Georgia: 'America/New_York',
    Hawaii: 'Pacific/Honolulu',
    Idaho: 'America/Boise',
    Illinois: 'America/Chicago',
    Indiana: 'America/New_York',
    Iowa: 'America/Chicago',
    Kansas: 'America/Chicago',
    Kentucky: 'America/New_York',
    Louisiana: 'America/Chicago',
    Maine: 'America/New_York',
    Maryland: 'America/New_York',
    Massachusetts: 'America/New_York',
    Michigan: 'America/New_York',
    Minnesota: 'America/Chicago',
    Mississippi: 'America/Chicago',
    Missouri: 'America/Chicago',
    Montana: 'America/Denver',
    Nebraska: 'America/Chicago',
    Nevada: 'America/Los_Angeles',
    'New Hampshire': 'America/New_York',
    'New Jersey': 'America/New_York',
    'New Mexico': 'America/Denver',
    'New York': 'America/New_York',
    'North Carolina': 'America/New_York',
    'North Dakota': 'America/Chicago',
    Ohio: 'America/New_York',
    Oklahoma: 'America/Chicago',
    Oregon: 'America/Los_Angeles',
    Pennsylvania: 'America/New_York',
    'Rhode Island': 'America/New_York',
    'South Carolina': 'America/New_York',
    'South Dakota': 'America/Chicago',
    Tennessee: 'America/Chicago',
    Texas: 'America/Chicago',
    Utah: 'America/Denver',
    Vermont: 'America/New_York',
    Virginia: 'America/New_York',
    Washington: 'America/Los_Angeles',
    'West Virginia': 'America/New_York',
    Wisconsin: 'America/Chicago',
    Wyoming: 'America/Denver',
  },
  CA: {
    Alberta: 'America/Edmonton',
    'British Columbia': 'America/Vancouver',
    Manitoba: 'America/Winnipeg',
    'New Brunswick': 'America/Halifax',
    'Newfoundland and Labrador': 'America/St_Johns',
    'Northwest Territories': 'America/Edmonton',
    'Nova Scotia': 'America/Halifax',
    Nunavut: 'America/Toronto',
    Ontario: 'America/Toronto',
    'Prince Edward Island': 'America/Halifax',
    Quebec: 'America/Toronto',
    Saskatchewan: 'America/Regina',
    Yukon: 'America/Whitehorse',
  },
  AU: {
    'Australian Capital Territory': 'Australia/Sydney',
    'New South Wales': 'Australia/Sydney',
    'Northern Territory': 'Australia/Darwin',
    Queensland: 'Australia/Brisbane',
    'South Australia': 'Australia/Adelaide',
    Tasmania: 'Australia/Hobart',
    Victoria: 'Australia/Melbourne',
    'Western Australia': 'Australia/Perth',
  },
};

/**
 * The zone a state or province keeps, in any stored spelling of either, or null when the table
 * has no answer (an unknown region, a country without per-region zones, or no region at all).
 */
export function regionZone(
  country: string | null | undefined,
  region: string | null | undefined,
): string | null {
  const market = marketFor(country);
  const found = regionFor(country, region);
  if (!market || !found) return null;
  return REGION_TIMEZONES[market.code]?.[found.name] ?? null;
}

/**
 * The zone a place keeps when nobody has said otherwise: its region's, else its country's only
 * one, else null. Null means "ask" - a country with several zones and no region is a guess.
 */
export function zoneForPlace(
  country: string | null | undefined,
  region: string | null | undefined,
): string | null {
  return regionZone(country, region) ?? unambiguousZoneFor(country);
}

/*
  What people call each clock. "America/Boise" is a database key; "Mountain time" is what a
  person in Boise says. Where a zone keeps no daylight saving and its neighbours do, that is
  said too, because it is the part that surprises people twice a year.
*/
const ZONE_WORDS: Readonly<Record<string, string>> = {
  'America/New_York': 'Eastern time',
  'America/Toronto': 'Eastern time',
  'America/Chicago': 'Central time',
  'America/Winnipeg': 'Central time',
  'America/Regina': 'Central time, no daylight saving',
  'America/Denver': 'Mountain time',
  'America/Boise': 'Mountain time',
  'America/Edmonton': 'Mountain time',
  'America/Phoenix': 'Mountain time, no daylight saving',
  'America/Whitehorse': 'Yukon time, no daylight saving',
  'America/Los_Angeles': 'Pacific time',
  'America/Vancouver': 'Pacific time',
  'America/Anchorage': 'Alaska time',
  'Pacific/Honolulu': 'Hawaii time',
  'America/Halifax': 'Atlantic time',
  'America/St_Johns': 'Newfoundland time',
  'Asia/Kolkata': 'India time',
  'Europe/London': 'UK time',
  'Asia/Dubai': 'Gulf time',
  'Asia/Singapore': 'Singapore time',
  'Australia/Sydney': 'Eastern Australia time',
  'Australia/Melbourne': 'Eastern Australia time',
  'Australia/Hobart': 'Eastern Australia time',
  'Australia/Brisbane': 'Eastern Australia time, no daylight saving',
  'Australia/Adelaide': 'Central Australia time',
  'Australia/Darwin': 'Central Australia time, no daylight saving',
  'Australia/Perth': 'Western Australia time',
  'Pacific/Auckland': 'New Zealand time',
  'Pacific/Chatham': 'Chatham Islands time',
};

/**
 * A zone in plain words: "Mountain time (Boise)", "Mountain time (Phoenix), no daylight saving". Never the raw key alone, unless the zone is
 * one this file has no words for - then the key, readable, rather than a wrong guess.
 */
export function zoneInWords(zone: string): string {
  const city = (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
  const words = ZONE_WORDS[zone];
  if (!words) return zone.replace(/_/g, ' ');
  // "Mountain time (Phoenix), no daylight saving" - the city belongs next to the clock's name.
  const [family, ...note] = words.split(', ');
  return [`${family} (${city})`, ...note].join(', ');
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
function offsetAt(zone: string, at: Date): string {
  let f = offsetFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    offsetFormatters.set(zone, f);
  }
  return f.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
}

/**
 * Do two zones keep the same clock - the same offset, the same daylight-saving days - for the
 * next year? America/Denver and America/Boise do; America/Vancouver and America/Whitehorse do
 * not (Yukon stopped changing its clocks in 2020).
 *
 * The question that matters for a venue is not "is this the key the table would have picked"
 * but "would any show time read differently". A venue in Boise stored as America/Denver sells
 * every show at the right time, and flagging it would teach people to ignore the flag.
 */
export function sameClock(a: string, b: string, from: Date = new Date()): boolean {
  if (a === b) return true;
  try {
    // Daily for a year catches every daylight-saving change on either side.
    for (let day = 0; day <= 366; day += 1) {
      const at = new Date(from.getTime() + day * 86_400_000);
      if (offsetAt(a, at) !== offsetAt(b, at)) return false;
    }
    return true;
  } catch {
    // A zone the runtime cannot resolve keeps no clock anybody can rely on.
    return false;
  }
}
