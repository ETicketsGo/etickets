import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    '@eticketsgo/shared-types',
    '@eticketsgo/validation',
    '@eticketsgo/web-kit',
  ],
};

export default nextConfig;
