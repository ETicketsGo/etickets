import { describe, expect, it } from 'vitest';
import type { SeatingRoom } from '@eticketsgo/web-kit';
import { seatClassNotice } from './seat-class-notice';

const room = (seatClasses?: SeatingRoom['seatClasses']) => ({ name: 'Screen 1', seatClasses });

describe('what the create wizard says about a seat map on a cinema screen', () => {
  it('names the seat categories that need a class and links to the control', () => {
    const n = seatClassNotice(
      room({
        state: 'MAP_CLASSES',
        unmapped: ['Normal', 'Premium', 'Recliner'],
        fixPath: '/organizer/cinemas/c1/readiness#seat-classes',
      }),
    );
    expect(n?.kind).toBe('MAP_CLASSES');
    expect(n?.title).toBe('Normal, Premium and Recliner need a seat class');
    expect(n?.href).toBe('/organizer/cinemas/c1/readiness#seat-classes');
    expect(n?.linkLabel).toBe('Choose seat classes');
    // The event can still be created: the notice is a warning, not a gate.
    expect(n?.body).toContain('create the event now');
  });

  it('uses the singular for one category', () => {
    const n = seatClassNotice(room({ state: 'MAP_CLASSES', unmapped: ['Gold'], fixPath: '/x' }));
    expect(n?.title).toBe('Gold needs a seat class');
  });

  it('does not send anyone to map classes where no rules cover the place', () => {
    const n = seatClassNotice(room({ state: 'NO_RULES', unmapped: [], fixPath: null }));
    expect(n?.kind).toBe('NO_RULES');
    expect(n?.href).toBeNull();
    expect(n?.body).toContain('will not change this');
    expect(n?.body).toContain('not a cinema screen');
  });

  it('says nothing for a space that is not regulated, or an older API that does not answer', () => {
    expect(seatClassNotice(room({ state: 'NONE', unmapped: [], fixPath: null }))).toBeNull();
    expect(seatClassNotice(room(undefined))).toBeNull();
    expect(seatClassNotice(undefined)).toBeNull();
  });

  it('keeps every word ASCII', () => {
    const n = seatClassNotice(room({ state: 'MAP_CLASSES', unmapped: ['A'], fixPath: '/x' }));
    // eslint-disable-next-line no-control-regex
    expect(`${n?.title}${n?.body}`).toMatch(/^[\x00-\x7F]*$/);
  });
});
