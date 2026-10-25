import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PhoneSignIn } from '../phone-sign-in';

/**
 * Creating an account with a mobile number, on Android.
 *
 * ── THE REPORT ─────────────────────────────────────────────────────────────────────
 * "I can repeatedly sign up using the same mobile number without receiving an 'account already
 * exists' message." The API has always answered `isNewAccount: false` for a number that already
 * has an account, and signed the person into THAT account. The app threw the answer away, so the
 * screen behaved exactly as it does for a brand-new account.
 *
 * These tests drive the real component: type a number, send, type the code, verify. The API is
 * the only thing mocked, and what is asserted is what the person reads.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockLoginWithPhone = jest.fn();
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ loginWithPhone: mockLoginWithPhone }),
}));

const mockRequestPhoneCode = jest.fn(async (_phone: string) => ({
  sent: true,
  expiresInMinutes: 10,
}));
jest.mock('@/data/auth-repository', () => ({
  authRepository: {
    requestPhoneCode: (phone: string) => mockRequestPhoneCode(phone),
    phoneSignInCountries: async () => ['IN', 'US', 'CA'],
  },
}));

jest.mock('@/features/location/api', () => ({
  useResolvedLocation: () => ({ data: { country: 'IN' } }),
}));

jest.mock('@/services/locale', () => ({ deviceLocale: { region: 'IN', language: 'en' } }));

const EXISTING = 'You already have an account with this number. We signed you in.';

async function signUpWith(isNewAccount: boolean, onSignedIn = jest.fn()) {
  mockLoginWithPhone.mockResolvedValue({ isNewAccount });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={client}>
      <PhoneSignIn signUp onSignedIn={onSignedIn} onUseEmail={() => undefined} />
    </QueryClientProvider>,
  );
  await fireEvent.changeText(screen.getByLabelText('Full name'), 'Asha Menon');
  await fireEvent.changeText(screen.getByLabelText('Mobile number'), '98765 43210');
  await fireEvent.press(screen.getByText('Send code'));
  await waitFor(() => expect(mockRequestPhoneCode).toHaveBeenCalledWith('+919876543210'));
  await fireEvent.changeText(await screen.findByLabelText('Code'), '123456');
  await fireEvent.press(screen.getByText('Create account'));
  await waitFor(() => expect(mockLoginWithPhone).toHaveBeenCalled());
  return { onSignedIn };
}

beforeEach(() => {
  mockLoginWithPhone.mockReset();
  mockRequestPhoneCode.mockClear();
});

describe('Mobile sign-up with a number that already has an account', () => {
  it('sends the name with the code, so a NEW account starts with it', async () => {
    await signUpWith(true);
    expect(mockLoginWithPhone).toHaveBeenCalledWith('+919876543210', '123456', {
      fullName: 'Asha Menon',
    });
  });

  it('a new number goes straight on, with no "already" message', async () => {
    const { onSignedIn } = await signUpWith(true);
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(EXISTING)).toBeNull();
  });

  it('an existing number says so, plainly, and waits for the person to continue', async () => {
    const { onSignedIn } = await signUpWith(false);
    expect(await screen.findByText(EXISTING)).toBeTruthy();
    // Not whisked away before the sentence can be read.
    expect(onSignedIn).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Continue'));
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });
});

describe('Mobile sign-in (not sign-up) is unchanged', () => {
  it('asks for no name and signs straight in', async () => {
    mockLoginWithPhone.mockResolvedValue({ isNewAccount: false });
    const onSignedIn = jest.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={client}>
        <PhoneSignIn onSignedIn={onSignedIn} onUseEmail={() => undefined} />
      </QueryClientProvider>,
    );
    expect(screen.queryByLabelText('Full name')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('Mobile number'), '98765 43210');
    await fireEvent.press(screen.getByText('Send code'));
    await fireEvent.changeText(await screen.findByLabelText('Code'), '123456');
    await fireEvent.press(screen.getByText('Sign in'));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(mockLoginWithPhone).toHaveBeenCalledWith('+919876543210', '123456', undefined);
    expect(screen.queryByText(EXISTING)).toBeNull();
  });
});
