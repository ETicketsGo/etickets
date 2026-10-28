import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setStepUpHandler } from '@eticketsgo/web-kit';
import {
  bandName,
  bandPlace,
  bandStatus,
  deleteConfirmation,
  draftBandName,
  rangeText,
} from './fee-bands';

/**
 * Booking-fee bands in the console: the name an operator reads, the delete confirmation, and
 * the delete request (step-up and refusal handling).
 */

const INR_BAND = {
  minMinor: 0,
  maxMinor: 49_900,
  currency: 'INR',
  country: 'India',
  region: '*',
  active: true,
};

describe('band name', () => {
  it('uses the name the API wrote', () => {
    expect(bandName({ ...INR_BAND, displayLabel: 'Tickets ₹0 - ₹499' })).toBe('Tickets ₹0 - ₹499');
  });

  it('writes the name from the range when the API did not send one', () => {
    expect(bandName(INR_BAND)).toBe('Tickets ₹0 - ₹499');
    expect(bandName({ minMinor: 5_000, maxMinor: null, currency: 'USD' })).toBe(
      'Tickets $50.00 and above',
    );
  });

  it('ignores a stale stored label', () => {
    // The stored label said $9.99; the band now runs to $14.99.
    const rule = { minMinor: 0, maxMinor: 1_499, currency: 'USD', label: '$0-$9.99' };
    expect(bandName(rule)).toBe('Tickets $0.00 - $14.99');
  });

  it('previews the name while the range is typed', () => {
    expect(draftBandName({ minMinor: '20000', maxMinor: '49900' }, 'INR')).toBe(
      'Tickets ₹200 - ₹499',
    );
    expect(draftBandName({ minMinor: '5000', maxMinor: '' }, 'USD')).toBe(
      'Tickets $50.00 and above',
    );
    expect(draftBandName({ minMinor: 'abc', maxMinor: '' }, 'USD')).toBe('');
    expect(draftBandName({ minMinor: '0', maxMinor: '9' }, null)).toBe('');
  });

  it('describes where a band applies', () => {
    expect(bandPlace({ country: 'India', region: 'Telangana' })).toBe('Telangana, India');
    expect(bandPlace({ country: 'India', region: '*' })).toBe('India');
    expect(bandPlace({ country: '*', region: '*' })).toBe('Everywhere');
  });

  it('formats the preview range with the same formatter', () => {
    expect(rangeText(1_000, 2_499, 'USD')).toBe('$10.00 - $24.99');
    expect(rangeText(100_000, null, 'INR')).toBe('₹1,000 and above');
  });
});

describe('delete confirmation', () => {
  it('names the band and the place, and says bookings keep their fee', () => {
    const c = deleteConfirmation(INR_BAND);
    expect(c.title).toBe('Delete fee band - Tickets ₹0 - ₹499');
    expect(c.body).toContain('"Tickets ₹0 - ₹499" for India');
    expect(c.body).toContain('Bookings already made keep the fee they were charged.');
    expect(c.body).toContain('refused if it would leave orders with no band');
  });

  it('says an inactive band charges nobody', () => {
    expect(deleteConfirmation({ ...INR_BAND, active: false }).body).toContain(
      'It is switched off, so it charges nobody now.',
    );
  });

  it('is plain ASCII apart from the currency sign', () => {
    const { title, body } = deleteConfirmation(INR_BAND);
    expect(/^[\x20-\x7e]*$/.test(`${title}${body}`.replaceAll('₹', ''))).toBe(true);
  });

  it('shows a deleted band as Deleted', () => {
    expect(bandStatus({ active: false, deletedAt: '2026-10-28T00:00:00Z' })).toBe('Deleted');
    expect(bandStatus({ active: true })).toBe('Yes');
    expect(bandStatus({ active: false })).toBe('No');
  });
});

describe('delete request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setStepUpHandler(null);
  });

  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('sends DELETE to the band and repeats it once after a fresh code', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply(403, { code: 'MFA_STEP_UP_REQUIRED', message: 'Confirm it is you.' }),
      )
      .mockResolvedValueOnce(reply(200, { id: 'fr1', deletedAt: '2026-10-28T00:00:00Z' }));
    vi.stubGlobal('fetch', fetchMock);
    const ask = vi.fn(async () => true);
    setStepUpHandler(ask);

    const out = await api.admin.deleteFeeRule('fr1');
    expect(out).toMatchObject({ id: 'fr1' });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toMatch(/\/admin\/fee-rules\/fr1$/);
    expect(init.method).toBe('DELETE');
  });

  it('keeps the API sentence when the delete would leave a gap', async () => {
    const message =
      'Deleting "Tickets ₹500 - ₹999" would leave orders between ₹499 and ₹1,000 with no INR band in India.';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(reply(409, { code: 'CONFLICT', message, details: {} })),
    );
    await expect(api.admin.deleteFeeRule('fr1')).rejects.toMatchObject({ message });
  });

  it('asks for deleted bands only when told to', async () => {
    const fetchMock = vi.fn(async (_url: string) => reply(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await api.admin.feeRules();
    await api.admin.feeRules({ includeDeleted: true });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/admin\/fee-rules$/);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/admin\/fee-rules\?includeDeleted=true$/);
  });
});
