import { describe, expect, it } from 'vitest';
import {
  SPACE_KINDS,
  SPACE_KIND_VALUES,
  effectiveSpaceKind,
  templatesForSpaceKind,
} from './space-kind';
import { VENUE_TEMPLATES } from './venue-templates';

describe('space kind', () => {
  it('never offers an arena template to a cinema screen', () => {
    const fits = templatesForSpaceKind('CINEMA_SCREEN')!;
    expect(fits).toEqual(['CINEMA', 'PREMIUM_CINEMA']);
    expect(fits).not.toContain('ARENA');
    expect(fits).not.toContain('BASKETBALL');
  });

  it('offers no seat map at all to a standing space', () => {
    expect(templatesForSpaceKind('STANDING')).toEqual([]);
  });

  it('offers arena shapes only to an arena', () => {
    for (const kind of ['CINEMA_SCREEN', 'SEATED_HALL', 'STANDING'] as const) {
      expect(templatesForSpaceKind(kind)).not.toContain('ARENA');
    }
    expect(templatesForSpaceKind('ARENA')).toContain('ARENA');
  });

  it('keeps every template reachable from some kind, and offers all when the kind is unknown', () => {
    const reachable = new Set(SPACE_KIND_VALUES.flatMap((k) => templatesForSpaceKind(k)!));
    for (const t of VENUE_TEMPLATES) expect(reachable.has(t.key)).toBe(true);
    expect(templatesForSpaceKind(null)).toBeNull();
  });

  it('reads a cinema screen written before the kind was stored as a cinema screen', () => {
    expect(effectiveSpaceKind({ kind: null, cinemaId: 'c1' })).toBe('CINEMA_SCREEN');
    expect(effectiveSpaceKind({ kind: null, cinemaId: null })).toBeNull();
    expect(effectiveSpaceKind({ kind: 'ARENA', cinemaId: null })).toBe('ARENA');
  });

  it('describes every kind once', () => {
    expect(SPACE_KINDS.map((k) => k.kind)).toEqual([...SPACE_KIND_VALUES]);
  });
});
