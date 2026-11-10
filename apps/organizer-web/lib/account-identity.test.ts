import { describe, expect, it } from 'vitest';
import { orgRoleLabel, switchTargets } from './account-identity';

const org = (id: string, name: string, extra: Record<string, string | null> = {}) => ({
  id,
  name,
  slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${id}`,
  ...extra,
});

describe('orgRoleLabel', () => {
  it('says each member role in words', () => {
    expect(orgRoleLabel('ORGANIZER_OWNER')).toBe('Owner');
    expect(orgRoleLabel('ORGANIZER_MANAGER')).toBe('Manager');
    expect(orgRoleLabel('CHECKIN_STAFF')).toBe('Check-in staff');
  });

  it('gives null for a missing or unknown role, so the shell can fall back', () => {
    expect(orgRoleLabel(undefined)).toBeNull();
    expect(orgRoleLabel(null)).toBeNull();
    expect(orgRoleLabel('')).toBeNull();
    expect(orgRoleLabel('SUPER_ADMIN')).toBeNull();
  });
});

describe('switchTargets', () => {
  it('offers nothing to somebody with one organization', () => {
    expect(switchTargets([org('1', 'Lotus Hall', { myRole: 'ORGANIZER_OWNER' })], '1')).toEqual([]);
    expect(switchTargets([], null)).toEqual([]);
  });

  it('lists the other organizations with the role held in each', () => {
    const orgs = [
      org('1', 'Lotus Hall', { myRole: 'ORGANIZER_OWNER' }),
      org('2', 'River Arts', { myRole: 'CHECKIN_STAFF' }),
      org('3', 'Bay Stage', { myRole: 'ORGANIZER_MANAGER' }),
    ];
    expect(switchTargets(orgs, '2')).toEqual([
      { id: '1', name: 'Lotus Hall', qualifier: null, role: 'Owner' },
      { id: '3', name: 'Bay Stage', qualifier: null, role: 'Manager' },
    ]);
  });

  it('treats an unknown active id as the first organization, as the console does', () => {
    const orgs = [org('1', 'Lotus Hall'), org('2', 'River Arts')];
    expect(switchTargets(orgs, 'gone').map((t) => t.id)).toEqual(['2']);
    expect(switchTargets(orgs, null).map((t) => t.id)).toEqual(['2']);
  });

  it('tells two organizations with the same name apart', () => {
    const orgs = [
      org('1', 'DeepTrics', { registeredCity: 'Hyderabad', myRole: 'ORGANIZER_OWNER' }),
      org('2', 'DeepTrics', { registeredCity: 'Dallas', myRole: 'ORGANIZER_OWNER' }),
    ];
    expect(switchTargets(orgs, '1')).toEqual([
      { id: '2', name: 'DeepTrics', qualifier: 'Dallas', role: 'Owner' },
    ]);
  });

  it('does not repeat the role as the qualifier', () => {
    const orgs = [
      org('1', 'DeepTrics', { myRole: 'ORGANIZER_OWNER' }),
      org('2', 'DeepTrics', { myRole: 'CHECKIN_STAFF' }),
    ];
    expect(switchTargets(orgs, '1')).toEqual([
      { id: '2', name: 'DeepTrics', qualifier: null, role: 'Check-in staff' },
    ]);
  });
});
