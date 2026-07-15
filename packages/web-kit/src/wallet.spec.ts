import { describe, it, expect } from 'vitest';
import {
  buildWallet,
  searchWallet,
  filterWallet,
  sortWallet,
  groupWallet,
  sectionizeWallet,
  assetCapabilities,
  DEFAULT_WALLET_FLAGS,
  WALLET_PROVIDERS,
  type WalletItem,
} from './wallet';
import type { WalletTicket } from './api';

function ticket(over: Partial<WalletTicket> & { id: string }): WalletTicket {
  return {
    serial: over.id.toUpperCase(),
    status: 'ACTIVE',
    holderName: null,
    ticketType: 'General',
    event: { title: 'DevConf India 2026', slug: 'devconf' },
    startsAt: '2026-09-01T10:00:00.000Z',
    qrDataUrl: 'data:image/png;base64,QR',
    bookingId: 'bk_1',
    bookingRef: 'ETG-IND-2026-000001',
    venueName: 'Hall A',
    ...over,
  };
}

const sources = (tickets: WalletTicket[]) => ({ tickets });

describe('buildWallet', () => {
  it('maps a booking into one TICKET wallet item (tickets are just an item type)', () => {
    const items = buildWallet(sources([ticket({ id: 't1' }), ticket({ id: 't2' })]));
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.type).toBe('TICKET');
    expect(it0.title).toBe('DevConf India 2026');
    expect(it0.subtitle).toContain('2 tickets');
    expect(it0.primaryAction.label).toBe('View tickets');
    expect(it0.primaryAction.href).toContain('/account/bookings/');
  });

  it('excludes placeholder providers by default and includes them when flagged', () => {
    const base = buildWallet(sources([ticket({ id: 't1' })]));
    expect(base.every((i) => i.type === 'TICKET')).toBe(true);

    const withPlaceholders = buildWallet(sources([ticket({ id: 't1' })]), {
      ...DEFAULT_WALLET_FLAGS,
      memberships: true,
      coupons: true,
    });
    const types = withPlaceholders.map((i) => i.type);
    expect(types).toContain('MEMBERSHIP');
    expect(types).toContain('COUPON');
    expect(types).not.toContain('PARKING');
  });

  it('registry has no duplicate provider types (registration model)', () => {
    const types = WALLET_PROVIDERS.map((p) => p.type);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe('strategies', () => {
  const items = buildWallet(sources([ticket({ id: 't1' })]), {
    ...DEFAULT_WALLET_FLAGS,
    memberships: true,
    coupons: true,
    parking: true,
  });

  it('search matches reference, venue and title', () => {
    expect(searchWallet(items, 'ETG-IND-2026-000001')).toHaveLength(1);
    expect(searchWallet(items, 'hall a').length).toBeGreaterThan(0);
    expect(searchWallet(items, 'nonexistent')).toHaveLength(0);
  });

  it('filter narrows by tag; empty filter keeps all', () => {
    expect(filterWallet(items, [])).toHaveLength(items.length);
    expect(filterWallet(items, ['memberships']).every((i) => i.type === 'MEMBERSHIP')).toBe(true);
    expect(filterWallet(items, ['events']).every((i) => i.type === 'TICKET')).toBe(true);
  });

  it('sort by title is deterministic', () => {
    const titles = sortWallet(items, 'title').map((i) => i.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  });

  it('groups by type', () => {
    const groups = groupWallet(items, 'type');
    expect(groups.map((g) => g.key).sort()).toContain('TICKET');
  });

  it('sectionizes items once, in priority order', () => {
    const sections = sectionizeWallet(items);
    // Each item appears in exactly one section.
    const total = sections.reduce((n, s) => n + s.items.length, 0);
    expect(total).toBe(items.length);
    expect(sections.some((s) => s.key === 'memberships')).toBe(true);
  });
});

describe('assetCapabilities (ExperienceAsset lifecycle)', () => {
  it('derives lifecycle flags from an item’s capabilities', () => {
    const [ticketItem] = buildWallet(sources([ticket({ id: 't1' })]));
    const caps = assetCapabilities(ticketItem);
    expect(caps.canView).toBe(true);
    expect(caps.canShare).toBe(true);
    expect(caps.canTransfer).toBe(true);
    expect(caps.canNotify).toBe(true);
  });

  it('canExpire tracks the presence of an expiry', () => {
    const withExpiry: WalletItem = {
      ...buildWallet(sources([ticket({ id: 't1' })]))[0],
      expiresAt: '2027-01-01T00:00:00.000Z',
    };
    expect(assetCapabilities(withExpiry).canExpire).toBe(true);
  });
});
