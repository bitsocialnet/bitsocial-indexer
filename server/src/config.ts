import { join } from 'node:path';

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
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

  /** Pagination bounds per crawl pass (keeps a single tick bounded). */
  crawlMaxPages: Number(process.env.CRAWL_MAX_PAGES ?? 20),
  crawlMaxReplyDepth: Number(process.env.CRAWL_MAX_REPLY_DEPTH ?? 6),

  /** Load demo data on boot (same as `npm run seed`). */
  seedDemo: process.env.SEED_DEMO === 'true',

  siteName: process.env.SITE_NAME ?? 'Bitsocial Indexer',
  siteUrl: process.env.SITE_URL ?? 'http://localhost:4000',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
} as const;

/** True when the operator has configured something to index. */
export function hasConfiguredCommunities(): boolean {
  return config.communities.length > 0 || config.communitiesSource.length > 0;
}
