import { useAuthStore } from '@/application/auth-store';

/** Convenience selector for the auth state + actions. */
export function useAuth() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const logout = useAuthStore((s) => s.logout);
  // Drops the in-memory session without calling the API. Used after account deletion,
  // where the server session is already gone and a logout call would just 401.
  const expire = useAuthStore((s) => s.expire);
  return {
    status,
    user,
    login,
    register,
    logout,
    expire,
    isAuthenticated: status === 'authenticated',
  };
}
