import config from '../../../app.config';

/**
 * What the Android build is allowed to ask a user for.
 *
 * Generating the native project revealed the manifest requesting NINE permissions,
 * several of which nothing in this app can reach from JavaScript: CAMERA and
 * RECORD_AUDIO from an expo-camera dependency that had no usages at all, WRITE_SETTINGS
 * from expo-brightness, SYSTEM_ALERT_WINDOW ("draw over other apps") from React Native's
 * dev menu — in the RELEASE manifest, not just debug — and external storage.
 *
 * Every one of those is a line on an install prompt and a question at Play review, for
 * a capability the app never exercises. This test is here because that regressed
 * silently once: a permission arrives through a transitive config plugin, nobody reads
 * a generated file, and it ships.
 */

/**
 * app.config.ts is a ConfigContext function. Only `config` is read (it is spread into
 * the result), so the remaining context fields are supplied as empty rather than
 * pretending to be a real Expo CLI invocation.
 */
const resolved = config({
  config: {} as never,
  projectRoot: '',
  staticConfigPath: null,
  packageJsonPath: '',
});

/** The complete set this app is entitled to request. Adding one is a deliberate act. */
const ALLOWED = ['POST_NOTIFICATIONS'];

describe('Android permissions', () => {
  it('requests only what it uses', () => {
    expect(resolved.android?.permissions).toEqual(ALLOWED);
  });

  it('does not ask for the camera', () => {
    // Customers DISPLAY a QR code; staff scan it, and that is the organizer app's job.
    expect(resolved.android?.permissions).not.toContain('CAMERA');
    expect(JSON.stringify(resolved.plugins)).not.toContain('expo-camera');
  });

  it('blocks the permissions libraries add behind our back', () => {
    const blocked = resolved.android?.blockedPermissions ?? [];

    // WRITE_SETTINGS would send someone in a ticket queue to a system settings screen to
    // grant "modify system settings" — for a brightness call that never needed it.
    expect(blocked).toContain('android.permission.WRITE_SETTINGS');
    // "Draw over other apps" on a ticketing app invites exactly the review question you
    // would expect.
    expect(blocked).toContain('android.permission.SYSTEM_ALERT_WINDOW');
    expect(blocked).toContain('android.permission.READ_EXTERNAL_STORAGE');
    expect(blocked).toContain('android.permission.WRITE_EXTERNAL_STORAGE');
  });

  it('keeps the deep-link scheme, which the payment return depends on', () => {
    // followPaymentAction hands the browser etickets://booking/<id>. Losing the scheme
    // would strand every hosted-payment return outside the app.
    expect(resolved.scheme).toBe('etickets');
  });
});
