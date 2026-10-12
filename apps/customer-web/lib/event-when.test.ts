import { describe, expect, it } from 'vitest';
import { dateTime, zoneAbbrev } from '@eticketsgo/web-kit';
import { whenWithZone } from './event-when';

describe('whenWithZone', () => {
  it('names the venue zone after the time', () => {
    const text = whenWithZone('2026-11-07T14:00:00Z', 'Asia/Kolkata', { dateTime, zoneAbbrev });
    expect(text).toMatch(/7:30 pm \(IST\)$|7:30 pm \(GMT\+5:30\)$/);
  });

  it('adds nothing when the venue has no zone', () => {
    const text = whenWithZone('2026-11-07T14:00:00Z', undefined, { dateTime, zoneAbbrev });
    expect(text).not.toContain('(');
  });
});
