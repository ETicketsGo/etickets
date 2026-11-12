import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BookingManage, FREE_CANCEL_REASON } from '../booking-manage';
import type { BookingDetail } from '../schema';

/**
 * A free booking has nothing to refund. The platform cancels its tickets on the same
 * request, and the web offers it as "Cancel tickets" with an optional reason. The app said
 * "Ask for a refund ... the money goes back the way you paid" and demanded a reason.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockPost = jest.fn(async (_path: string, _body: unknown) => ({}));
jest.mock('@/services/api-client', () => ({
  apiClient: { post: (path: string, body: unknown) => mockPost(path, body) },
}));
jest.mock('@/services/http', () => ({ getParsed: async () => [] }));

const inTenDays = new Date(Date.now() + 10 * 86_400_000).toISOString();

function booking(totalMinor: number, payment: BookingDetail['payment']): BookingDetail {
  return {
    id: 'b1',
    eventId: 'e1',
    eventSessionId: 's1',
    reference: 'ETG-IND-2026-000100',
    buyerName: 'Asha',
    buyerEmail: 'asha@eticketsgo.test',
    status: 'CONFIRMED',
    currency: 'INR',
    subtotalMinor: totalMinor,
    bookingFeeMinor: 0,
    paymentFeeMinor: 0,
    discountMinor: 0,
    customerFeeMinor: 0,
    totalMinor,
    holdExpiresAt: null,
    confirmedAt: inTenDays,
    cancelledAt: null,
    createdAt: inTenDays,
    timeZone: 'Asia/Kolkata',
    event: { title: 'Open Mic', slug: 'open-mic', refundsEnabled: true, refundCutoffHours: 24 },
    eventSession: { startsAt: inTenDays },
    payment,
    tickets: [{ id: 't1' }],
    items: null,
  };
}

let client: QueryClient;
let invalidated: unknown[] = [];
afterEach(() => client.clear());

async function show(b: BookingDetail) {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  invalidated = [];
  const original = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
    invalidated.push(filters?.queryKey);
    return original(filters as never);
  }) as typeof client.invalidateQueries;
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <QueryClientProvider client={client}>
        <BookingManage booking={b} />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

describe('cancelling a free booking', () => {
  beforeEach(() => mockPost.mockClear());

  it('offers "Cancel tickets", never a refund, and needs no reason', async () => {
    await show(booking(0, null));
    expect(screen.queryByText('Ask for a refund')).toBeNull();
    expect(screen.queryByText(/money goes back/)).toBeNull();
    expect(screen.getByText(/nothing to refund/)).toBeTruthy();

    await fireEvent.press(screen.getByText('Cancel tickets'));
    // Now the sheet is open too: its button is the second "Cancel tickets".
    const buttons = await screen.findAllByText('Cancel tickets');
    expect(buttons).toHaveLength(2);
    await fireEvent.press(buttons[1]);

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/refunds', {
        bookingId: 'b1',
        reason: FREE_CANCEL_REASON,
      }),
    );
    // The voided pass must not stay on screen as "Valid".
    await waitFor(() => expect(invalidated).toContainEqual(['tickets']));
  });

  it('keeps the refund request, with a required reason, for a paid booking', async () => {
    await show(booking(103428, { status: 'CAPTURED', provider: 'RAZORPAY' }));
    expect(screen.getByText(/money goes back the way you paid/)).toBeTruthy();
    await fireEvent.press(screen.getByText('Ask for a refund'));
    await fireEvent.press(await screen.findByText('Send request'));
    expect(await screen.findByText('Tell the organizer why in a few words.')).toBeTruthy();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
