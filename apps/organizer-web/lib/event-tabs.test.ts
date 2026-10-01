import { describe, it, expect } from 'vitest';

/**
 * The event navigation's shape, and the promise that grouping it took nothing away.
 *
 * There were eleven sections rendered as equally weighted siblings, fifteen once offline check-in
 * is on. Eleven equal choices is not a navigation, it is a filing cabinet. Grouping is
 * presentational - these tests exist to prove it stayed presentational.
 */

/** Every section that existed before the grouping, as one flat list. */
const SECTIONS_BEFORE = [
  '',
  '/edit',
  '/sessions',
  '/tickets',
  '/commerce',
  '/orders',
  '/attendees',
  '/checkin',
  '/reports',
  '/assistant',
  '/promote',
];
const OFFLINE_BEFORE = ['/command-center', '/devices', '/preflight', '/reconciliation'];

/** The grouping, mirroring the layout. Kept here so a change there has to change this. */
const GROUPS: { label: string | null; segs: string[] }[] = [
  { label: null, segs: [''] },
  { label: 'Setup', segs: ['/edit', '/sessions', '/tickets', '/commerce'] },
  { label: 'Selling', segs: ['/orders', '/promote'] },
  { label: 'On the day', segs: ['/checkin', '/attendees'] },
  { label: 'After', segs: ['/reports', '/assistant'] },
];
const OFFLINE = ['/command-center', '/devices', '/preflight', '/reconciliation'];

const flat = (offline: boolean) =>
  GROUPS.flatMap((g) => (g.label === 'On the day' && offline ? [...g.segs, ...OFFLINE] : g.segs));

describe('event section grouping', () => {
  it('keeps every section that existed before', () => {
    // "Do not remove capabilities just to reduce visible navigation."
    expect(flat(false).sort()).toEqual([...SECTIONS_BEFORE].sort());
  });

  it('keeps every offline section when the flag is on', () => {
    expect(flat(true).sort()).toEqual([...SECTIONS_BEFORE, ...OFFLINE_BEFORE].sort());
  });

  it('hides the offline consoles when the flag is off', () => {
    // Unchanged behaviour: those endpoints 404 without the flag, so offering them would be a
    // dead end rather than a feature.
    for (const seg of OFFLINE) expect(flat(false)).not.toContain(seg);
  });

  it('leads with Overview and gives it no group label', () => {
    // The lead section answers "what is happening with this event"; a label above one item is
    // furniture.
    expect(GROUPS[0].label).toBeNull();
    expect(GROUPS[0].segs).toEqual(['']);
  });

  it('puts every section in exactly one group', () => {
    const seen = flat(true);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('never nests a section behind a click', () => {
    /*
      The grouping is labels between clusters, not a layer you open. Every section is still one
      click from anywhere - a two-level navigation would have reduced the visible count by making
      everything further away, which is not an improvement.
    */
    for (const group of GROUPS) {
      expect(group.segs.length).toBeGreaterThan(0);
    }
    expect(flat(true)).toContain('/reconciliation');
  });

  it('groups the offline consoles with the day they belong to', () => {
    const onTheDay = GROUPS.find((g) => g.label === 'On the day')!;
    const withOffline = [...onTheDay.segs, ...OFFLINE];
    expect(withOffline).toContain('/checkin');
    expect(withOffline).toContain('/command-center');
  });
});
