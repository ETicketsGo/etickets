/**
 * Apple App Site Association for universal links.
 *
 * Served only when APPLE_APP_IDS lists the approved apps ("TEAMID.bundle.id", comma-separated).
 * Unset — today's state everywhere — means 404, exactly as before this file existed, so no app
 * starts claiming this site's links until someone deliberately configures it.
 *
 * Paths: what a customer shares or is sent (events, movies, a booking). Payment returns
 * (/checkout/*) are excluded on purpose: they must keep landing in the browser, where the
 * existing web confirmation flow runs.
 */
const APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/;

const LOCALE_PREFIXES = ['', '/fr-CA'];
const SHARED_PATHS = ['/events/*', '/movies/*', '/booking/*'];

export function parseAppIds(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => APP_ID.test(id));
}

export function buildAppleAppSiteAssociation(appIdsEnv: string | undefined) {
  const appIDs = parseAppIds(appIdsEnv);
  if (appIDs.length === 0) return null;
  return {
    applinks: {
      details: [
        {
          appIDs,
          components: [
            ...LOCALE_PREFIXES.map((prefix) => ({ '/': `${prefix}/checkout/*`, exclude: true })),
            ...LOCALE_PREFIXES.flatMap((prefix) =>
              SHARED_PATHS.map((path) => ({ '/': `${prefix}${path}` })),
            ),
          ],
        },
      ],
    },
  };
}
