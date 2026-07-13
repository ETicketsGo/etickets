/** Small framework-agnostic helpers reused across the apps. */

export function googleMapsUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function googleDirectionsUrl(destination: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

function icsDate(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function icsEscape(v: string): string {
  return v.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
}

/** Builds a downloadable .ics calendar data URL for an event. */
export function buildIcsDataUrl(input: {
  title: string;
  description?: string;
  location?: string;
  start: string | Date;
  end?: string | Date;
}): string {
  const start = new Date(input.start);
  const end = input.end ? new Date(input.end) : new Date(start.getTime() + 2 * 3600 * 1000);
  const stamp = new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ETicketsGo//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${icsDate(start)}-${icsEscape(input.title).slice(0, 16)}@eticketsgo`,
    `DTSTAMP:${icsDate(stamp)}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(input.title)}`,
    input.location ? `LOCATION:${icsEscape(input.location)}` : '',
    input.description ? `DESCRIPTION:${icsEscape(input.description)}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join('\r\n'))}`;
}

export interface CountdownParts {
  total: number;
  isPast: boolean;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function countdownParts(target: string | Date, from: number): CountdownParts {
  const total = Math.max(0, new Date(target).getTime() - from);
  const s = Math.floor(total / 1000);
  return {
    total,
    isPast: total <= 0,
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  };
}

/** A calm, deterministic gradient class stands in for event artwork. */
const GRADIENTS = [
  'from-blue-500/25 to-indigo-500/10',
  'from-emerald-500/25 to-teal-500/10',
  'from-orange-500/25 to-amber-500/10',
  'from-fuchsia-500/25 to-purple-500/10',
  'from-rose-500/25 to-pink-500/10',
  'from-cyan-500/25 to-sky-500/10',
];

export function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}
