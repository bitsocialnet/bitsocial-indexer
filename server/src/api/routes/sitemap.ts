import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config.js';
import { listCommunities, listPosts } from '../../db/index.js';

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

const route: FastifyPluginAsync = async (app) => {
  app.get('/robots.txt', async (_req, reply) => {
    reply.type('text/plain');
    return `User-agent: *\nAllow: /\nSitemap: ${config.siteUrl}/sitemap.xml\n`;
  });

  app.get('/sitemap.xml', async (_req, reply) => {
    const base = config.siteUrl.replace(/\/$/, '');
    const urls = [base, `${base}/search`];
    for (const c of listCommunities()) urls.push(`${base}/p/${encodeURIComponent(c.address)}`);
    for (const p of listPosts({ limit: 100, sort: 'new' }).posts) urls.push(`${base}/c/${encodeURIComponent(p.cid)}`);

    reply.type('application/xml');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${xmlEscape(u)}</loc></url>`)
      .join('\n')}\n</urlset>\n`;
  });
};

export default route;
