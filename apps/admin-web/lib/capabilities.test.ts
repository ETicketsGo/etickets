import { describe, expect, it } from 'vitest';
import { dutyName, holds, missingDutyNote } from './capabilities';

describe('holds', () => {
  it('is true only for a capability the operator was sent', () => {
    const reader = { adminPermissions: ['PLATFORM_CONFIG_READ'] };
    expect(holds(reader, 'PLATFORM_CONFIG_READ')).toBe(true);
    // Reading the rules is not changing them: the edit controls stay hidden.
    expect(holds(reader, 'PLATFORM_CONFIG')).toBe(false);
  });

  it('holds nothing while the operator is unknown, so no write control flashes in', () => {
    expect(holds(null, 'PLATFORM_CONFIG')).toBe(false);
    expect(holds(undefined, 'PLATFORM_CONFIG')).toBe(false);
    expect(holds({}, 'PLATFORM_CONFIG')).toBe(false);
  });
});

describe('missingDutyNote', () => {
  it('names the duty the way Staff & duties does, in plain ASCII', () => {
    const note = missingDutyNote('retry failed jobs', 'OPS_EXECUTE');
    expect(note).toBe(
      'You can see this but cannot retry failed jobs. That needs the Ops execute duty.',
    );
    expect(/^[\x20-\x7e]*$/.test(note)).toBe(true);
  });

  it('turns every new action capability into a readable name', () => {
    expect(dutyName('FINANCE_APPROVE')).toBe('Finance approve');
    expect(dutyName('FINANCE_RESOLVE')).toBe('Finance resolve');
    expect(dutyName('SUPPORT_MANAGE')).toBe('Support manage');
  });

  it('keeps an action hidden from somebody who holds only the read', () => {
    const opsReader = { adminPermissions: ['OPS_READ'] };
    expect(holds(opsReader, 'OPS_EXECUTE')).toBe(false);
    const financeReader = { adminPermissions: ['FINANCE_READ', 'BOOKING_READ'] };
    expect(holds(financeReader, 'FINANCE_RESOLVE')).toBe(false);
    expect(holds(financeReader, 'SUPPORT_MANAGE')).toBe(false);
  });
});
