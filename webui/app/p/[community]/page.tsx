import type { Metadata } from 'next';
import { ApiDown } from '@/components/Notice';
import { PostCard } from '@/components/PostCard';
import { getCommunity, getPosts } from '@/lib/api';
import { excerpt } from '@/lib/format';

// Cache the rendered page; identical fetches are deduped with generateMetadata.
export const revalidate = 300;

type Params = { params: Promise<{ community: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { community } = await params;
  const address = decodeURIComponent(community);
  const meta = await getCommunity(address);

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

  const [meta, page] = await Promise.all([
    getCommunity(address),
    getPosts(`?community=${encodeURIComponent(address)}&sort=new&limit=50`, 300),
  ]);

  if (page === null) return <ApiDown />;
  const posts = page.posts;

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
