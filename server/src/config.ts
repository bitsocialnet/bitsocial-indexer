import { join } from 'node:path';

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function positiveDuration(value: string | undefined, fallback: number, name: string): number {
  const duration = Number(value ?? fallback);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`${name} must be a finite positive number of milliseconds`);
  }
  return duration;
}

/** Runtime configuration, all sourced from environment variables. */
export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '0.0.0.0',

  /** SQLite file path, or ":memory:" for an ephemeral index. */
  dbPath: process.env.DB_PATH ?? join(process.cwd(), 'data', 'indexer.db'),

  /** bitsocial-cli daemon RPC endpoint (PKC over WebSocket). */
  pkcRpcUrl: process.env.PKC_RPC_URL ?? 'ws://localhost:9138',

  /** Communities to index. BOTH empty by default → the indexer serves nothing. */
  communities: list(process.env.COMMUNITIES),
  communitiesSource: process.env.COMMUNITIES_SOURCE ?? '',

  crawlIntervalMs: Number(process.env.CRAWL_INTERVAL_MS ?? 60_000),

  /** Maximum communities crawled at once. */
  crawlConcurrency: Number(process.env.CRAWL_CONCURRENCY ?? 4),

  /**
   * Operator takedown blocklist: path to a JSON file of CIDs that must not be
   * served (DMCA, illegal content). Empty = no blocklist. See src/blocklist.ts.
   */
  blocklistSource: process.env.BLOCKLIST_SOURCE ?? '',

  /**
   * Operator NSFW overrides: path to a JSON file naming communities this
   * instance must treat as NSFW (or explicitly not NSFW, to correct a bad
   * inference). Empty = no overrides. See src/nsfw.ts.
   */
  nsfwOverridesSource: process.env.NSFW_OVERRIDES_SOURCE ?? '',

  /** Pagination bounds per crawl pass (keeps a single tick bounded). */
  crawlMaxPages: Number(process.env.CRAWL_MAX_PAGES ?? 20),
  crawlMaxReplyDepth: Number(process.env.CRAWL_MAX_REPLY_DEPTH ?? 6),

  /**
   * Hard cap on one community's crawl pass. The PKC calls a pass makes can hang
   * indefinitely (a daemon that accepts the socket but never answers), which
   * would stall every community queued behind it.
   */
  crawlTimeoutMs: positiveDuration(process.env.CRAWL_TIMEOUT_MS, 300_000, 'CRAWL_TIMEOUT_MS'),

  /** Load demo data on boot (same as `npm run seed`). */
  seedDemo: process.env.SEED_DEMO === 'true',

  siteName: process.env.SITE_NAME ?? 'Bitsocial Indexer',
  siteUrl: process.env.SITE_URL ?? 'http://localhost:4000',

  /**
   * CORS allow-list, comma-separated ("*" = any origin — fine for a public
   * read-only API). CORS_ORIGIN is the legacy name, kept as a fallback.
   */
  allowedOrigins: process.env.ALLOWED_ORIGINS ?? process.env.CORS_ORIGIN ?? '*',
} as const;

/** True when the operator has configured something to index. */
export function hasConfiguredCommunities(): boolean {
  return config.communities.length > 0 || config.communitiesSource.length > 0;
}
