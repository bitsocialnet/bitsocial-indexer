import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState } from '@/components/EmptyState';
import { ApiDown } from '@/components/Notice';
import { PostCard } from '@/components/PostCard';
import { getCommunities, getHealth, getPosts } from '@/lib/api';

// Render at request time (never bake an "API down" page into the build); the
// fetches themselves are cached in the data cache (see lib/api.ts).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
  openGraph: { url: '/' },
};

export default async function Home() {
  const [health, communitiesRes] = await Promise.all([getHealth(), getCommunities()]);

  if (!health) return <ApiDown />;

  const communities = communitiesRes?.communities ?? [];
  if (communities.length === 0) return <EmptyState />;

  const posts = (await getPosts('?sort=new&limit=25'))?.posts ?? [];

  return (
    <div className="layout">
      <section>
        <h2 className="section-title">Recent across {communities.length} communities</h2>
        {posts.length === 0 ? (
          <div className="notice">Communities are configured, but nothing has been indexed yet.</div>
        ) : (
          posts.map((p) => <PostCard key={p.cid} post={p} />)
        )}
      </section>

      <aside className="sidebar">
        <h2 className="section-title">Communities</h2>
        <ul className="community-list">
          {communities.map((c) => (
            <li key={c.address}>
              <Link href={`/p/${encodeURIComponent(c.address)}`}>
                <span>{c.title ?? c.address}</span>
                <span className="count">{c.post_count}</span>
              </Link>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
