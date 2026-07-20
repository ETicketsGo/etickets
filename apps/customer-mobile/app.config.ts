import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * ETicketsGo — customer mobile app (Expo) config. Reads non-secret values from env
 * so the same binary can point at dev/staging/prod. Deep linking scheme: `etickets://`
 * plus the universal-link host from EXPO_PUBLIC_WEB_HOST.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'ETicketsGo',
  slug: 'eticketsgo-customer',
  scheme: 'etickets',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic', // light + dark
  newArchEnabled: true,
  icon: './assets/icon.png',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#0B0E15',
  },
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.eticketsgo.customer',
    associatedDomains: process.env.EXPO_PUBLIC_WEB_HOST
      ? [`applinks:${process.env.EXPO_PUBLIC_WEB_HOST}`]
      : [],
    infoPlist: {
      NSCameraUsageDescription: 'Scan QR codes to check in to your events.',
    },
  },
  android: {
    package: 'com.eticketsgo.customer',
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#0B0E15' },
    permissions: ['CAMERA', 'POST_NOTIFICATIONS'],
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
    ['expo-camera', { cameraPermission: 'Scan QR codes to check in to your events.' }],
    ['expo-notifications', { icon: './assets/notification-icon.png', color: '#2563EB' }],
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
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000/api',
    webHost: process.env.EXPO_PUBLIC_WEB_HOST ?? null,
    sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? null,
    env: process.env.EXPO_PUBLIC_ENV ?? 'development',
  },
});
