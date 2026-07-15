// Pure, configurable event-timing business rules shared by the ticket wallet and
// Event Day Mode. No React, no DOM — directly unit-testable. Given a start time
// and "now", it classifies the event into a phase and produces a countdown label.

export interface EventTimingConfig {
  /** Show "Event Day Mode" within this many hours of start (and while live). */
  eventDayWindowHours: number;
  /** Minutes before start that the gate is considered opening. */
  gateOpensBeforeMin: number;
  /** Minutes before start that doors are considered open. */
  doorsOpenBeforeMin: number;
  /** Minutes after start that the event is still considered "happening now". */
  liveGraceMin: number;
}

export const DEFAULT_EVENT_TIMING: EventTimingConfig = {
  eventDayWindowHours: 24,
  gateOpensBeforeMin: 90,
  doorsOpenBeforeMin: 60,
  liveGraceMin: 180,
};

export type EventPhase = 'upcoming' | 'gateOpen' | 'doorsOpen' | 'live' | 'ended';

export interface EventTiming {
  phase: EventPhase;
  /** Whether to surface Event Day Mode prominently (within window or live). */
  isEventDay: boolean;
  /** Human countdown label, e.g. "Starts in", "Doors open", "Happening now". */
  label: string;
  /** Milliseconds until start (negative once started). */
  msToStart: number;
}

const MIN = 60_000;
const HOUR = 3_600_000;

/**
 * Classifies an event relative to `now`. Ordering as start approaches:
 * upcoming → gateOpen (≤ gateOpensBeforeMin) → doorsOpen (≤ doorsOpenBeforeMin)
 * → live (start … start+liveGrace) → ended.
 */
export function eventTiming(
  startsAt: string | Date | number,
  now: number,
  config: EventTimingConfig = DEFAULT_EVENT_TIMING,
): EventTiming {
  const start = new Date(startsAt).getTime();
  const msToStart = start - now;
  const liveEnd = start + config.liveGraceMin * MIN;

  let phase: EventPhase;
  let label: string;
  if (now >= liveEnd) {
    phase = 'ended';
    label = 'Ended';
  } else if (now >= start) {
    phase = 'live';
    label = 'Happening now';
  } else if (msToStart <= config.doorsOpenBeforeMin * MIN) {
    phase = 'doorsOpen';
    label = 'Doors open — starts in';
  } else if (msToStart <= config.gateOpensBeforeMin * MIN) {
    phase = 'gateOpen';
    label = 'Gate opens soon — starts in';
  } else {
    phase = 'upcoming';
    label = 'Starts in';
  }

  const isEventDay =
    phase === 'live' ||
    (phase !== 'ended' && msToStart <= config.eventDayWindowHours * HOUR && msToStart >= 0);

  return { phase, isEventDay, label, msToStart };
}
