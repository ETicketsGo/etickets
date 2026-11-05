import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';
import { NOINDEX_ALL, isIndexableDeployment } from './lib/indexability.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/*
  QA, UAT and any build not configured as the production storefront answer every request -
  pages, images, robots.txt, the manifest - with `X-Robots-Tag: noindex, nofollow`. The rule
  is in `lib/indexability.mjs`, shared with the pages, so the two cannot disagree. Production
  sends no such header here; the middleware adds `noindex` only for a non-canonical host.
*/
const INDEXABLE = isIndexableDeployment({
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
  appEnv: process.env.NEXT_PUBLIC_APP_ENV,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /*
    Overridable build output. `output: 'standalone'` means a locally running server holds
    `.next/standalone` open, and on Windows that makes the directory undeletable — so a
    verification build cannot run while the app is being served from the same tree. Unset
    everywhere except a local check build, so deployments are unchanged.
  */
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Emit a self-contained server bundle (.next/standalone) for slim runtime images.
  output: 'standalone',
  // Trace files from the monorepo root so workspace deps are bundled correctly.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: [
    '@eticketsgo/design-tokens',
    '@eticketsgo/i18n',
    '@eticketsgo/shared-types',
    '@eticketsgo/validation',
    '@eticketsgo/web-kit',
  ],
  /*
    Metadata in <head>, for every client.

    Next 15 streams metadata into <body> for clients it does not recognise as a bot, and only
    a short built-in list gets it in <head>. Crawlers outside that list (and some link
    previewers) then read a page whose <head> has no title, canonical or robots tag. Matching
    every user agent puts it in <head> always; the cost is that the first byte waits for
    `generateMetadata`, which reads a cached API answer.
  */
  htmlLimitedBots: /.*/,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
          ...(INDEXABLE ? [] : [{ key: 'X-Robots-Tag', value: NOINDEX_ALL }]),
        ],
      },
    ];
  },
};

/*
  The plugin wires `i18n/request.ts` into the server components runtime. Without it
  `getTranslations` has no config to read and every server-rendered message throws at
  request time rather than at build time, which is the worst place to find out.
*/
export default createNextIntlPlugin('./i18n/request.ts')(nextConfig);
