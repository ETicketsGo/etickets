import type { LoginInput, RegisterInput } from '@eticketsgo/validation';
import type { AuthenticatedUser, AuthResponse } from '@eticketsgo/shared-types';
import { apiClient } from '@/services/api-client';

/**
 * Data layer for auth. Thin wrappers over the existing NestJS endpoints. Request +
 * response contracts are reused from the shared packages — the mobile app no longer
 * mirrors any DTO:
 *   - request:  `LoginInput` from @eticketsgo/validation
 *   - response: `AuthResponse` / `AuthenticatedUser` from @eticketsgo/shared-types
 */
export type AuthUser = AuthenticatedUser;

export const authRepository = {
  login: (input: LoginInput) =>
    apiClient.post<AuthResponse>('/auth/login', input).then((r) => r.data),
  register: (input: RegisterInput) =>
    apiClient.post<AuthResponse>('/auth/register', input).then((r) => r.data),
  /** Send a sign-in code. Guarded by the human check, answered by services/human-check.ts. */
  requestPhoneCode: (phone: string) =>
    apiClient
      .post<{ sent: true; expiresInMinutes: number }>('/auth/phone/request-code', { phone })
      .then((r) => r.data),
  /**
   * Exchange the code for a session; a new number creates the account. A back-office account
   * gets a second-factor challenge instead of tokens (no accessToken), which this app refuses.
   */
  verifyPhoneCode: (phone: string, code: string) =>
    apiClient
      .post<Partial<AuthResponse> & { isNewAccount?: boolean }>('/auth/phone/verify', {
        phone,
        code,
      })
      .then((r) => r.data),
  /** Which numbers a code can reach in this environment (empty = texting is off). */
  phoneSignInCountries: () =>
    apiClient
      .get<{ phoneSignIn?: boolean; phoneSignInCountries?: string[] }>('/capabilities')
      .then((r) => (r.data.phoneSignIn === false ? [] : (r.data.phoneSignInCountries ?? []))),
  me: () => apiClient.get<AuthUser>('/auth/me').then((r) => r.data),
  logout: (refreshToken: string) =>
    apiClient.post('/auth/logout', { refreshToken }).then(() => undefined),
};
