import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Fail the build on type errors rather than shipping them. Next 16 no longer runs
  // ESLint during the build, so linting is a separate step in `npm run verify` and CI.
  typescript: { ignoreBuildErrors: false },

  // Prisma and the Google/Anthropic SDKs need Node built-ins, so they must not be
  // bundled for the browser or the edge runtime.
  serverExternalPackages: ['@prisma/client'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
