import { getCommunities, getCommunity, getPosts } from '@/lib/api';
import {
  absUrl,
  CORE_SITEMAP,
  MAX_URLS_PER_COMMUNITY,
  SITEMAP_PAGE_LIMIT,
  SITEMAP_TTL,
  urlsetXml,
  xmlResponse,
} from '@/lib/sitemap';

type Params = { params: Promise<{ community: string }> };

const isoDate = (unixSec: number) => new Date(unixSec * 1000).toISOString();

/** Static pages + one landing page per community. */
async function coreUrls() {
  const communities = (await getCommunities(SITEMAP_TTL))?.communities ?? [];
  return [
    { loc: absUrl('/') },
    { loc: absUrl('/search') },
    ...communities.map((c) => ({ loc: absUrl(`/p/${encodeURIComponent(c.address)}`) })),
  ];
}

/**
 * Enumerate a community's threads through the paginated /api/posts listing,
 * newest first, capped at MAX_URLS_PER_COMMUNITY (older posts stay reachable
 * for crawlers through internal links, just not sitemap-listed). Each API page
 * is cached for SITEMAP_TTL, so a full crawl costs at most
 * MAX_URLS_PER_COMMUNITY / SITEMAP_PAGE_LIMIT requests per community per hour.
 */
async function communityUrls(address: string) {
  const urls: { loc: string; lastmod?: string }[] = [];
  const maxPages = Math.ceil(MAX_URLS_PER_COMMUNITY / SITEMAP_PAGE_LIMIT);
  for (let page = 1; page <= maxPages; page++) {
    const res = await getPosts(
      `?community=${encodeURIComponent(address)}&sort=new&limit=${SITEMAP_PAGE_LIMIT}&page=${page}`,
      SITEMAP_TTL,
    );
    if (!res || res.posts.length === 0) break;
    for (const p of res.posts) {
      urls.push({ loc: absUrl(`/c/${encodeURIComponent(p.cid)}`), lastmod: isoDate(p.timestamp) });
    }
    if (res.posts.length < SITEMAP_PAGE_LIMIT || urls.length >= MAX_URLS_PER_COMMUNITY) break;
  }
  return urls.slice(0, MAX_URLS_PER_COMMUNITY);
}

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const { community } = await params;
  const id = decodeURIComponent(community);

  if (id === CORE_SITEMAP) return xmlResponse(urlsetXml(await coreUrls()));

  if (!(await getCommunity(id))) return new Response('unknown sitemap', { status: 404 });
  return xmlResponse(urlsetXml(await communityUrls(id)));
}
