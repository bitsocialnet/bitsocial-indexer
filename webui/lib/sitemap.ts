import { siteUrl } from './site';

/**
 * Sitemap plumbing shared by app/sitemap.xml and app/sitemaps/[community].
 *
 * The sitemap is an index of per-community child sitemaps, each enumerating
 * that community's posts via the API's paginated /api/posts listing (newest
 * first, capped — see MAX_URLS_PER_COMMUNITY). A synthetic "core" child covers
 * the static pages and community landing pages.
 */

/** API page size (the API's maximum). */
export const SITEMAP_PAGE_LIMIT = 100;
/** Cap per community: the most recent 5,000 posts (50 API pages). */
export const MAX_URLS_PER_COMMUNITY = 5_000;
/** How long (seconds) fetched enumeration data and CDN responses stay cached. */
export const SITEMAP_TTL = 3_600;

/** Child sitemap id for static + community landing pages. */
export const CORE_SITEMAP = 'core';

export const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

export const absUrl = (path: string) => `${siteUrl}${path}`;

/** XML response, CDN-cached (Vercel respects s-maxage) so crawls stay cheap. */
export function xmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, s-maxage=${SITEMAP_TTL}, stale-while-revalidate=${SITEMAP_TTL}`,
    },
  });
}

export function urlsetXml(urls: { loc: string; lastmod?: string }[]): string {
  const entries = urls
    .map((u) => `  <url><loc>${xmlEscape(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

export function sitemapIndexXml(locs: string[]): string {
  const entries = locs.map((l) => `  <sitemap><loc>${xmlEscape(l)}</loc></sitemap>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
}
