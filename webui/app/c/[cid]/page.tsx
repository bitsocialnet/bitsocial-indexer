import Link from 'next/link';
import { getThread } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import type { Comment } from '@/lib/types';

function score(c: Comment) {
  return c.upvote_count - c.downvote_count;
}

export default async function ThreadPage({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const thread = await getThread(decodeURIComponent(cid));

  if (thread === null) {
    return <div className="notice">Post not found, or the indexer API isn’t reachable.</div>;
  }

  const { post, replies } = thread;

  return (
    <article>
      <div className="results-head">
        <Link href={`/p/${encodeURIComponent(post.community_address)}`} className="chip">
          {post.community_address}
        </Link>
      </div>

      <div className="card thread-op">
        <h1>{post.title || 'untitled'}</h1>
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
        {post.content ? <p className="prose">{post.content}</p> : null}
      </div>

      <h2 className="section-title">
        {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
      </h2>
      {replies.map((r) => (
        <div className="reply" key={r.cid}>
          <div className="meta">
            <span>{r.author_name ?? 'anon'}</span>
            <span>·</span>
            <time dateTime={new Date(r.timestamp * 1000).toISOString()}>{timeAgo(r.timestamp)}</time>
            <span>·</span>
            <span>▲ {score(r)}</span>
          </div>
          <p className="prose">{r.content}</p>
        </div>
      ))}
    </article>
  );
}
