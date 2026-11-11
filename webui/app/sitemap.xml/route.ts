import { getCommunities } from '@/lib/api';
import { absUrl, CORE_SITEMAP, SITEMAP_TTL, sitemapIndexXml, unavailableResponse, xmlResponse } from '@/lib/sitemap';

// Sitemap index: one child sitemap per community, plus "core" (static pages).
// Rendered per request (nothing is baked at build time, so builds don't need
// the API); the community list fetch + the CDN response are cached for an hour.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const res = await getCommunities(SITEMAP_TTL);
  if (!res.ok) return unavailableResponse();
  const children = [CORE_SITEMAP, ...res.data.communities.map((c) => c.address)];
  return xmlResponse(sitemapIndexXml(children.map((id) => absUrl(`/sitemaps/${encodeURIComponent(id)}`))));
}
