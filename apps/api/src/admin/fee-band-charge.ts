import { AppException, ErrorCodes } from '../common/errors';

/** How a fee band charges. FIXED_PER_TICKET: a fixed amount for each paid ticket. */
export type FeeBandType = 'FLAT' | 'PERCENT' | 'COMBINED' | 'FIXED_PER_TICKET';

/*
  The rules a single fee band must meet, shared by the one-band editor (AdminService) and the
  draft schedule publisher (FeeSchedulesService), so both refuse the same bands in the same words.
*/

/** An inverted band matches nothing and silently reprices via the fall-through tier. */
export function assertBandShape(minMinor: number, maxMinor: number | null): void {
  if (minMinor < 0 || !Number.isInteger(minMinor)) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      'The lower bound must be a whole number of minor units, zero or more.',
    );
  }
  if (maxMinor !== null && maxMinor <= minMinor) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      'The upper bound must be greater than the lower bound (use no upper bound for the top band).',
    );
  }
}

/**
 * How a band charges, checked and made consistent before it is stored.
 *
 * A booking fee is money taken from a customer, so a band that cannot charge sensibly is
 * refused here rather than discovered at checkout:
 *
 *  - FLAT needs its amount. Its percentage fields are cleared, so a band switched from PERCENT
 *    back to FLAT does not carry a dead 5% that a later reader might believe.
 *  - PERCENT needs its percentage. `feeMinor` is stored as 0 because nothing reads it, and a
 *    stale fixed amount left beside a percentage invites somebody to think both apply.
 *  - A floor above the ceiling is refused. The calculator would still cap at the ceiling, but
 *    a band whose floor can never be reached is a typo that should be caught while the person
 *    who made it is still looking at the form.
 */
export function normaliseCharge(c: {
  feeType: FeeBandType;
  feeMinor: number | undefined;
  feePercentBps: number | null;
  minFeeMinor: number | null;
  maxFeeMinor: number | null;
}): {
  feeType: FeeBandType;
  feeMinor: number;
  feePercentBps: number | null;
  minFeeMinor: number | null;
  maxFeeMinor: number | null;
} {
  if (c.feeType === 'FLAT') {
    if (c.feeMinor === undefined) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A fixed-amount band needs its booking fee amount.',
      );
    }
    return {
      feeType: 'FLAT',
      feeMinor: c.feeMinor,
      feePercentBps: null,
      minFeeMinor: null,
      maxFeeMinor: null,
    };
  }
  /*
    COMBINED: a percentage of the order plus a fixed amount per paid ticket. It needs both.
    A minimum and a maximum fee for the whole order are optional (owner decision
    2026-10-29) and both unset by default.
  */
  if (c.feeType === 'COMBINED') {
    if (c.feePercentBps === null || c.feePercentBps < 1 || c.feePercentBps > 10_000) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A combined band needs a percentage above 0% and no more than 100%.',
      );
    }
    if (c.feeMinor === undefined || c.feeMinor < 1) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A combined band needs a fixed amount per ticket above zero. For a percentage only, choose a percentage band.',
      );
    }
    assertFeeLimits(c.minFeeMinor, c.maxFeeMinor);
    return {
      feeType: 'COMBINED',
      feeMinor: c.feeMinor,
      feePercentBps: c.feePercentBps,
      minFeeMinor: c.minFeeMinor,
      maxFeeMinor: c.maxFeeMinor,
    };
  }
  /*
    FIXED_PER_TICKET: a fixed amount for each paid ticket, and no percentage. Not the same as
    FLAT, which charges its amount once per order. Optional whole-order minimum and maximum.
  */
  if (c.feeType === 'FIXED_PER_TICKET') {
    if (c.feeMinor === undefined) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A per-ticket band needs its amount per ticket.',
      );
    }
    assertFeeLimits(c.minFeeMinor, c.maxFeeMinor);
    return {
      feeType: 'FIXED_PER_TICKET',
      feeMinor: c.feeMinor,
      feePercentBps: null,
      minFeeMinor: c.minFeeMinor,
      maxFeeMinor: c.maxFeeMinor,
    };
  }
  if (c.feePercentBps === null || c.feePercentBps < 1 || c.feePercentBps > 10_000) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      'A percentage band needs a percentage above 0% and no more than 100%.',
    );
  }
  assertFeeLimits(c.minFeeMinor, c.maxFeeMinor);
  return {
    feeType: 'PERCENT',
    feeMinor: 0,
    feePercentBps: c.feePercentBps,
    minFeeMinor: c.minFeeMinor,
    maxFeeMinor: c.maxFeeMinor,
  };
}

/** A minimum and maximum fee are each optional, never negative, and minimum <= maximum. */
export function assertFeeLimits(min: number | null, max: number | null): void {
  if ((min !== null && min < 0) || (max !== null && max < 0)) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      'The minimum and maximum fee cannot be below zero.',
    );
  }
  if (min !== null && max !== null && min > max) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      'The minimum fee cannot be more than the maximum fee.',
    );
  }
}
