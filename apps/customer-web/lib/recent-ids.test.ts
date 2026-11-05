import { describe, expect, it } from 'vitest';
import { hashKey } from '@tanstack/react-query';
import { parseRecentIds } from './recent';
import { recentEventsQuery } from './storefront-queries';

/**
 * "Recently viewed" is drawn by the server from a cookie of event ids, so the rail is in the
 * first paint instead of pushing Explore down a second later. The cookie is read back here.
 */
describe('parseRecentIds', () => {
  it('reads the ids in order, URI-encoded or not', () => {
    expect(parseRecentIds('cmuztd0qx09w3xp8zjvfm66pf,cmv6mdryv01eb118oxg1hv9e9')).toEqual([
      'cmuztd0qx09w3xp8zjvfm66pf',
      'cmv6mdryv01eb118oxg1hv9e9',
    ]);
    expect(parseRecentIds(encodeURIComponent('aaaaaaaaaa,bbbbbbbbbb'))).toEqual([
      'aaaaaaaaaa',
      'bbbbbbbbbb',
    ]);
  });

  it('drops anything that is not an id and keeps at most eight', () => {
    expect(parseRecentIds('<script>,short,ok_id_12345')).toEqual(['ok_id_12345']);
    const many = Array.from({ length: 12 }, (_, i) => `event-id-${i}00`).join(',');
    expect(parseRecentIds(many)).toHaveLength(8);
    expect(parseRecentIds(undefined)).toEqual([]);
  });

  it('asks for the same key the browser hook asks for', () => {
    expect(hashKey(recentEventsQuery(['a1b2c3d4e5', 'f6g7h8i9j0']).queryKey)).toBe(
      hashKey(['events', 'by-id', 'a1b2c3d4e5,f6g7h8i9j0']),
    );
  });
});
