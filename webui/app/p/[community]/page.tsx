import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PostCard } from '@/components/PostCard';
import { getCommunity, getPosts } from '@/lib/api';
import { excerpt } from '@/lib/format';

// Cache the rendered page; identical fetches are deduped with generateMetadata.
export const revalidate = 300;

type Params = { params: Promise<{ community: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { community } = await params;
  const address = decodeURIComponent(community);
  const res = await getCommunity(address);
  const meta = res.ok ? res.data : null;

  const title = meta?.title ?? address;
  const description = excerpt(meta?.description) || `Indexed posts from ${address}.`;
  const canonical = `/p/${encodeURIComponent(address)}`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { title, description, url: canonical },
    twitter: { card: 'summary', title, description },
  };
}

export default async function CommunityPage({ params }: Params) {
  const { community } = await params;
  const address = decodeURIComponent(community);

  const [metaRes, pageRes] = await Promise.all([
    getCommunity(address),
    getPosts(`?community=${encodeURIComponent(address)}&sort=new&limit=50`, 300),
  ]);

  // The title and heading fall back to the URL text, so render only once the
  // address is known to exist. The API's own 404 with no posts filed under the
  // address is a 404, as in the sitemap route. Any API failure leaves that
  // unknown: throw to app/error.tsx (5xx) instead of answering 200 under that
  // title. Posts whose community row was never created stay browsable.
  if (!pageRes.ok) throw new Error('The indexer API is unavailable.');
  if (!metaRes.ok && pageRes.data.total === 0) {
    if (metaRes.reason === 'not_found') notFound();
    throw new Error('The indexer API is unavailable.');
  }
  const meta = metaRes.ok ? metaRes.data : null;
  const posts = pageRes.data.posts;

  return (
    <div>
      <div className="results-head">
        <h1>{meta?.title ?? address}</h1>
        <p>
          {meta?.description ?? address}
          {meta ? ` · ${meta.post_count} ${meta.post_count === 1 ? 'post' : 'posts'}` : ''}
        </p>
      </div>
      {posts.length === 0 ? (
        <div className="notice">No posts indexed for this community yet.</div>
      ) : (
        posts.map((p) => <PostCard key={p.cid} post={p} />)
      )}
    </div>
  );
}
