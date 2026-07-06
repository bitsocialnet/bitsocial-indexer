import { getCommunities } from '@/lib/api';
import { absUrl, CORE_SITEMAP, SITEMAP_TTL, sitemapIndexXml, xmlResponse } from '@/lib/sitemap';

// Sitemap index: one child sitemap per community, plus "core" (static pages).
// Rendered per request (nothing is baked at build time, so builds don't need
// the API); the community list fetch + the CDN response are cached for an hour.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const communities = (await getCommunities(SITEMAP_TTL))?.communities ?? [];
  const children = [CORE_SITEMAP, ...communities.map((c) => c.address)];
  return xmlResponse(sitemapIndexXml(children.map((id) => absUrl(`/sitemaps/${encodeURIComponent(id)}`))));
}
