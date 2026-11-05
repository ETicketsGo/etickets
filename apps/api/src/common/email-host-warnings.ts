/**
 * A production site URL that points at a generated Railway host, said out loud at boot.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * Production emails linked to `https://admin-web-prod-1594.up.railway.app/admin/support?...`
 * and named `customer-web-prod.up.railway.app` in their footer, although the official domains
 * (www., admin., organizer.eticketsgo.com) were live. The hosts come from configuration, not from
 * code: every link in a message is built from CUSTOMER_WEB_URL, ADMIN_WEB_URL and
 * ORGANIZER_WEB_URL (common/console-urls.ts, support-mail.service.ts, email.channel.ts), on the
 * api AND the worker services, because the worker is what renders and sends the mail.
 *
 * ── WHY A WARNING AND NOT A REFUSAL ────────────────────────────────────────────────
 * A refusal would take production down on its next deploy for a cosmetic fault: the generated
 * hosts still answer. And a silent rewrite to the official domain would make the configuration
 * lie about what the service uses. So this only names the variable, its host and the official
 * origin it should be, every boot, until the variable is changed. Other environments are left
 * alone: QA and UAT have their own hosts and are not read by customers.
 */

/** The official origin each email-facing site variable should hold in production. */
export const OFFICIAL_PRODUCTION_ORIGINS = {
  CUSTOMER_WEB_URL: 'https://www.eticketsgo.com',
  ADMIN_WEB_URL: 'https://admin.eticketsgo.com',
  ORGANIZER_WEB_URL: 'https://organizer.eticketsgo.com',
} as const;

/** True for a Railway-generated host (`*.up.railway.app`). */
export function isRailwayGeneratedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return host === 'up.railway.app' || host.endsWith('.up.railway.app');
}

/**
 * True for the platform's bare apex (`eticketsgo.com`).
 *
 * In production the apex is a registrar forwarder, not the storefront: it answers every path with
 * a 404 (owner evidence, 2026-10-25: `https://eticketsgo.com/register?intent=organizer`). Every
 * link a message builds on it - a reset, a booking, an invitation - is dead on arrival.
 */
export function isBareApexHost(hostname: string): boolean {
  return hostname.trim().toLowerCase().replace(/\.$/, '') === 'eticketsgo.com';
}

/**
 * One warning per production site variable that points at a generated Railway host or at the
 * bare apex. Empty
 * outside APP_ENV=PRODUCTION, for unset variables and for values that are not URLs (other checks
 * own those).
 */
export function railwayEmailHostWarnings(env: Record<string, string | undefined>): string[] {
  if ((env.APP_ENV ?? '').trim().toUpperCase() !== 'PRODUCTION') return [];
  const warnings: string[] = [];
  for (const [variable, official] of Object.entries(OFFICIAL_PRODUCTION_ORIGINS)) {
    const raw = env[variable]?.trim();
    if (!raw) continue;
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      continue;
    }
    if (isBareApexHost(host)) {
      warnings.push(
        `${variable} points at the bare domain ${host}, which forwards and answers every path ` +
          `with a 404, so every link built on it is dead. Set ${variable}=${official} on the ` +
          `api and worker services (a variable change redeploys, use the pinned procedure).`,
      );
      continue;
    }
    if (!isRailwayGeneratedHost(host)) continue;
    warnings.push(
      `${variable} points at the generated Railway host ${host}, so emails link to and name ` +
        `that host. Set ${variable}=${official} on the api and worker services ` +
        `(see docs/support/REFERENCES.md; a variable change redeploys, use the pinned procedure).`,
    );
  }
  /*
    The return addresses a deployment may set outright (see common/console-urls.ts). A buyer is
    sent to these after paying, so a bare apex here strands them on a 404 - named, not rewritten.
  */
  for (const variable of ['RAZORPAY_CALLBACK_URL', 'STRIPE_SUCCESS_URL', 'STRIPE_CANCEL_URL']) {
    const raw = env[variable]?.trim();
    if (!raw) continue;
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      continue;
    }
    if (!isBareApexHost(host)) continue;
    warnings.push(
      `${variable} points at the bare domain ${host}, which forwards and answers every path ` +
        `with a 404. Use https://www.eticketsgo.com in its place.`,
    );
  }
  return warnings;
}
