import { OrganizationStatus } from '@prisma/client';
import { filterClause } from '../admin/admin-grouping.service';
import { ACTIVE_ORGANIZERS, organizerStatusWhere } from './organizations.service';

describe('the admin organizer list status filter', () => {
  it('ACTIVE keeps every organizer except the suspended ones', () => {
    expect(organizerStatusWhere(ACTIVE_ORGANIZERS)).toEqual({
      status: { not: OrganizationStatus.SUSPENDED },
    });
  });

  it('a named status still selects exactly that status, including Suspended', () => {
    expect(organizerStatusWhere(OrganizationStatus.SUSPENDED)).toEqual({ status: 'SUSPENDED' });
    expect(organizerStatusWhere(OrganizationStatus.PENDING)).toEqual({ status: 'PENDING' });
  });

  it('no status means every organizer', () => {
    expect(organizerStatusWhere(undefined)).toEqual({});
  });
});

describe('the grouped summary above the organizer list', () => {
  it('counts the same rows as the list when it opens on Active', () => {
    const c = filterClause('organizers', { status: 'ACTIVE' });
    expect(c.sql).toContain(`o.status::text <> 'SUSPENDED'`);
    expect(c.params).toEqual([]);
  });

  it('a named status is still an exact match', () => {
    const c = filterClause('organizers', { status: 'SUSPENDED' });
    expect(c.sql).toContain('o.status::text = $1');
    expect(c.params).toEqual(['SUSPENDED']);
  });

  it('ACTIVE means nothing special on other queues', () => {
    const c = filterClause('refunds', { status: 'ACTIVE' });
    expect(c.params).toEqual(['ACTIVE']);
  });
});
