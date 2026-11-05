import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@eticketsgo/web-kit';
import {
  BLANK_DRAFT,
  bpsToPercent,
  canDeactivate,
  conflictingPolicyId,
  currencyRequired,
  draftToCreateBody,
  draftToTerms,
  feePolicyApi,
  isConflict,
  ordersLabel,
  percentToBps,
  plainAmount,
  termsLabel,
  toMinorUnits,
  type FeePolicyDraft,
} from './fee-policies';
import { registerStepUp } from './step-up-bridge';

/**
 * Platform fee policies: the conversions an operator cannot see, the words they read, and the
 * request layer's step-up and conflict handling.
 */

const draft = (patch: Partial<FeePolicyDraft>): FeePolicyDraft => ({
  ...BLANK_DRAFT,
  targetId: 'evt_1',
  reason: 'Charity screening agreed with the owner',
  ...patch,
});

const terms = {
  feeMinor: null,
  percentBps: null,
  minFeeMinor: null,
  maxFeeMinor: null,
  currency: null,
};

describe('money and percentages', () => {
  it('turns typed major units into minor units', () => {
    expect(toMinorUnits('10', 'INR')).toBe(1000);
    expect(toMinorUnits('10.5', 'INR')).toBe(1050);
    expect(toMinorUnits('0.07', 'USD')).toBe(7);
    expect(toMinorUnits('500', 'JPY')).toBe(500);
  });

  it('refuses what is not a plain amount', () => {
    for (const bad of ['', '-1', '10.123', 'ten', '1e3', '10,00']) {
      expect(toMinorUnits(bad, 'INR')).toBeNull();
    }
    expect(toMinorUnits('5.5', 'JPY')).toBeNull();
  });

  it('turns a percentage into basis points and back', () => {
    expect(percentToBps('2.5')).toBe(250);
    expect(percentToBps('5')).toBe(500);
    expect(percentToBps('0.01')).toBe(1);
    expect(percentToBps('2.555')).toBeNull();
    expect(bpsToPercent(250)).toBe('2.5');
    expect(bpsToPercent(500)).toBe('5');
  });

  it('writes amounts in ASCII with the currency code', () => {
    expect(plainAmount(1000, 'INR')).toBe('10.00 INR');
    expect(plainAmount(250, null)).toBe('2.50');
  });
});

describe('the terms in words', () => {
  it('says what each kind of policy does', () => {
    expect(termsLabel({ ...terms, kind: 'WAIVE' })).toBe('Fee waived');
    expect(termsLabel({ ...terms, kind: 'FIXED', feeMinor: 1000, currency: 'INR' })).toBe(
      'Fixed fee 10.00 INR',
    );
    expect(termsLabel({ ...terms, kind: 'PERCENT', percentBps: 500 })).toBe('5%');
    expect(
      termsLabel({
        ...terms,
        kind: 'PERCENT',
        percentBps: 500,
        minFeeMinor: 200,
        maxFeeMinor: 2000,
        currency: 'INR',
      }),
    ).toBe('5% (min 2.00, max 20.00 INR)');
  });

  it('is plain ASCII', () => {
    const label = termsLabel({ ...terms, kind: 'FIXED', feeMinor: 1000, currency: 'INR' });
    expect(/^[\x20-\x7e]*$/.test(label)).toBe(true);
  });

  it('counts orders against the limit', () => {
    expect(ordersLabel({ usedOrders: 3, maxOrders: 10 })).toBe('3 / 10 orders');
    expect(ordersLabel({ usedOrders: 3, maxOrders: null })).toBe('No limit');
  });

  it('offers deactivation only while the policy is live or waiting', () => {
    expect(canDeactivate({ effectiveStatus: 'ACTIVE' })).toBe(true);
    expect(canDeactivate({ effectiveStatus: 'SCHEDULED' })).toBe(true);
    expect(canDeactivate({ effectiveStatus: 'EXPIRED' })).toBe(false);
    expect(canDeactivate({ effectiveStatus: 'EXHAUSTED' })).toBe(false);
    expect(canDeactivate({ effectiveStatus: 'INACTIVE' })).toBe(false);
  });
});

