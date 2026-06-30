import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import communities from './routes/communities.js';
import health from './routes/health.js';
import posts from './routes/posts.js';
import search from './routes/search.js';
import sitemap from './routes/sitemap.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  await app.register(cors, {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim()),
  });

  await app.register(health);
  await app.register(communities);
  await app.register(posts);
  await app.register(search);
  await app.register(sitemap);

  return app;
}
