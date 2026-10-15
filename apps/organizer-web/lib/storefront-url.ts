/**
 * Where the storefront is, seen from the organizer console.
 *
 * Accounts are made on the storefront (register, then "tell us about your organization"), and
 * the password reset lives there too - so the organizer sign-in page has to link to it. The
 * console is only built with `NEXT_PUBLIC_API_URL`, and adding a build variable means a change
 * on every deployment, so the address is derived from the console's own host the way the
 * deployments are named:
 *
 *   organizer-qa.eticketsgo.com  -> qa.eticketsgo.com
 *   organizer-uat.eticketsgo.com -> uat.eticketsgo.com
 *   organizer.eticketsgo.com     -> eticketsgo.com
 *   localhost:3001 (or any port) -> localhost:3000
 *
 * `NEXT_PUBLIC_STOREFRONT_URL`, when a deployment sets it, wins. A host that matches none of the
 * patterns gets null, and the caller leaves the links out rather than guess.
 */
export function storefrontOrigin(
  location: { protocol: string; hostname: string } | undefined,
  configured: string | undefined = process.env.NEXT_PUBLIC_STOREFRONT_URL,
): string | null {
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, '');
  if (!location) return null;
  const { protocol, hostname } = location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return `${protocol}//${hostname}:3000`;
  if (hostname.startsWith('organizer-'))
    return `${protocol}//${hostname.slice('organizer-'.length)}`;
  if (hostname.startsWith('organizer.'))
    return `${protocol}//${hostname.slice('organizer.'.length)}`;
  return null;
}
