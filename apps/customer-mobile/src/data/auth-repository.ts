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
  me: () => apiClient.get<AuthUser>('/auth/me').then((r) => r.data),
  logout: (refreshToken: string) =>
    apiClient.post('/auth/logout', { refreshToken }).then(() => undefined),
};
