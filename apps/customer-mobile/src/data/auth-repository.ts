import type { LoginInput } from '@eticketsgo/validation';
import type { Role } from '@eticketsgo/shared-types';
import { apiClient } from '@/services/api-client';
import type { AuthTokens } from '@/services/secure-store';

/**
 * The user shape the API returns for the current session. Mirrors the API's
 * RequestUser; `Role` is reused from shared-types so the enum is never duplicated.
 * (Follow-up: lift the shared API response DTOs out of web-kit into shared-types so
 * web + mobile consume one definition.)
 */
export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  roles: Role[];
}

export interface LoginResult extends AuthTokens {
  user?: AuthUser;
}

/**
 * Data layer for auth. Thin wrappers over the existing NestJS endpoints — reuses the
 * `LoginInput` request schema type from @eticketsgo/validation (no duplicated DTOs).
 */
export const authRepository = {
  login: (input: LoginInput) =>
    apiClient.post<LoginResult>('/auth/login', input).then((r) => r.data),
  me: () => apiClient.get<AuthUser>('/auth/me').then((r) => r.data),
  logout: (refreshToken: string) =>
    apiClient.post('/auth/logout', { refreshToken }).then(() => undefined),
};
