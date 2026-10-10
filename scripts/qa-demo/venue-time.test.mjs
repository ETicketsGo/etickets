// Run with: node --test scripts/qa-demo/venue-time.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { venueTimeToInstant } from './venue-time.mjs';

describe('venueTimeToInstant', () => {
  it('reads India time at +05:30', () => {
    assert.equal(
      venueTimeToInstant('2026-11-14', '18:30', 'Asia/Kolkata').toISOString(),
      '2026-11-14T13:00:00.000Z',
    );
  });

  it('follows Boise across the 1 November clock change', () => {
    // Mountain Daylight Time (-06:00) before it, Mountain Standard Time (-07:00) after.
    assert.equal(
      venueTimeToInstant('2026-10-30', '20:00', 'America/Boise').toISOString(),
      '2026-10-31T02:00:00.000Z',
    );
    assert.equal(
      venueTimeToInstant('2026-11-13', '19:30', 'America/Boise').toISOString(),
      '2026-11-14T02:30:00.000Z',
    );
  });
});
