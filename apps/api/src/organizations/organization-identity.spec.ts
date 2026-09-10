import { checkLegalIdentity, findNameCollisions, normalizeOrgName } from './organization-identity';

/**
 * Stopping an organization from taking money under a name that is not theirs.
 *
 * ── WHAT WAS ALREADY THERE, AND WHAT WAS NOT ───────────────────────────────────────
 * The important gate existed: a new organization is PENDING and cannot sell a ticket until a
 * human approves it. But the human was approving on a name and an email address, and the
 * legal identity fields — which had existed since the tax work — were never required by
 * anything. An organization could reach APPROVED having declared nothing about who it is.
 *
 * These two checks are inputs to that person's decision, not verdicts of their own. Neither
 * blocks registration: a name collision is frequently innocent, and refusing at registration
 * would teach a squatter to try a variation while turning the honest case away entirely.
 */

describe('the legal identity an organization must declare', () => {
  const complete = {
    legalName: 'DeepTrics Entertainment Private Limited',
    taxRegistrationKind: 'GSTIN',
    taxRegistrationNumber: '36AABCU9603R1ZM',
  };

  it('accepts a complete declaration', () => {
    expect(checkLegalIdentity(complete)).toEqual({ complete: true, missing: [] });
  });

  it('names every missing field, so a reviewer can ask for all of them at once', () => {
    const verdict = checkLegalIdentity({});
    expect(verdict.complete).toBe(false);
    // Not "identity incomplete". A reviewer forwarding this to an organizer needs the list.
    expect(verdict.missing).toEqual([
      'legal name',
      'tax registration type',
      'tax registration number',
    ]);
  });

  it('treats whitespace as absent, because a space is not a declaration', () => {
    expect(checkLegalIdentity({ ...complete, legalName: '   ' }).complete).toBe(false);
    expect(checkLegalIdentity({ ...complete, taxRegistrationNumber: '\t' }).complete).toBe(false);
  });

  it('treats null and undefined alike', () => {
    expect(
      checkLegalIdentity({ legalName: null, taxRegistrationKind: undefined }).missing,
    ).toHaveLength(3);
  });

  it('checks presence only, and deliberately not shape', () => {
    /*
      This platform cannot check a GSTIN against a government register. A regex that accepted
      the right SHAPE would be worse than nothing: it would read as verification to whoever
      saw it pass, while proving only that somebody can count characters.
    */
    expect(
      checkLegalIdentity({ ...complete, taxRegistrationNumber: 'not-a-real-gstin' }).complete,
    ).toBe(true);
  });
});

describe('recognising a name as a claim on somebody else’s identity', () => {
  it('sees through a legal suffix', () => {
    expect(normalizeOrgName('PVR Cinemas Pvt Ltd')).toBe(normalizeOrgName('PVR Cinemas'));
  });

  it('sees through punctuation and case', () => {
    expect(normalizeOrgName('P.V.R. CINEMAS')).toBe(normalizeOrgName('pvr cinemas'));
  });

  it('sees through word order', () => {
    expect(normalizeOrgName('Cinemas PVR')).toBe(normalizeOrgName('PVR Cinemas'));
  });

  it('sees through diacritics', () => {
    // "Café" and "Cafe" are the same name to everybody except a string comparison.
    expect(normalizeOrgName('Café Royale')).toBe(normalizeOrgName('Cafe Royale'));
  });

  it('joins initials back up, which is the cheapest way to dress up a name', () => {
    // Dropping the dots leaves three one-letter words that resemble nothing. This is the
    // single most likely impersonation dressing, so it must not walk past the check.
    expect(normalizeOrgName('P.V.R. CINEMAS')).toBe(normalizeOrgName('PVR Cinemas'));
    expect(normalizeOrgName('P V R Cinemas')).toBe(normalizeOrgName('pvr cinemas'));
  });

  it('does not collapse a name that is entirely noise words to nothing', () => {
    /*
      "The Company Ltd" is all suffix and article. Collapsing it to the empty string would
      report every such registration as colliding with every other one — a field full of
      false positives, which a reviewer learns to skip past.

      Two DIFFERENT all-noise names are deliberately not forced together either: with no
      distinguishing content left, the conservative reading is that they are separate.
    */
    expect(normalizeOrgName('The Company Ltd')).not.toBe('');
    expect(normalizeOrgName('The Company Ltd')).toBe(normalizeOrgName('the  company,  ltd.'));
    expect(normalizeOrgName('The Company Ltd')).not.toBe(normalizeOrgName('The Corporation'));
  });

  it('keeps genuinely different names apart', () => {
    expect(normalizeOrgName('PVR Cinemas')).not.toBe(normalizeOrgName('INOX Leisure'));
  });
});

describe('reporting collisions to a reviewer', () => {
  const existing = [
    { id: 'o1', name: 'PVR Cinemas Pvt Ltd', status: 'APPROVED' },
    { id: 'o2', name: 'INOX Leisure', status: 'APPROVED' },
    { id: 'o3', name: 'Sunset Promotions', status: 'REJECTED' },
  ];

  it('raises an impersonation attempt dressed up with a suffix', () => {
    const hits = findNameCollisions('P V R Cinemas', existing);
    expect(hits.map((h) => h.organizationId)).toEqual(['o1']);
    expect(hits[0].status).toBe('APPROVED');
  });

  it('raises a collision with a REJECTED organization too', () => {
    // Somebody turned down once and trying again is the pattern most worth surfacing.
    expect(findNameCollisions('Sunset Promotions.', existing).map((h) => h.organizationId)).toEqual(
      ['o3'],
    );
  });

  it('reports nothing when there is nothing', () => {
    /*
      The property that keeps the field worth reading. A check that cried wolf on every
      registration would be worse than absent, because its presence implies it happened.
    */
    expect(findNameCollisions('Hyderabad Theatre Collective', existing)).toEqual([]);
  });

  it('does not report a near-miss as a collision', () => {
    // Loose enough to catch "PVR" against "PVRR" is loose enough to match half the platform.
    expect(findNameCollisions('PVR Cinema Halls', existing)).toEqual([]);
  });

  it('returns nothing for an empty or punctuation-only name', () => {
    expect(findNameCollisions('   ', existing)).toEqual([]);
    expect(findNameCollisions('!!!', existing)).toEqual([]);
  });
});
