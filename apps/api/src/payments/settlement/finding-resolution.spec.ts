import { checkResolution, claimsProviderFact, FINDING_RESOLUTIONS } from './finding-resolution';

/**
 * unit — what an operator must supply to close a money exception.
 *
 * The policy is a pure function so it can be read and argued with on its own, rather than being
 * a validation detail buried in a controller.
 */

describe('which dispositions claim something about the provider', () => {
  it('the two that name a provider observation do', () => {
    expect(claimsProviderFact('PROVIDER_CONFIRMED_SENT')).toBe(true);
    expect(claimsProviderFact('PROVIDER_CONFIRMED_NOT_SENT')).toBe(true);
  });

  it('the two that do not, do not', () => {
    /*
      SETTLED_OUTSIDE_PLATFORM says money reached the organizer by another route; CANNOT_ESTABLISH
      says nobody could find out. Demanding a provider reference for either would force an
      operator to invent one, and an invented reference is worse than an open finding.
    */
    expect(claimsProviderFact('SETTLED_OUTSIDE_PLATFORM')).toBe(false);
    expect(claimsProviderFact('CANNOT_ESTABLISH')).toBe(false);
  });

  it('covers every disposition, so a new one cannot be missed', () => {
    for (const r of FINDING_RESOLUTIONS) expect(typeof claimsProviderFact(r)).toBe('boolean');
    expect(FINDING_RESOLUTIONS).toHaveLength(4);
  });
});

describe('a reason is always required', () => {
  it('refuses an empty or missing reason', () => {
    expect(checkResolution({ resolution: 'CANNOT_ESTABLISH' }).ok).toBe(false);
    expect(checkResolution({ resolution: 'CANNOT_ESTABLISH', note: '' }).ok).toBe(false);
    expect(checkResolution({ resolution: 'CANNOT_ESTABLISH', note: '   ' }).ok).toBe(false);
  });

  it('refuses a reason too short to mean anything', () => {
    // The next reader is a person. "ok" is not a disposition.
    const out = checkResolution({ resolution: 'CANNOT_ESTABLISH', note: 'ok' });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/at least/i);
  });

  it('accepts a real reason', () => {
    const out = checkResolution({
      resolution: 'CANNOT_ESTABLISH',
      note: 'Checked the dashboard and support ticket; no record either way after 14 days.',
    });
    expect(out.ok).toBe(true);
    expect(out.ok === true && out.evidenceRef).toBeNull();
  });
});

describe('evidence is required exactly where the claim needs it', () => {
  it.each(['PROVIDER_CONFIRMED_SENT', 'PROVIDER_CONFIRMED_NOT_SENT'] as const)(
    '%s without a reference is refused',
    (resolution) => {
      /*
        An assertion about what a provider did, citing nothing, is indistinguishable from a
        guess - and a guess recorded as a resolution stops anybody ever looking again.
      */
      const out = checkResolution({ resolution, note: 'Confirmed by the provider dashboard.' });
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toMatch(/CANNOT_ESTABLISH/);
    },
  );

  it('accepts a provider claim that cites what the person saw', () => {
    const out = checkResolution({
      resolution: 'PROVIDER_CONFIRMED_SENT',
      note: 'Dashboard shows the payout against this linked account.',
      evidenceRef: 'trf_abc123',
    });
    expect(out.ok).toBe(true);
    expect(out.ok === true && out.evidenceRef).toBe('trf_abc123');
  });

  it.each(['SETTLED_OUTSIDE_PLATFORM', 'CANNOT_ESTABLISH'] as const)(
    '%s needs no reference',
    (resolution) => {
      const out = checkResolution({
        resolution,
        note: 'Paid by bank transfer outside the platform; see finance ticket.',
      });
      expect(out.ok).toBe(true);
    },
  );

  it('treats a blank reference as absent rather than as a citation', () => {
    const out = checkResolution({
      resolution: 'PROVIDER_CONFIRMED_SENT',
      note: 'Confirmed by the provider dashboard.',
      evidenceRef: '   ',
    });
    expect(out.ok).toBe(false);
  });
});

describe('what gets stored', () => {
  it('trims and bounds both fields', () => {
    const out = checkResolution({
      resolution: 'PROVIDER_CONFIRMED_SENT',
      note: `  ${'n'.repeat(5_000)}  `,
      evidenceRef: `  ${'r'.repeat(5_000)}  `,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.note.length).toBeLessThanOrEqual(1_000);
      expect(out.evidenceRef!.length).toBeLessThanOrEqual(200);
      expect(out.note.startsWith('n')).toBe(true);
    }
  });

  it('refuses a disposition it does not know', () => {
    const out = checkResolution({
      resolution: 'JUST_MAKE_IT_GO_AWAY' as never,
      note: 'A perfectly reasonable sentence.',
    });
    expect(out.ok).toBe(false);
  });
});
