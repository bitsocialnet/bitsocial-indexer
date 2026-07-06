import { siteUrl } from '@/lib/site';

// A route handler (not app/robots.ts) so SITE_URL is read at request time —
// operators can rebrand/move an instance without rebuilding. CDN caching comes
// from the Cache-Control header, not build-time prerendering.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=3600',
    },
  });
}
