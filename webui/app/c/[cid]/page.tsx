import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Prose } from '@/components/Prose';
import { isTombstone, Tombstone } from '@/components/Tombstone';
import { getThread } from '@/lib/api';
import { commentPath, excerpt, timeAgo } from '@/lib/format';
import type { Comment } from '@/lib/types';

type Params = { params: Promise<{ cid: string }> };

function score(c: Comment) {
  return c.upvote_count - c.downvote_count;
}

/** A thread's OP. The post_cid check treats a malformed row as one. */
function isRoot(c: Comment): boolean {
  return c.depth === 0 || c.post_cid === c.cid;
}

/**
 * The replies listed under `post`. For a reply (rendered only when the API
 * hides its root), the API still returns every served reply in the root's
 * thread, the reply itself and its siblings included, so keep only its
 * descendants. Linked by parent_cid rather than position: replies come sorted
 * by timestamp, which the author's client sets.
 */
function repliesUnder(post: Comment, replies: Comment[]): Comment[] {
  if (isRoot(post)) return replies;
  const children = new Map<string, Comment[]>();
  for (const r of replies) {
    if (r.parent_cid === null) continue;
    const siblings = children.get(r.parent_cid);
    if (siblings) siblings.push(r);
    else children.set(r.parent_cid, [r]);
  }
  const under = new Set([post.cid]);
  const queue = [post.cid];
  for (let cid = queue.pop(); cid !== undefined; cid = queue.pop()) {
    for (const child of children.get(cid) ?? []) {
      if (under.has(child.cid)) continue;
      under.add(child.cid);
      queue.push(child.cid);
    }
  }
  return replies.filter((r) => r.cid !== post.cid && under.has(r.cid));
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

/**
 * A reply's CID (search returns replies) opens the reply in its thread. The
 * API answers it with the reply as the post and the root left out, so
 * rendering it as a thread would show one without its OP under a new URL.
 * The API hides rows one by one, so a root pending approval (or never indexed)
 * can have served replies: redirect only while the root is served, and
 * temporarily, since it can be hidden later. Otherwise the reply renders.
 * isRoot's post_cid check keeps a malformed row from redirecting to itself.
 */
async function redirectReplyToThread(post: Comment): Promise<void> {
  if (isRoot(post)) return;
  const root = await getThread(post.post_cid);
  if (root.ok) redirect(commentPath(post));
  if (root.reason === 'unavailable') throw new Error('The indexer API is unavailable.');
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

  const { post } = res.data;
  await redirectReplyToThread(post);
  const replies = repliesUnder(post, res.data.replies);

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
        <div className={`reply${isTombstone(r) ? ' reply-tombstone' : ''}`} key={r.cid} id={r.cid}>
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
