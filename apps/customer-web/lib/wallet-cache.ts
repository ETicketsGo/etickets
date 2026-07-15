// Lightweight offline cache for the ticket wallet. The wallet response already
// embeds each QR as a data URL, so persisting it to localStorage lets a customer
// reopen their tickets (and Event Day Mode) with no network — the classic
// "boarding pass works on the plane" behaviour. This is deliberately simple
// (last-known snapshot); a full service-worker PWA is a later sprint.

import type { WalletTicket } from '@eticketsgo/web-kit';

const KEY = 'etg_wallet_cache_v1';

export function readWalletCache(): WalletTicket[] | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as WalletTicket[];
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeWalletCache(tickets: WalletTicket[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(tickets));
  } catch {
    // Quota / private-mode failures are non-fatal — the app still works online.
  }
}
