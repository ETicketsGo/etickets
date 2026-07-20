import { useAuthStore } from '@/application/auth-store';

/** Convenience selector for the auth state + actions. */
export function useAuth() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  return { status, user, login, logout, isAuthenticated: status === 'authenticated' };
}
