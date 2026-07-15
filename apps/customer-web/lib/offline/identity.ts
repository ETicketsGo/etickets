import { tokenStore } from '@/lib/api';

/**
 * The current user's stable id, decoded from the access-token JWT `sub` claim.
 * Used ONLY to namespace offline storage so one device never leaks another user's
 * cached wallet. Decoding (not verifying) is fine here — the server remains the
 * authority; this is a local partition key that also works offline. Never store
 * or trust the token itself for authorization.
 */
export function currentUserId(): string | null {
  const token = tokenStore.access;
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      sub?: string;
    };
    return typeof json.sub === 'string' ? json.sub : null;
  } catch {
    return null;
  }
}
