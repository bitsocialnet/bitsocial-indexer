import Link from 'next/link';
import { timeAgo } from '@/lib/format';
import type { Comment } from '@/lib/types';

export function PostCard({ post }: { post: Comment }) {
  const score = post.upvote_count - post.downvote_count;
  const heading = post.title || post.content?.slice(0, 90) || 'untitled';
  return (
    <article className="card post">
      <div className="post-score" title="score">▲ {score}</div>
      <div className="post-body">
        <Link href={`/c/${encodeURIComponent(post.cid)}`} className="post-title">
          {heading}
        </Link>
        <div className="meta">
          <Link href={`/p/${encodeURIComponent(post.community_address)}`} className="chip">
            {post.community_address}
          </Link>
          <span>{post.author_name ?? 'anon'}</span>
          <span>·</span>
          <time dateTime={new Date(post.timestamp * 1000).toISOString()}>{timeAgo(post.timestamp)}</time>
          <span>·</span>
          <span>{post.reply_count} {post.reply_count === 1 ? 'reply' : 'replies'}</span>
        </div>
        {post.title && post.content ? <p className="snippet">{post.content.slice(0, 180)}</p> : null}
      </div>
    </article>
  );
}
