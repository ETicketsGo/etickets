/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@eticketsgo/design-tokens',
    '@eticketsgo/shared-types',
    '@eticketsgo/validation',
    '@eticketsgo/web-kit',
  ],
};

export default nextConfig;
