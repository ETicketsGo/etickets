import type { AuthResponse } from '@eticketsgo/shared-types';
import { apiClient } from '@/services/api-client';
import { tokenStore } from '@/services/secure-store';
import { env } from '@/services/env';

/**
 * Turning a customer account into an organizer account, from the phone.
 *
 * ── WHY THE ORGANIZATION IS CREATED HERE ──────────────────────────────────────────
 * Creating an organization is what grants ORGANIZER_OWNER; nothing else does. The app is
 * where the session lives, so this is the only place that can do it without asking the
 * person to sign in somewhere else first.
 *
 * ── WHY THE SESSION IS REFRESHED AFTERWARDS ───────────────────────────────────────
 * The role lands in the database, but the access token in the keychain still describes the
 * account as it was a moment ago, and every downstream check reads the token. The web app
 * hit exactly this: a brand-new organizer was bounced out of the console they had just been
 * told to open. `/auth/refresh` re-reads the user server-side, so the new pair carries the
 * new role.
 *
 * ── WHY THE CONSOLE IS A LINK, NOT A SCREEN ───────────────────────────────────────
 * Running a cinema — seat layouts, scheduling grids, live occupancy — is desk work. There is
 * no organizer console in this app and building a phone-sized imitation of one would be a
 * second thing to keep correct. So the app does the one step it is uniquely able to do, and
 * hands over.
 */
const FALLBACK_HOST = 'eticketsgo.com';

export interface CreatedOrganization {
  id: string;
  name: string;
  status: string;
}

/**
 * Where the organizer console lives for this build's environment.
 *
 * The hosts are `qa.eticketsgo.com` -> `organizer-qa.eticketsgo.com`, `uat.` -> `organizer-uat.`,
 * and bare `eticketsgo.com` -> `organizer.eticketsgo.com`. The environment is a PREFIX on the
 * organizer host, not a parent domain: `organizer.qa.eticketsgo.com` does not exist and would
 * fail to resolve — a dead end no error message on the phone could explain.
 *
 * A Railway-generated host (`*.up.railway.app`) follows no such convention, so it is left
 * alone rather than mangled into something that certainly does not exist.
 */
export function organizerConsoleUrl(email?: string): string {
  const host = (env.webHost ?? FALLBACK_HOST).replace(/^www\./, '');
  const match = /^([a-z0-9-]+)\.(eticketsgo\.com)$/i.exec(host);
  const organizerHost = host.endsWith('.up.railway.app')
    ? host
    : match
      ? `organizer-${match[1]}.${match[2]}`
      : `organizer.${host}`;
  /*
    A separate host means a separate sign-in: the token this app holds is not visible to a
    browser. Prefilling the address is the least we can do — making someone retype it on a
    phone keyboard is how a correct flow still feels broken.
  */
  const base = `https://${organizerHost}/login`;
  return email ? `${base}?email=${encodeURIComponent(email)}` : base;
}

/** Whether this account already belongs to an organization. */
export async function alreadyAnOrganizer(): Promise<boolean> {
  const { data } = await apiClient.get<{ id: string }[]>('/organizations');
  return Array.isArray(data) && data.length > 0;
}

/**
 * Create the organization and bring the session up to date.
 *
 * Refresh failure is deliberately NOT fatal: the organization exists at that point, and
 * throwing would tell the operator their setup failed when it did not. They would simply
 * sign in again on the console, which issues a fresh token anyway.
 */
export async function becomeOrganizer(input: {
  name: string;
  contactEmail?: string;
}): Promise<CreatedOrganization> {
  const { data } = await apiClient.post<CreatedOrganization>('/organizations', {
    name: input.name.trim(),
    ...(input.contactEmail?.trim() ? { contactEmail: input.contactEmail.trim() } : {}),
  });

  const tokens = await tokenStore.get();
  if (tokens?.refreshToken) {
    try {
      const refreshed = await apiClient.post<AuthResponse>('/auth/refresh', {
        refreshToken: tokens.refreshToken,
      });
      await tokenStore.set({
        accessToken: refreshed.data.accessToken,
        refreshToken: refreshed.data.refreshToken,
      });
    } catch {
      // See above: the organization is created either way.
    }
  }

  return data;
}

/** Whether a name is worth submitting. Mirrors the server's `min(2)`. */
export function isValidOrganizationName(name: string): boolean {
  return name.trim().length >= 2 && name.trim().length <= 160;
}
