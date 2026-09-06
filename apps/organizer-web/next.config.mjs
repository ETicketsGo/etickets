import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /*
    Build output directory, overridable.

    `output: 'standalone'` means a locally RUNNING server holds `.next/standalone` open, and
    on Windows an open file makes the whole directory undeletable — so a verification build
    cannot run while the app is being served from the same tree, and fails with "Device or
    resource busy" rather than anything that names the cause. `NEXT_DIST_DIR` lets a check
    build somewhere else and leaves the running server's output alone. Unset everywhere
    else, so deployments are unchanged.
  */
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Emit a self-contained server bundle (.next/standalone) for slim runtime images.
  output: 'standalone',
  // Trace files from the monorepo root so workspace deps are bundled correctly.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: [
    '@eticketsgo/design-tokens',
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

export default nextConfig;
