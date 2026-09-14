import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const profiling = process.env.NEXT_PUBLIC_REACT_PERF === '1';

const nextConfig: NextConfig = {
  // Profiling output never replaces deployable production output.
  distDir: process.env.REACT_PERF_SCENARIO === '1' ? '.next-perf-dev' : profiling ? '.next-perf' : '.next',
  reactProductionProfiling: profiling,
  productionBrowserSourceMaps: profiling,
  // Define the disabled value too, so production can erase guarded imports.
  env: { NEXT_PUBLIC_REACT_PERF: profiling ? '1' : '0' },
  devIndicators: process.env.REACT_PERF_SCENARIO === '1' ? false : undefined,
  // The web UI is a thin client over the indexer API (INDEXER_API).
  reactStrictMode: true,
  // Scope build-trace root to this app (ignore unrelated parent lockfiles).
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
};

export default nextConfig;