describe('the form', () => {
  it('sends a waiver for an event with no amounts and no currency', () => {
    const { body, errors } = draftToCreateBody(draft({}));
    expect(errors).toEqual({});
    expect(body).toEqual({
      scope: 'EVENT',
      eventId: 'evt_1',
      kind: 'WAIVE',
      reason: 'Charity screening agreed with the owner',
    });
  });

  it('sends an organizer target as organizationId', () => {
    const { body } = draftToCreateBody(draft({ scope: 'ORGANIZATION', targetId: 'org_1' }));
    expect(body?.organizationId).toBe('org_1');
    expect(body?.eventId).toBeUndefined();
  });

  it('needs a currency for a fixed fee and for percentage bounds only', () => {
    expect(currencyRequired({ kind: 'FIXED', minAmount: '', maxAmount: '' })).toBe(true);
    expect(currencyRequired({ kind: 'PERCENT', minAmount: '', maxAmount: '' })).toBe(false);
    expect(currencyRequired({ kind: 'PERCENT', minAmount: '2', maxAmount: '' })).toBe(true);
    expect(currencyRequired({ kind: 'WAIVE', minAmount: '', maxAmount: '' })).toBe(false);
    expect(draftToTerms(draft({ kind: 'FIXED', fixedAmount: '10' })).errors.currency).toBeTruthy();
  });

  it('converts a fixed fee and a percentage with bounds', () => {
    expect(
      draftToTerms(draft({ kind: 'FIXED', fixedAmount: '10.50', currency: 'inr' })).terms,
    ).toMatchObject({ kind: 'FIXED', feeMinor: 1050, currency: 'INR' });
    expect(
      draftToTerms(
        draft({
          kind: 'PERCENT',
          percent: '2.5',
          minAmount: '2',
          maxAmount: '20',
          currency: 'INR',
        }),
      ).terms,
    ).toMatchObject({ percentBps: 250, minFeeMinor: 200, maxFeeMinor: 2000 });
  });

  it('refuses a percentage outside 0 to 100 and bounds the wrong way round', () => {
    expect(draftToTerms(draft({ kind: 'PERCENT', percent: '0' })).errors.percent).toBeTruthy();
    expect(draftToTerms(draft({ kind: 'PERCENT', percent: '101' })).errors.percent).toBeTruthy();
    expect(
      draftToTerms(
        draft({ kind: 'PERCENT', percent: '5', minAmount: '20', maxAmount: '2', currency: 'INR' }),
      ).errors.maxAmount,
    ).toBeTruthy();
  });

  it('needs a target, a reason of 10 characters and a sensible window', () => {
    const now = new Date('2026-10-26T10:00:00Z');
    const { errors } = draftToCreateBody(
      draft({
        targetId: ' ',
        reason: 'too short',
        endsAt: '2026-10-01T10:00',
        maxOrders: '0',
      }),
      now,
    );
    expect(Object.keys(errors).sort()).toEqual(['endsAt', 'maxOrders', 'reason', 'targetId']);
  });

  it('sends dates as ISO instants and the order limit as a number', () => {
    const { body } = draftToCreateBody(
      draft({
        startsAt: '2026-11-01T09:00',
        endsAt: '2026-11-30T21:00',
        maxOrders: '100',
        approvalReference: ' OPS-42 ',
      }),
    );
    expect(body?.startsAt).toBe(new Date('2026-11-01T09:00').toISOString());
    expect(body?.endsAt).toBe(new Date('2026-11-30T21:00').toISOString());
    expect(body?.maxOrders).toBe(100);
    expect(body?.approvalReference).toBe('OPS-42');
  });
});

describe('the request layer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    registerStepUp(null, null);
  });

  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('asks for a fresh code on MFA_STEP_UP_REQUIRED and repeats the request once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply(403, { code: 'MFA_STEP_UP_REQUIRED', message: 'Confirm it is you.' }),
      )
      .mockResolvedValueOnce(reply(200, { id: 'p1' }));
    vi.stubGlobal('fetch', fetchMock);
    const ask = vi.fn().mockResolvedValue(true);
    registerStepUp(ask, null);

    const out = await feePolicyApi.deactivate('p1', {
      reason: 'Promotion ended early',
      version: 3,
    });
    expect(out).toEqual({ id: 'p1' });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toMatch(/\/admin\/platform-fee-policies\/p1\/deactivate$/);
    expect(JSON.parse(init.body)).toEqual({ reason: 'Promotion ended early', version: 3 });
  });

  it('gives up when the operator cancels the code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(reply(403, { code: 'MFA_STEP_UP_REQUIRED', message: 'Code.' })),
    );
    registerStepUp(vi.fn().mockResolvedValue(false), null);
    await expect(feePolicyApi.create(draftToCreateBody(draft({})).body!)).rejects.toMatchObject({
      code: 'MFA_STEP_UP_REQUIRED',
    });
  });

  it('keeps the 409 sentence and the conflicting policy id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        reply(409, {
          code: 'CONFLICT',
          message: 'A live policy already covers this event.',
          details: { conflictingPolicyId: 'p9' },
        }),
      ),
    );
    const err = await feePolicyApi.create(draftToCreateBody(draft({})).body!).catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.message).toBe('A live policy already covers this event.');
    expect(isConflict(err)).toBe(true);
    expect(conflictingPolicyId(err)).toBe('p9');
  });

  it('builds the list query from the filters it is given', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        reply(200, { data: [], meta: { page: 1, pageSize: 25, total: 0, totalPages: 0 } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await feePolicyApi.list({ scope: 'EVENT', status: 'EXHAUSTED', q: '', page: 2, pageSize: 25 });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /\/admin\/platform-fee-policies\?scope=EVENT&status=EXHAUSTED&page=2&pageSize=25$/,
    );
  });
});
