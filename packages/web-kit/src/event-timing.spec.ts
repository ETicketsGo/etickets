import { describe, it, expect } from 'vitest';
import { eventTiming, DEFAULT_EVENT_TIMING } from './event-timing';

// Fixed reference start; drive phases by choosing `now` relative to it.
const START = new Date('2026-07-15T19:00:00.000Z').getTime();
const min = (n: number) => n * 60_000;
const hr = (n: number) => n * 3_600_000;

describe('eventTiming', () => {
  it('is upcoming and not event-day well before start', () => {
    const t = eventTiming(START, START - hr(48));
    expect(t.phase).toBe('upcoming');
    expect(t.isEventDay).toBe(false);
    expect(t.label).toBe('Starts in');
    expect(t.msToStart).toBe(hr(48));
  });

  it('becomes event-day within the 24h window', () => {
    const t = eventTiming(START, START - hr(12));
    expect(t.isEventDay).toBe(true);
    expect(t.phase).toBe('upcoming');
  });

  it('reports gateOpen inside 90 minutes', () => {
    const t = eventTiming(START, START - min(80));
    expect(t.phase).toBe('gateOpen');
    expect(t.isEventDay).toBe(true);
  });

  it('reports doorsOpen inside 60 minutes', () => {
    const t = eventTiming(START, START - min(45));
    expect(t.phase).toBe('doorsOpen');
    expect(t.label).toMatch(/Doors open/);
  });

  it('is live at start and within the grace window', () => {
    expect(eventTiming(START, START).phase).toBe('live');
    expect(eventTiming(START, START + min(90)).phase).toBe('live');
    expect(eventTiming(START, START + min(90)).isEventDay).toBe(true);
    expect(eventTiming(START, START).label).toBe('Happening now');
  });

  it('is ended past the grace window', () => {
    const t = eventTiming(START, START + min(DEFAULT_EVENT_TIMING.liveGraceMin + 1));
    expect(t.phase).toBe('ended');
    expect(t.isEventDay).toBe(false);
    expect(t.label).toBe('Ended');
  });

  it('honours a custom config', () => {
    const t = eventTiming(START, START - hr(2), {
      ...DEFAULT_EVENT_TIMING,
      eventDayWindowHours: 1,
    });
    expect(t.isEventDay).toBe(false); // 2h out, window only 1h
  });
});
