import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
