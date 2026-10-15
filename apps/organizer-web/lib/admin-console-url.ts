/**
 * Where the admin console is, seen from the organizer console.
 *
 * An administrator who signs in here is offered the admin console (`/back-office`), so this page
 * has to know its address. Derived from the console's own host the way the deployments are
 * named, as `storefrontOrigin` does, so no new build variable is required:
 *
 *   organizer-qa.eticketsgo.com  -> admin-qa.eticketsgo.com
 *   organizer-uat.eticketsgo.com -> admin-uat.eticketsgo.com
 *   organizer.eticketsgo.com     -> admin.eticketsgo.com
 *   localhost:3001 (or any port) -> localhost:3002
 *
 * `NEXT_PUBLIC_ADMIN_URL`, when a deployment sets it, wins. A host that matches none of the
 * patterns gets null, and the caller offers only the organizer workspace rather than guess.
 */
export function adminConsoleOrigin(
  location: { protocol: string; hostname: string } | undefined,
  configured: string | undefined = process.env.NEXT_PUBLIC_ADMIN_URL,
): string | null {
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, '');
  if (!location) return null;
  const { protocol, hostname } = location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return `${protocol}//${hostname}:3002`;
  if (hostname.startsWith('organizer-')) return `${protocol}//admin-${hostname.slice(10)}`;
  if (hostname.startsWith('organizer.')) return `${protocol}//admin.${hostname.slice(10)}`;
  return null;
}

/** The admin console's sign-in, with the address already filled in. */
export function adminSignInUrl(origin: string, email: string | null | undefined): string {
  return email ? `${origin}/login?email=${encodeURIComponent(email)}` : `${origin}/login`;
}

/**
 * What `/back-office` does for the account that just signed in.
 *
 * - `stay`: not an administrator, or no admin console address is known - go on as before.
 * - `admin`: an administrator with no organization here - straight to the admin console.
 * - `choose`: an administrator who is also a member of an organization - the admin console by
 *   default, with the organization's workspace as the other choice.
 */
export function backOfficeRoute(input: {
  roles: readonly string[];
  adminOrigin: string | null;
  organizationCount: number;
}): 'stay' | 'admin' | 'choose' {
  const backOffice = input.roles.some((r) => r === 'ADMIN' || r === 'SUPER_ADMIN');
  if (!backOffice || !input.adminOrigin) return 'stay';
  return input.organizationCount === 0 ? 'admin' : 'choose';
}
