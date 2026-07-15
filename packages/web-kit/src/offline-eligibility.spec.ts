import { describe, it, expect } from 'vitest';
import {
  isOfflineEligible,
  isTicketOfflineEligible,
  offlineEligibleTickets,
} from './offline-eligibility';
import type { WalletTicket } from './api';

function ticket(over: Partial<WalletTicket> & { id: string }): WalletTicket {
  return {
    serial: over.id.toUpperCase(),
    status: 'ACTIVE',
    holderName: null,
    ticketType: 'General',
    event: { title: 'DevConf', slug: 'devconf' },
    startsAt: '2026-09-01T10:00:00.000Z',
    qrDataUrl: 'data:image/png;base64,QR',
    ownedByViewer: true,
    assignedToViewer: true,
    assignmentStatus: 'ASSIGNED',
    ...over,
  };
}

describe('isOfflineEligible', () => {
  it('caches issued, held assets with a QR', () => {
    expect(isOfflineEligible({ status: 'ACTIVE', ownedByViewer: true, hasQr: true })).toBe(true);
  });

  it('keeps checked-in for historical display', () => {
    expect(isOfflineEligible({ status: 'CHECKED_IN', assignedToViewer: true, hasQr: true })).toBe(
      true,
    );
  });

  it('never caches pending/cancelled/refunded/void/revoked', () => {
    for (const status of ['PENDING_PAYMENT', 'CANCELLED', 'REFUNDED', 'VOID', 'EXPIRED']) {
      expect(isOfflineEligible({ status, ownedByViewer: true, hasQr: true })).toBe(false);
    }
  });

  it('never caches without a QR representation', () => {
    expect(isOfflineEligible({ status: 'ACTIVE', ownedByViewer: true, hasQr: false })).toBe(false);
  });

  it('excludes a ticket the owner transferred away (accepted by someone else)', () => {
    expect(
      isOfflineEligible({
        status: 'ACTIVE',
        ownedByViewer: true,
        assignedToViewer: false,
        assignmentStatus: 'ACCEPTED',
        hasQr: true,
      }),
    ).toBe(false);
  });

  it('includes a ticket assigned to the viewer even if they do not own it', () => {
    expect(
      isOfflineEligible({
        status: 'ACTIVE',
        ownedByViewer: false,
        assignedToViewer: true,
        assignmentStatus: 'ACCEPTED',
        hasQr: true,
      }),
    ).toBe(true);
  });

  it('falls back to eligible when ownership context is unknown (legacy payload)', () => {
    expect(isOfflineEligible({ status: 'ACTIVE', hasQr: true })).toBe(true);
  });
});

describe('offlineEligibleTickets', () => {
  it('filters a wallet down to cacheable tickets', () => {
    const result = offlineEligibleTickets([
      ticket({ id: 'a', status: 'ACTIVE' }),
      ticket({ id: 'b', status: 'REFUNDED' }),
      ticket({ id: 'c', status: 'CHECKED_IN' }),
      ticket({ id: 'd', status: 'ACTIVE', qrDataUrl: '' }),
    ]);
    expect(result.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('isTicketOfflineEligible mirrors the policy', () => {
    expect(isTicketOfflineEligible(ticket({ id: 'a' }))).toBe(true);
    expect(isTicketOfflineEligible(ticket({ id: 'b', status: 'VOID' }))).toBe(false);
  });
});
