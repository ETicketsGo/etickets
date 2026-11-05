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
 *   organizer.eticketsgo.com     -> www.eticketsgo.com
 *   localhost:3001 (or any port) -> localhost:3000
 *
 * ── NEVER THE BARE APEX ────────────────────────────────────────────────────────────
 * Stripping `organizer.` from the production host used to leave `eticketsgo.com`. In production
 * the bare apex is a registrar forwarder that answers every path with a 404 (owner evidence,
 * 2026-10-25: `https://eticketsgo.com/register?intent=organizer` was GoDaddy's 404 page, while
 * the same path on `www.` worked). So a derived host with no subdomain of its own - two labels,
 * `example.com` - gets `www.` in front. A host that keeps a subdomain (`qa.eticketsgo.com`) is
 * used as it is.
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
    return `${protocol}//${servedHost(hostname.slice('organizer-'.length))}`;
  if (hostname.startsWith('organizer.'))
    return `${protocol}//${servedHost(hostname.slice('organizer.'.length))}`;
  return null;
}

/** A registrable domain on its own (`eticketsgo.com`) is served at `www.`; see above. */
export function servedHost(host: string): string {
  return host.split('.').length === 2 ? `www.${host}` : host;
}
