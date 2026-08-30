import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import communities from './routes/communities.js';
import health from './routes/health.js';
import posts from './routes/posts.js';
import search from './routes/search.js';
import sitemap from './routes/sitemap.js';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile one wildcard entry to an anchored RegExp. Literal parts are escaped —
 * without that the `.` in a host would match any character, so
 * `https://*.seedit.localhost` would also accept `https://x.seeditXlocalhost`.
 * `*` stands for any run of characters that is not a `/`, which keeps it inside
 * the origin's authority and lets one entry cover nested subdomains.
 */
function wildcardToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('[^/]*')}$`);
}

/**
 * Compile ALLOWED_ORIGINS into what @fastify/cors matches against. Exact
 * strings stay exact strings; an entry containing `*` becomes a RegExp, so a
 * single `https://*.seedit.localhost` covers every branch-scoped dev origin
 * instead of the operator listing each worktree by hand. A bare `*` entry still
 * means "any origin", and an empty setting still allows none.
 */
export function parseAllowedOrigins(value: string): true | (string | RegExp)[] {
  const entries = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.includes('*')) return true;
  return entries.map((entry) => (entry.includes('*') ? wildcardToRegExp(entry) : entry));
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  await app.register(cors, {
    origin: parseAllowedOrigins(config.allowedOrigins),
    methods: ['GET', 'HEAD'], // read-only API
  });

  await app.register(health);
  await app.register(communities);
  await app.register(posts);
  await app.register(search);
  await app.register(sitemap);

  return app;
}
