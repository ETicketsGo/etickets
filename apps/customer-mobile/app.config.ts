import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * ETicketsGo — customer mobile app (Expo) config. Reads non-secret values from env
 * so the same binary can point at dev/staging/prod. Deep linking scheme: `etickets://`
 * plus the universal-link host from EXPO_PUBLIC_WEB_HOST.
 */
const APP_ENV = process.env.EXPO_PUBLIC_ENV ?? 'development';
// Distinct app identifiers per environment so dev/preview/prod can coexist on a device.
const idSuffix = APP_ENV === 'production' ? '' : APP_ENV === 'staging' ? '.preview' : '.dev';
const nameSuffix = APP_ENV === 'production' ? '' : APP_ENV === 'staging' ? ' (Preview)' : ' (Dev)';
const bundleId = `com.eticketsgo.customer${idSuffix}`;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: `ETicketsGo${nameSuffix}`,
  slug: 'eticketsgo-customer',
  // The Expo account that owns the EAS project. Required alongside extra.eas.projectId
  // for a DYNAMIC config: EAS cannot infer the account from app.config.ts the way it can
  // from a static app.json, and refuses to resolve the project without it.
  owner: 'srinivasdeeptrics',
  scheme: 'etickets',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic', // light + dark
  // New Architecture is the default in SDK 56; the field was removed from ExpoConfig.
  icon: './assets/icon.png',
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: true,
    bundleIdentifier: bundleId,
    associatedDomains: process.env.EXPO_PUBLIC_WEB_HOST
      ? [`applinks:${process.env.EXPO_PUBLIC_WEB_HOST}`]
      : [],
  },
  android: {
    package: bundleId,
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#0B0E15' },
    // Only what the customer app actually uses. expo-camera was removed: nothing in
    // this app scans a QR code — customers DISPLAY one, staff scan it, and that is the
    // organizer app's job. It was pulling in CAMERA and RECORD_AUDIO.
    permissions: ['POST_NOTIFICATIONS'],
    /**
     * Permissions that libraries add and this app does not use. Verified by generating
     * the native project and reading the merged manifest — none of these is visible
     * from JavaScript.
     *
     *  WRITE_SETTINGS       expo-brightness adds it for setSystemBrightnessAsync. The
     *                       ticket screen only calls setBrightnessAsync, which changes
     *                       this app's own window and needs nothing granted.
     *  SYSTEM_ALERT_WINDOW  React Native's dev-menu overlay. It lands in the RELEASE
     *                       manifest, not just debug, and 'draw over other apps' on a
     *                       ticketing app is an obvious Play review question.
     *  *_EXTERNAL_STORAGE   Nothing here reads or writes external storage.
     *
     * Each one is a scary line on an install prompt and a question at review, for a
     * capability the app never exercises.
     */
    blockedPermissions: [
      'android.permission.WRITE_SETTINGS',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ],
    intentFilters: process.env.EXPO_PUBLIC_WEB_HOST
      ? [
          {
            action: 'VIEW',
            autoVerify: true,
            data: [{ scheme: 'https', host: process.env.EXPO_PUBLIC_WEB_HOST }],
            category: ['BROWSABLE', 'DEFAULT'],
          },
        ]
      : [],
  },
  web: { bundler: 'metro', output: 'static', favicon: './assets/favicon.png' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-font',
    // SDK 56: splash is configured via the expo-splash-screen plugin (top-level `splash` removed).
    [
      'expo-splash-screen',
      {
        image: './assets/splash.png',
        resizeMode: 'contain',
        backgroundColor: '#0B0E15',
        imageWidth: 200,
      },
    ],
    ['expo-notifications', { icon: './assets/notification-icon.png', color: '#2563EB' }],
    'expo-image',
    'expo-localization',
    'expo-web-browser',
    [
      '@sentry/react-native/expo',
      {
        organization: process.env.SENTRY_ORG ?? 'eticketsgo',
        project: process.env.SENTRY_PROJECT ?? 'customer-mobile',
      },
    ],
  ],
  experiments: { typedRoutes: true },
  extra: {
    /**
     * EAS project link — @srinivasdeeptrics/eticketsgo-customer.
     *
     * Required by getExpoPushTokenAsync: without it, token acquisition throws and
     * registerDevice() returns null, which is why push could not be completed before
     * the account existed.
     *
     * It belongs HERE, not in a root app.json. Running `eas init` from the monorepo root
     * writes one there and links the WORKSPACE as the Expo project — the app never reads
     * it, the root starts looking like an Expo project to other tooling, and the slug it
     * registers is the root package name (eticketsgo) rather than this app's
     * (eticketsgo-customer), which EAS then rejects as a mismatch.
     */
    eas: { projectId: '6294641c-c830-4932-bfc8-194405d1ab9e' },
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000/api',
    webHost: process.env.EXPO_PUBLIC_WEB_HOST ?? null,
    sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? null,
    env: process.env.EXPO_PUBLIC_ENV ?? 'development',
  },
});
