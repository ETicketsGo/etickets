/**
 * Money and date formatting.
 *
 * The implementations moved to @eticketsgo/shared-types so the mobile app renders
 * amounts identically to the web without a second copy of the INR whole-rupee rule.
 * They are re-exported here because ~200 call sites import them from web-kit, and a
 * package boundary is not worth churning those imports over. Behaviour is unchanged:
 * the locale and timeZone parameters shared-types adds are optional and default to
 * what this module always did.
 */
export { money, dateTime, dateOnly, titleCase, zoneAbbrev } from '@eticketsgo/shared-types';
