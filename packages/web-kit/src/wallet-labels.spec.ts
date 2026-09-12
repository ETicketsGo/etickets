import { describe, it, expect } from 'vitest';
import { buildWallet, ENGLISH_WALLET_LABELS, type WalletLabels } from './wallet';
import { summarizeBookingGroup, ENGLISH_SUMMARY_WORDS, type GroupSummaryWords } from './tickets';
import type { WalletTicket } from './api';

/**
 * The wallet card's words, supplied by the app.
 *
 * web-kit wrote "2 tickets", "Event", "View tickets" and "1 of 2 checked in" into every wallet
 * item in English, so the French wallet showed them beside French headings. The words are now
 * optional inputs; the defaults must reproduce the English exactly.
 */

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

const tickets = [ticket({ id: 't1', status: 'CHECKED_IN' }), ticket({ id: 't2' })];

describe('without labels the wallet is in English, as before', () => {
  it('builds the same words', () => {
    const [item] = buildWallet({ tickets });
    expect(item.subtitle).toBe('2 tickets · ETG-IND-2026-000001');
    expect(item.badge).toBe('Event');
    expect(item.status).toBe('1 checked in · 1 remaining');
    expect(item.primaryAction.label).toBe('View tickets');
    expect(item.progress?.label).toBe('1 of 2 checked in');
    expect(item.metadata).toEqual([
      { label: 'Where', value: 'Hall A' },
      { label: 'Reference', value: 'ETG-IND-2026-000001' },
    ]);
  });

  it('matches the defaults the group itself carries', () => {
    const [item] = buildWallet({ tickets, labels: ENGLISH_WALLET_LABELS });
    expect(item.status).toBe(
      summarizeBookingGroup({ ...counts(), checkedIn: 1, active: 1 }).summary,
    );
  });
});

describe('with labels the wallet speaks the app’s language', () => {
  const fr: WalletLabels = {
    ticketCount: (n) => `${n} billet${n > 1 ? 's' : ''}`,
    badge: (isMovie) => (isMovie ? 'Film' : 'Événement'),
    viewTickets: (n) => (n > 1 ? 'Voir les billets' : 'Voir le billet'),
    summary: (c) => summarizeBookingGroup(c, words).summary,
    checkInProgress: (done, total) => `${done} sur ${total} validés à l’entrée`,
    where: 'Lieu',
    reference: 'Référence',
  };
  const words: GroupSummaryWords = {
    allCheckedIn: 'Tous validés à l’entrée',
    bookingCancelled: 'Réservation annulée',
    segment: (kind, n) => `${n} ${kind}`,
  };

  it('uses every word it is given', () => {
    const [item] = buildWallet({ tickets, labels: fr });
    expect(item.subtitle).toBe('2 billets · ETG-IND-2026-000001');
    expect(item.badge).toBe('Événement');
    expect(item.status).toBe('1 checkedIn · 1 remaining');
    expect(item.primaryAction.label).toBe('Voir les billets');
    expect(item.progress?.label).toBe('1 sur 2 validés à l’entrée');
    expect(item.metadata.map((m) => m.label)).toEqual(['Lieu', 'Référence']);
  });

  it('falls back to English for a word it is not given', () => {
    const [item] = buildWallet({ tickets, labels: { badge: () => 'Événement' } });
    expect(item.badge).toBe('Événement');
    expect(item.primaryAction.label).toBe('View tickets');
  });

  it('keeps the summary rule while swapping its words', () => {
    expect(summarizeBookingGroup({ ...counts(), total: 2, checkedIn: 2 }, words).summary).toBe(
      'Tous validés à l’entrée',
    );
    expect(summarizeBookingGroup({ ...counts(), total: 1, refunded: 1 }, words).summary).toBe(
      'Réservation annulée',
    );
    expect(ENGLISH_SUMMARY_WORDS.segment('tickets', 1)).toBe('1 ticket');
  });
});

function counts() {
  return { total: 2, active: 0, checkedIn: 0, refunded: 0, cancelled: 0, transferred: 0, other: 0 };
}
