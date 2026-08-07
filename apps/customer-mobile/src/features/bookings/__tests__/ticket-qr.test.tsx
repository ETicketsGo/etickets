import React from 'react';
import { render, waitFor, screen } from '@testing-library/react-native';
import * as Brightness from 'expo-brightness';
import { TicketQr } from '../ticket-qr';
import type { CachedTicket } from '@/services/ticket-cache';

jest.mock('expo-brightness', () => ({
  getBrightnessAsync: jest.fn(),
  setBrightnessAsync: jest.fn(),
}));

const mockGet = Brightness.getBrightnessAsync as jest.MockedFunction<
  typeof Brightness.getBrightnessAsync
>;
const mockSet = Brightness.setBrightnessAsync as jest.MockedFunction<
  typeof Brightness.setBrightnessAsync
>;

/**
 * A 1x1 transparent PNG. The component only checks the `data:image` prefix, but using a
 * real one keeps this honest if it ever starts decoding.
 */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function ticket(overrides: Partial<CachedTicket> = {}): CachedTicket {
  return {
    id: 'tkt_1',
    ticketNumber: 'TKT-05320161CB2E',
    ticketType: 'Standard',
    seatLabel: 'A1',
    qrDataUrl: PNG,
    ...overrides,
  } as CachedTicket;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue(0.4);
  mockSet.mockResolvedValue(undefined as never);
});

describe('TicketQr brightness', () => {
  it('raises the screen to full brightness while the ticket is on screen', async () => {
    await render(<TicketQr ticket={ticket()} />);

    await waitFor(() => expect(mockSet).toHaveBeenCalledWith(1));
  });

  /**
   * REGRESSION: the previous brightness was held in state and read directly by the effect
   * cleanup, so the cleanup closed over the first render's value — null — and the restore
   * branch never ran. On a real Android device the screen stayed pinned at 100% after
   * leaving the ticket, for the rest of the session.
   *
   * This test fails against that implementation: the only `setBrightnessAsync` call is
   * `(1)`, and nothing restores 0.4. It is the reason the value now lives in a ref.
   */
  it('restores the previous brightness when the ticket screen goes away', async () => {
    const view = await render(<TicketQr ticket={ticket()} />);
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith(1));

    await view.unmount();

    await waitFor(() => expect(mockSet).toHaveBeenCalledWith(0.4));
    expect(mockSet).toHaveBeenLastCalledWith(0.4);
  });

  it('restores exactly once, even if the screen is mounted and left repeatedly', async () => {
    for (const level of [0.25, 0.8]) {
      mockGet.mockResolvedValue(level);
      const view = await render(<TicketQr ticket={ticket()} />);
      await waitFor(() => expect(mockSet).toHaveBeenCalledWith(1));
      await view.unmount();
      await waitFor(() => expect(mockSet).toHaveBeenLastCalledWith(level));
    }

    expect(mockSet.mock.calls.map(([v]) => v)).toEqual([1, 0.25, 1, 0.8]);
  });

  it('does not touch brightness when the screen is left before the level is read', async () => {
    let resolveRead: (v: number) => void = () => undefined;
    mockGet.mockReturnValue(
      new Promise<number>((resolve) => {
        resolveRead = resolve;
      }),
    );

    const view = await render(<TicketQr ticket={ticket()} />);
    await view.unmount();
    resolveRead(0.4);

    // The read lost the race, so there is nothing to restore — and nothing was ever
    // raised either. Restoring a level we never captured would be a guess.
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('renders the ticket without a crash when brightness is unavailable', async () => {
    mockGet.mockRejectedValue(new Error('no brightness on this device'));

    await render(<TicketQr ticket={ticket()} />);

    // A ticket that displays dim still gets someone in; a ticket that throws does not.
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.getByLabelText(/Entry code for Standard, seat A1/)).toBeTruthy();
  });
});

describe('TicketQr rendering', () => {
  it('shows a fallback instead of a broken image when no usable code exists', async () => {
    await render(<TicketQr ticket={ticket({ qrDataUrl: undefined })} />);

    expect(screen.getByText(/Show your booking reference at the door/)).toBeTruthy();
  });

  it('never renders the qrToken as text', async () => {
    const secret = 'signed.qr.token.value';
    await render(<TicketQr ticket={ticket({ qrToken: secret } as Partial<CachedTicket>)} />);

    expect(screen.queryByText(new RegExp(secret))).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toContain(secret);
  });
});
