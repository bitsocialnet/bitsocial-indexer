import { ApiDown } from '@/components/Notice';
import { PostCard } from '@/components/PostCard';
import { getCommunity, getPosts } from '@/lib/api';

export default async function CommunityPage({ params }: { params: Promise<{ community: string }> }) {
  const { community } = await params;
  const address = decodeURIComponent(community);

  const [meta, page] = await Promise.all([
    getCommunity(address),
    getPosts(`?community=${encodeURIComponent(address)}&sort=new&limit=50`),
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
