import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Prose } from '@/components/Prose';
import { isTombstone, Tombstone } from '@/components/Tombstone';
import { getThread } from '@/lib/api';
import { excerpt, timeAgo } from '@/lib/format';
import type { Comment } from '@/lib/types';

// Threads are archived content: cache the page, revalidate for late replies.
export const revalidate = 300;

type Params = { params: Promise<{ cid: string }> };

function score(c: Comment) {
  return c.upvote_count - c.downvote_count;
}

function threadTitle(post: Comment): string {
  if (post.takedown || post.removed) return '[removed]';
  if (post.deleted) return '[deleted]';
  return post.title || excerpt(post.content, 70) || 'untitled';
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { cid } = await params;
  const res = await getThread(decodeURIComponent(cid));
  // The page answers a failed lookup (notFound, or a throw to app/error.tsx);
  // it shares this request.
  if (!res.ok) return {};

  const { post } = res.data;
  const title = threadTitle(post);
  const description =
    excerpt(post.content) || `A thread from ${post.community_address} with ${post.reply_count} replies.`;
  const canonical = `/c/${encodeURIComponent(post.cid)}`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      type: 'article',
      publishedTime: new Date(post.timestamp * 1000).toISOString(),
    },
    twitter: { card: 'summary', title, description },
    // Redacted tombstones have no content worth indexing.
    robots: isTombstone(post) ? { index: false } : undefined,
  };
}

export default async function ThreadPage({ params }: Params) {
  const { cid } = await params;
  const res = await getThread(decodeURIComponent(cid));
  if (!res.ok) {
    // Only the API's own 404 is a missing post. Any other failure goes to the
    // error boundary as a 5xx: a 200 "not found" page (noindexed) during an
    // outage would tell search engines to drop a real archived thread.
    if (res.reason === 'not_found') notFound();
    throw new Error('The indexer API is unavailable.');
  }

  const { post, replies } = res.data;

  return (
    <article>
      <div className="results-head">
        <Link href={`/p/${encodeURIComponent(post.community_address)}`} className="chip">
          {post.community_address}
        </Link>{' '}
        {post.archived ? (
          <span className="flag flag-archived" title="No longer live upstream — preserved by this archive">
            Archived
          </span>
        ) : null}
      </div>

      <div className="card thread-op">
        <h1>{threadTitle(post)}</h1>
        <div className="meta">
          <span>▲ {score(post)}</span>
          <span>·</span>
          <span>{post.author_name ?? 'anon'}</span>
          <span>·</span>
          <time dateTime={new Date(post.timestamp * 1000).toISOString()}>{timeAgo(post.timestamp)}</time>
        </div>
        {post.link ? (
          <p className="meta">
            <a className="chip" href={post.link} target="_blank" rel="noopener noreferrer nofollow">
              {post.link}
            </a>
          </p>
        ) : null}
        {isTombstone(post) ? <Tombstone comment={post} /> : post.content ? <Prose text={post.content} /> : null}
      </div>

      <h2 className="section-title">
        {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
      </h2>
      {replies.map((r) => (
        <div className={`reply${isTombstone(r) ? ' reply-tombstone' : ''}`} key={r.cid}>
          <div className="meta">
            <span>{r.author_name ?? 'anon'}</span>
            <span>·</span>
            <time dateTime={new Date(r.timestamp * 1000).toISOString()}>{timeAgo(r.timestamp)}</time>
            <span>·</span>
            <span>▲ {score(r)}</span>
          </div>
          {isTombstone(r) ? <Tombstone comment={r} /> : <Prose text={r.content ?? ''} />}
        </div>
      ))}
    </article>
  );
}
