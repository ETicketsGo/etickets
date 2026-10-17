/*
  The offline revocation window (H5): the longest a check-in device that has been suspended,
  revoked or reported lost can keep admitting people from the ticket list it already holds.

  Offline check-in means a phone at the door validates tickets against a signed list it
  downloaded earlier, with no network. Revoking that phone on the server cannot reach it while
  it is offline, so the only bound on a revoked phone is how long its list stays valid. That is
  this window: the list expires `window` minutes after it was issued, the phone refuses to admit
  from an expired list, and getting a new list needs an ACTIVE device.

  WHY 45 MINUTES BY DEFAULT
  - A cinema door opens 20-30 minutes before the show; nearly every admission happens then.
    One list downloaded as the door opens covers the whole rush.
  - A concert or stadium door opens 60-90 minutes early. Staff can refresh the list at any
    moment of signal (box-office Wi-Fi, a step outside), and the page refreshes it on its own
    whenever it is online, so a door with patchy signal never notices the window.
  - A door with NO signal at all for longer than the window stops admitting offline and says
    so. That is the trade: the same number is both how long a stolen phone keeps working and
    how long an honest phone can go without any connection. 45 minutes keeps the first short
    and still covers a door rush end to end.
  - The old 6-hour list meant a phone revoked at the start of a festival kept admitting until
    the end of it.

  Production allows at most 60 minutes, and it must be set on purpose: offline check-in cannot
  be switched on in production with the default left implicit (see configuration.ts).
*/

/** Used when OFFLINE_REVOCATION_WINDOW_MINUTES is not set (every environment but production). */
export const OFFLINE_REVOCATION_WINDOW_DEFAULT_MINUTES = 45;
/** The shortest window the schema accepts: shorter would expire a list mid-queue. */
export const OFFLINE_REVOCATION_WINDOW_MIN_MINUTES = 5;
/** The longest window allowed where real customers are served (STAGING / PRODUCTION). */
export const OFFLINE_REVOCATION_WINDOW_PRODUCTION_MAX_MINUTES = 60;
/** The longest window the schema accepts anywhere (long rehearsals in lower environments). */
export const OFFLINE_REVOCATION_WINDOW_MAX_MINUTES = 360;

/** The effective window in milliseconds for a configured (or unset) value. */
export function offlineRevocationWindowMs(minutes: number | undefined): number {
  return (minutes ?? OFFLINE_REVOCATION_WINDOW_DEFAULT_MINUTES) * 60_000;
}

export interface OfflineWindowConfig {
  APP_ENV: string;
  OFFLINE_CHECKIN_ENABLED: boolean;
  OFFLINE_REVOCATION_WINDOW_MINUTES?: number;
}

/**
 * Why this configuration may not run offline check-in, as lines for a boot error. Empty when
 * it may. Pure, so the rule can be tested without booting anything.
 *
 * Keyed on APP_ENV, like the deliverability guard: QA and UAT run NODE_ENV=production and must
 * stay free to rehearse with longer windows; only STAGING and PRODUCTION serve real doors.
 */
export function offlineWindowContradictions(cfg: OfflineWindowConfig): string[] {
  if (!cfg.OFFLINE_CHECKIN_ENABLED) return [];
  if (!['STAGING', 'PRODUCTION'].includes(cfg.APP_ENV)) return [];
  const minutes = cfg.OFFLINE_REVOCATION_WINDOW_MINUTES;
  if (minutes === undefined) {
    return [
      '  - OFFLINE_CHECKIN_ENABLED=true needs OFFLINE_REVOCATION_WINDOW_MINUTES set on purpose ' +
        `(${OFFLINE_REVOCATION_WINDOW_MIN_MINUTES}-${OFFLINE_REVOCATION_WINDOW_PRODUCTION_MAX_MINUTES}). ` +
        'It is how long a lost or revoked door phone can keep admitting people from its saved list.',
    ];
  }
  if (minutes > OFFLINE_REVOCATION_WINDOW_PRODUCTION_MAX_MINUTES) {
    return [
      `  - OFFLINE_REVOCATION_WINDOW_MINUTES=${minutes} is longer than the ` +
        `${OFFLINE_REVOCATION_WINDOW_PRODUCTION_MAX_MINUTES} minutes allowed in ${cfg.APP_ENV}: a ` +
        `lost or revoked door phone could keep admitting people for ${minutes} minutes.`,
    ];
  }
  return [];
}
