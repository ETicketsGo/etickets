/**
 * Android Digital Asset Links (App Links): the file Android fetches from
 * /.well-known/assetlinks.json to confirm an app may open this site's links.
 *
 * Served only when ANDROID_APP_LINKS lists the approved apps, as
 * "package.name:SHA256_FINGERPRINT", comma-separated. A fingerprint is the SHA-256 of the
 * certificate that SIGNS THE INSTALLED APP: for a Play build that is Play App Signing's
 * certificate (Play Console, App integrity), not the upload key. Unset, today's state
 * everywhere, means 404, exactly as before this file existed, so no app starts claiming
 * this site's links until someone deliberately configures it. The iOS twin is
 * apple-app-site-association (PR 470).
 *
 * Which paths open the app is decided by the app's own intent filter (/events, /movies,
 * /booking); this file only says which apps are trusted.
 */
const PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export interface AssetLinkApp {
  packageName: string;
  fingerprint: string;
}

export function parseAndroidApps(value: string | undefined): AssetLinkApp[] {
  const apps: AssetLinkApp[] = [];
  for (const entry of (value ?? '').split(',')) {
    const trimmed = entry.trim();
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const packageName = trimmed.slice(0, colon);
    const fingerprint = trimmed.slice(colon + 1).toUpperCase();
    if (PACKAGE.test(packageName) && FINGERPRINT.test(fingerprint)) {
      apps.push({ packageName, fingerprint });
    }
  }
  return apps;
}

export function buildAssetLinks(appsEnv: string | undefined) {
  const apps = parseAndroidApps(appsEnv);
  if (apps.length === 0) return null;
  // One statement per package, holding every fingerprint configured for it.
  const byPackage = new Map<string, string[]>();
  for (const { packageName, fingerprint } of apps) {
    const list = byPackage.get(packageName) ?? [];
    if (!list.includes(fingerprint)) list.push(fingerprint);
    byPackage.set(packageName, list);
  }
  return [...byPackage.entries()].map(([package_name, sha256_cert_fingerprints]) => ({
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name, sha256_cert_fingerprints },
  }));
}
