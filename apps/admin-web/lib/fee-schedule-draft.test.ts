import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError, pushToast, type FeeScheduleBand } from '@eticketsgo/web-kit';
import {
  bandFromRow,
  bandsFromRows,
  failureMessage,
  formatMajor,
  issuesFromError,
  newRow,
  parseMajor,
  rowFromBand,
} from './fee-schedule-draft';

/**
 * The draft fee schedule editor: amounts typed in the currency, one message per failure, and
 * a toast list that does not stack copies of one error.
 */

const band = (minMinor: number, maxMinor: number | null): FeeScheduleBand => ({
  key: `k${minMinor}`,
  sourceId: `fr${minMinor}`,
  minMinor,
  maxMinor,
  feeType: 'FLAT',
  feeMinor: 199,
  feePercentBps: null,
  minFeeMinor: null,
  maxFeeMinor: null,
  country: 'United States',
  region: '*',
  active: true,
});

describe('amounts in the currency, not in minor units', () => {
  it('reads USD cent boundaries exactly', () => {
    expect(parseMajor('0', 'USD')).toBe(0);
    expect(parseMajor('0.00', 'USD')).toBe(0);
    expect(parseMajor('99.99', 'USD')).toBe(9_999);
    expect(parseMajor('100', 'USD')).toBe(10_000);
    expect(parseMajor('100.00', 'USD')).toBe(10_000);
    expect(parseMajor('1,000.5', 'USD')).toBe(100_050);
  });

  it('refuses what is not an amount in the currency', () => {
    expect(parseMajor('', 'USD')).toBeNull();
    expect(parseMajor('-1', 'USD')).toBeNull();
    expect(parseMajor('99.999', 'USD')).toBeNull();
    expect(parseMajor('ten', 'USD')).toBeNull();
    expect(parseMajor('100.5', 'JPY')).toBeNull();
    expect(parseMajor('100', 'JPY')).toBe(100);
  });

  it('shows a stored band as it is read: $100.00, never 10000', () => {
    const row = rowFromBand(band(10_000, null), 'USD');
    expect(row.from).toBe('100.00');
    expect(row.to).toBe('');
    expect(formatMajor(9_999, 'USD')).toBe('99.99');
  });

  it('round-trips a band through the form without moving a boundary', () => {
    const b = band(10_000, 99_999);
    expect(bandFromRow(rowFromBand(b, 'USD'), 'USD').band).toEqual(b);
  });

  it('a new band starts one cent after the highest end', () => {
    const rows = [rowFromBand(band(0, 9_999), 'USD')];
    expect(newRow(rows, 'USD', 'United States').from).toBe('100.00');
  });

  it('says what is wrong with a half-typed row, and sends nothing while one exists', () => {
    const row = { ...rowFromBand(band(0, 9_999), 'USD'), to: '50', from: '100' };
    expect(bandFromRow(row, 'USD').problems[0]).toContain('end amount must be more');
    expect(bandsFromRows([row], 'USD')).toBeNull();
  });

  it('reads each way of charging', () => {
    const base = rowFromBand(band(0, null), 'USD');
    const pct = bandFromRow({ ...base, feeType: 'PERCENT', percent: '2.5', fee: '' }, 'USD').band!;
    expect(pct).toMatchObject({ feeType: 'PERCENT', feeMinor: 0, feePercentBps: 250 });
    const combined = bandFromRow(
      { ...base, feeType: 'COMBINED', percent: '3', fee: '0.50' },
      'USD',
    ).band!;
    expect(combined).toMatchObject({ feeMinor: 50, feePercentBps: 300 });
    const perTicket = bandFromRow(
      { ...base, feeType: 'FIXED_PER_TICKET', fee: '1.50', maxFee: '20' },
      'USD',
    ).band!;
    expect(perTicket).toMatchObject({ feeMinor: 150, feePercentBps: null, maxFeeMinor: 2_000 });
  });
});

describe('one plain message per failed operation', () => {
  it('never shows a server error as it came', () => {
    const err = new ApiRequestError(
      'ERROR',
      'TypeError: cannot read x of undefined',
      {},
      'c1',
      500,
    );
    const text = failureMessage(err, 'publish the schedule');
    expect(text).toBe(
      'Could not publish the schedule: something went wrong on our side. Nothing was changed. Try again in a moment.',
    );
    expect(text).not.toContain('TypeError');
  });

  it('shows the API sentence for a refusal written for people', () => {
    const message = 'The live USD fee schedule was changed after this draft was started.';
    const err = new ApiRequestError('FEE_SCHEDULE_STALE', message, { reason: 'STALE' }, 'c', 409);
    expect(failureMessage(err, 'publish the schedule')).toBe(message);
  });

  it('a request-shape refusal is not shown in its technical words', () => {
    const err = new ApiRequestError(
      'VALIDATION_FAILED',
      'bands.0.minMinor: Expected number',
      {},
      'c',
      400,
    );
    expect(failureMessage(err, 'save the draft')).not.toContain('bands.0');
  });

  it('a refused publish hands its problems to the check panel', () => {
    const issues = [{ code: 'GAP', severity: 'error', message: 'x', bandKeys: [], place: 'US' }];
    const err = new ApiRequestError('FEE_SCHEDULE_INVALID', 'm', { issues }, 'c', 409);
    expect(issuesFromError(err)).toEqual(issues);
    expect(issuesFromError(new Error('x'))).toBeNull();
  });
});

describe('no duplicate error toasts', () => {
  it('the same error pushed again while it is shown is not added a second time', () => {
    const first = pushToast([], { id: 1, message: 'Could not save.', tone: 'error' });
    const again = pushToast(first.list, { id: 2, message: 'Could not save.', tone: 'error' });
    expect(again.list).toHaveLength(1);
    expect(again).toMatchObject({ id: 1, duplicate: true });
  });

  it('a different message, or the same words as a success, is still shown', () => {
    const one = pushToast([], { id: 1, message: 'Could not save.', tone: 'error' });
    expect(pushToast(one.list, { id: 2, message: 'Saved.', tone: 'success' }).list).toHaveLength(2);
    expect(
      pushToast(one.list, { id: 3, message: 'Could not save.', tone: 'success' }).list,
    ).toHaveLength(2);
  });
});

describe('publish request', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('one failed publish is one request and one error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        reply(409, { code: 'FEE_SCHEDULE_STALE', message: 'Changed.', details: {} }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.admin.feeSchedules.publish('d1')).rejects.toMatchObject({
      code: 'FEE_SCHEDULE_STALE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /\/admin\/fee-schedules\/drafts\/d1\/publish$/,
    );
  });
});
