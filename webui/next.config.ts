import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The web UI is a thin client over the indexer API (INDEXER_API).
  reactStrictMode: true,
  // Scope build-trace root to this app (ignore unrelated parent lockfiles).
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
};

export default nextConfig;
