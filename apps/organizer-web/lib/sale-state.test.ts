import { describe, expect, it, vi } from 'vitest';
import { api } from '@eticketsgo/web-kit';
import type { SaleReason } from '@eticketsgo/shared-types';
import { eventSaleStates, saleTone, saleViewOf } from './sale-state';

const reason = (over: Partial<SaleReason> = {}): SaleReason => ({
  code: 'SEAT_CLASS_UNMAPPED',
  text: 'seat classes not mapped',
  message: 'Seat category Standard needs a regulatory seat class.',
  owner: 'ORGANIZER',
  fixPath: '/organizer/cinemas/c1/readiness#seat-classes',
  ticketTypeIds: [],
  affectedSessions: 1,
  ...over,
});

/**
 * The event list's chip and every other screen read `saleViewOf`. What it must never do is
 * call a partly selling event "Selling", or say anything hopeful without an answer.
 */
describe('saleViewOf', () => {
  it('Selling only for SELLING', () => {
    expect(saleViewOf({ state: 'SELLING', reasons: [] })).toMatchObject({
      selling: true,
      label: 'Selling',
      tone: 'success',
      detail: null,
    });
  });

  it('PARTIAL is "Partly selling: <reason>", with the sentence and the fix', () => {
    const v = saleViewOf({ state: 'PARTIAL', reasons: [reason()] });
    expect(v.selling).toBe(false);
    expect(v.label).toBe('Partly selling: seat classes not mapped');
    expect(v.tone).toBe('info');
    expect(v.detail).toBe(reason().message);
    expect(v.fixPath).toBe(reason().fixPath);
  });

  it('gives no fix link for a reason only the platform can clear', () => {
    const v = saleViewOf({
      state: 'NOT_SELLING',
      reasons: [reason({ owner: 'PLATFORM', fixPath: '/somewhere' })],
    });
    expect(v.fixPath).toBeNull();
  });

  it('says checking or unavailable without an answer', () => {
    expect(saleViewOf(undefined)).toMatchObject({ selling: false, label: 'Checking sale status' });
    expect(saleViewOf(undefined, { failed: true }).label).toBe('Sale status unavailable');
  });

  it('keeps amber for faults, not for where an event is in its life', () => {
    expect(
      saleTone({ state: 'NOT_SELLING', reasons: [reason({ code: 'EVENT_NOT_PUBLISHED' })] }),
    ).toBe('neutral');
    expect(saleTone({ state: 'NOT_SELLING', reasons: [reason({ code: 'SESSION_PAUSED' })] })).toBe(
      'warning',
    );
  });
});

describe('eventSaleStates', () => {
  it('asks in pages of 50, once per id', async () => {
    const spy = vi.spyOn(api.events, 'saleStates').mockImplementation(async (_org, ids) => ({
      events: ids.map((eventId) => ({
        eventId,
        state: 'SELLING' as const,
        reasons: [],
        sessions: { upcoming: 1, selling: 1, partial: 0, notSelling: 0 },
      })),
    }));
    const ids = Array.from({ length: 120 }, (_, i) => `e${i}`);
    const out = await eventSaleStates('org1', [...ids, 'e0']);
    expect(spy.mock.calls.map(([, part]) => part.length)).toEqual([50, 50, 20]);
    expect(out).toHaveLength(120);
    spy.mockRestore();
  });
});
