import { describe, expect, it } from 'vitest';
import { holds } from './capabilities';

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
