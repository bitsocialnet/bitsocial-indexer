import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
const {
  getCommunity,
  getThread,
  insertComments,
  listPosts,
  searchPosts,
  setBlocklist,
  setDirectorySafeForWork,
  stats,
  upsertCommunity,
} = await import('./index.js');
type CommentInput = import('./index.js').CommentInput;

const COMMUNITY = 'test.bso';
const now = Math.floor(Date.now() / 1000);
let seq = 0;

function makeComment(overrides: Partial<CommentInput> = {}): CommentInput {
  const cid = overrides.cid ?? `cid-${++seq}`;
  return {
    cid,
    community_address: COMMUNITY,
    post_cid: cid,
    parent_cid: null,
    depth: 0,
    timestamp: now,
    author_address: 'author.bso',
    author_name: 'author',
    title: `title ${cid}`,
    content: `content ${cid}`,
    ...overrides,
  };
}

upsertCommunity({ address: COMMUNITY, last_indexed_at: now });

test('pendingApproval comments are never indexed or served', () => {
  const pending = makeComment({ cid: 'pending-1', content: 'modqueue zebra', pending_approval: true });
  assert.equal(insertComments([pending]), 0);
  assert.equal(getThread('pending-1'), null);
  assert.equal(listPosts({ community: COMMUNITY }).posts.some((p) => p.cid === 'pending-1'), false);
  assert.equal(searchPosts({ q: 'zebra' }).total, 0);
});

test('a previously-pending comment that is later approved gets indexed normally', () => {
  const cid = 'approved-1';
  assert.equal(insertComments([makeComment({ cid, pending_approval: true })]), 0);
  assert.equal(insertComments([makeComment({ cid, content: 'now approved walrus' })]), 1);
  assert.equal(getThread(cid)?.post.content, 'now approved walrus');
  assert.equal(searchPosts({ q: 'walrus' }).total, 1);
});

test('an update marking an indexed comment as pending stops serving it', () => {
  const cid = 'pending-later-1';
  assert.equal(insertComments([makeComment({ cid, content: 'unique quokka' })]), 1);
  assert.ok(getThread(cid));
  assert.equal(searchPosts({ q: 'quokka' }).total, 1);

  insertComments([makeComment({ cid, pending_approval: true })]);
  assert.equal(getThread(cid), null);
  assert.equal(searchPosts({ q: 'quokka' }).total, 0);
  assert.equal(listPosts({ community: COMMUNITY }).posts.some((p) => p.cid === cid), false);
});

test('removed comments become redacted tombstones that preserve thread structure', () => {
  const op = makeComment({ cid: 'op-removed', content: 'op body' });
  const reply = makeComment({
    cid: 'reply-removed',
    post_cid: 'op-removed',
    parent_cid: 'op-removed',
    depth: 1,
    title: null,
    content: 'rulebreaking axolotl',
  });
  assert.equal(insertComments([op, reply]), 2);
  assert.equal(searchPosts({ q: 'axolotl', includeReplies: true }).total, 1);

  insertComments([{ ...reply, removed: true, mod_reason: 'spam' }]);
  const thread = getThread('op-removed');
  assert.ok(thread);
  const tomb = thread.replies.find((r) => r.cid === 'reply-removed');
  assert.ok(tomb, 'tombstone row still present in the thread');
  assert.equal(tomb.removed, 1);
  assert.equal(tomb.content, null);
  assert.equal(tomb.title, null);
  assert.equal(tomb.author_address, null);
  assert.equal(tomb.author_name, null);
  assert.equal(tomb.raw, null);
  assert.equal(tomb.mod_reason, 'spam');
  assert.equal(searchPosts({ q: 'axolotl', includeReplies: true }).total, 0);
  assert.equal(listPosts({ community: COMMUNITY, includeReplies: true }).posts.some((p) => p.cid === 'reply-removed'), false);
});

test('author-deleted comments are redacted the same way', () => {
  const cid = 'op-deleted';
  insertComments([makeComment({ cid, content: 'regret pangolin' })]);
  insertComments([makeComment({ cid, deleted: true })]);

  const thread = getThread(cid);
  assert.ok(thread, 'deleted OP is still fetchable as a tombstone');
  assert.equal(thread.post.deleted, 1);
  assert.equal(thread.post.content, null);
  assert.equal(searchPosts({ q: 'pangolin' }).total, 0);
  assert.equal(listPosts({ community: COMMUNITY }).posts.some((p) => p.cid === cid), false);
});

test('content persists and is marked archived after it disappears upstream', () => {
  const t1 = now - 100;
  const t2 = now - 10;
  const cid = 'op-archived';
  insertComments([makeComment({ cid, content: 'ephemeral capybara', first_seen_at: t1, last_seen_at: t1 })]);
  upsertCommunity({ address: COMMUNITY, last_indexed_at: t1 });
  assert.equal(getThread(cid)?.post.archived, 0);

  // Next crawl succeeds but no longer sees the thread (purged upstream).
  upsertCommunity({ address: COMMUNITY, last_indexed_at: t2 });
  const thread = getThread(cid);
  assert.ok(thread, 'thread is still served after upstream purge');
  assert.equal(thread.post.content, 'ephemeral capybara');
  assert.equal(thread.post.archived, 1);
  assert.equal(searchPosts({ q: 'capybara' }).total, 1);
  const listed = listPosts({ community: COMMUNITY }).posts.find((p) => p.cid === cid);
  assert.equal(listed?.archived, 1);

  // Restore for other tests.
  upsertCommunity({ address: COMMUNITY, last_indexed_at: t1 });
});

test('an explicit upstream archived flag also marks the thread archived', () => {
  const cid = 'op-flagged-archived';
  insertComments([makeComment({ cid, upstream_archived: true, last_seen_at: now })]);
  upsertCommunity({ address: COMMUNITY, last_indexed_at: now });
  assert.equal(getThread(cid)?.post.archived, 1);
});

test('re-crawls refresh counters and last_seen_at but never blank archived content', () => {
  const cid = 'op-recrawl';
  insertComments([makeComment({ cid, content: 'original text', upvote_count: 1, last_seen_at: now - 50 })]);
  // Upstream update with no content (e.g. a stripped page entry) must not erase it.
  assert.equal(
    insertComments([makeComment({ cid, title: null, content: null, upvote_count: 7, reply_count: 3, last_seen_at: now })]),
    0,
  );
  const post = getThread(cid)?.post;
  assert.equal(post?.content, 'original text');
  assert.equal(post?.upvote_count, 7);
  assert.equal(post?.reply_count, 3);
  assert.equal(post?.last_seen_at, now);
});

test('re-crawls move legacy-address rows under the configured canonical community', () => {
  const cid = 'op-legacy-community';
  const archivedCid = 'op-legacy-community-archived';
  insertComments([
    makeComment({ cid, community_address: 'test.eth' }),
    makeComment({ cid: archivedCid, community_address: 'test.eth' }),
  ]);
  assert.equal(listPosts({ community: 'test.eth' }).posts.some((p) => p.cid === cid), true);

  insertComments([makeComment({ cid, community_address: COMMUNITY })]);
  assert.equal(listPosts({ community: 'test.eth' }).posts.some((p) => p.cid === cid), false);
  assert.equal(listPosts({ community: COMMUNITY }).posts.some((p) => p.cid === cid), true);
  assert.equal(listPosts({ community: COMMUNITY }).posts.some((p) => p.cid === archivedCid), true);
});

test('blocklist (comment scope) redacts a takedown tombstone and drops it from search', () => {
  const op = makeComment({ cid: 'bl-op', content: 'infringing narwhal' });
  const reply = makeComment({
    cid: 'bl-reply',
    post_cid: 'bl-op',
    parent_cid: 'bl-op',
    depth: 1,
    title: null,
    content: 'innocent bystander reply',
  });
  assert.equal(insertComments([op, reply]), 2);
  assert.equal(searchPosts({ q: 'narwhal' }).total, 1);

  setBlocklist([{ cid: 'bl-op', scope: 'comment', reason: 'DMCA #42' }]);
  const thread = getThread('bl-op');
  assert.ok(thread, 'blocked OP is still fetchable as a tombstone');
  assert.equal(thread.post.takedown, 1);
  assert.equal(thread.post.takedown_reason, 'DMCA #42');
  assert.equal(thread.post.title, null);
  assert.equal(thread.post.content, null);
  assert.equal(thread.post.author_address, null);
  assert.equal(thread.post.author_name, null);
  assert.equal(thread.post.raw, null);
  // Comment scope leaves the rest of the thread alone.
  const rep = thread.replies.find((r) => r.cid === 'bl-reply');
  assert.equal(rep?.takedown, 0);
  assert.equal(rep?.content, 'innocent bystander reply');
  assert.equal(searchPosts({ q: 'narwhal' }).total, 0);
  assert.equal(listPosts({ community: COMMUNITY }).posts.some((p) => p.cid === 'bl-op'), false);
  setBlocklist([]);
});

test('blocklist (thread scope) redacts the post and every reply', () => {
  insertComments([
    makeComment({ cid: 'blt-op', content: 'whole thread ocelot' }),
    makeComment({
      cid: 'blt-r1',
      post_cid: 'blt-op',
      parent_cid: 'blt-op',
      depth: 1,
      title: null,
      content: 'reply ocelot one',
    }),
  ]);
  setBlocklist([{ cid: 'blt-op', scope: 'thread', reason: 'court order' }]);

  const thread = getThread('blt-op');
  assert.ok(thread);
  assert.equal(thread.post.takedown, 1);
  const r1 = thread.replies.find((r) => r.cid === 'blt-r1');
  assert.equal(r1?.takedown, 1);
  assert.equal(r1?.takedown_reason, 'court order');
  assert.equal(r1?.content, null);
  assert.equal(searchPosts({ q: 'ocelot', includeReplies: true }).total, 0);
});

test('re-crawling a blocklisted thread does not resurrect it', () => {
  // Upstream upsert of the blocked OP…
  insertComments([makeComment({ cid: 'blt-op', content: 'whole thread ocelot', upvote_count: 9 })]);
  // …and a brand-new reply crawled into the blocked thread.
  insertComments([
    makeComment({
      cid: 'blt-r2',
      post_cid: 'blt-op',
      parent_cid: 'blt-op',
      depth: 1,
      title: null,
      content: 'late reply ocelot',
    }),
  ]);

  const thread = getThread('blt-op');
  assert.ok(thread);
  assert.equal(thread.post.takedown, 1);
  assert.equal(thread.post.content, null);
  const r2 = thread.replies.find((r) => r.cid === 'blt-r2');
  assert.equal(r2?.takedown, 1, 'new reply in a blocked thread is born redacted');
  assert.equal(r2?.content, null);
  assert.equal(searchPosts({ q: 'ocelot', includeReplies: true }).total, 0);
});

test('removing a blocklist entry restores content, listings, and search', () => {
  setBlocklist([]);
  const thread = getThread('blt-op');
  assert.ok(thread);
  assert.equal(thread.post.takedown, 0);
  assert.equal(thread.post.takedown_reason, null);
  assert.equal(thread.post.content, 'whole thread ocelot');
  assert.equal(thread.post.upvote_count, 9, 're-crawl updates applied while blocked survive');
  const r2 = thread.replies.find((r) => r.cid === 'blt-r2');
  assert.equal(r2?.content, 'late reply ocelot');
  assert.equal(searchPosts({ q: 'ocelot', includeReplies: true }).total, 3, 'FTS re-indexed on unblock');
  assert.equal(listPosts({ community: COMMUNITY }).posts.some((p) => p.cid === 'blt-op'), true);
});

test('unblocking a comment that is also mod-removed keeps it a tombstone', () => {
  insertComments([makeComment({ cid: 'bl-removed', content: 'double jeopardy ibex' })]);
  insertComments([makeComment({ cid: 'bl-removed', removed: true })]);
  setBlocklist([{ cid: 'bl-removed', scope: 'comment', reason: null }]);
  setBlocklist([]);
  assert.equal(getThread('bl-removed')?.post.removed, 1);
  assert.equal(getThread('bl-removed')?.post.content, null);
  assert.equal(searchPosts({ q: 'ibex' }).total, 0, 'unblock never re-indexes removed content');
});

test('search excludes a flagged comment when asked, and includes it when not', () => {
  insertComments([makeComment({ cid: 'nsfw-comment', content: 'explicit tapir', nsfw: true })]);

  assert.equal(searchPosts({ q: 'tapir', nsfw: false }).total, 0);
  assert.equal(searchPosts({ q: 'tapir', nsfw: true }).total, 1);
  assert.equal(searchPosts({ q: 'tapir' }).total, 1, 'no opinion means no filtering');
});

test('search excludes every result from an NSFW community, flagged or not', () => {
  const community = 'nsfw-community.bso';
  upsertCommunity({ address: community, last_indexed_at: now });
  insertComments([makeComment({ cid: 'nsfw-com-op', community_address: community, content: 'tame gerenuk' })]);
  assert.equal(searchPosts({ q: 'gerenuk', nsfw: false }).total, 1);

  setDirectorySafeForWork([{ address: community, safeForWork: false }]);
  assert.equal(getCommunity(community)?.nsfw, 1);
  assert.equal(searchPosts({ q: 'gerenuk', nsfw: false }).total, 0);
  assert.equal(searchPosts({ q: 'gerenuk', nsfw: true }).total, 1);

  setDirectorySafeForWork([]);
  assert.equal(searchPosts({ q: 'gerenuk', nsfw: false }).total, 1);
});

test('the NSFW filter applies to the result total as well as the page', () => {
  const community = 'nsfw-total.bso';
  upsertCommunity({ address: community, last_indexed_at: now });
  insertComments([
    makeComment({ cid: 'nsfw-total-1', community_address: community, content: 'counted markhor' }),
    makeComment({ cid: 'nsfw-total-2', community_address: community, content: 'counted markhor', nsfw: true }),
  ]);

  const excluded = searchPosts({ q: 'markhor', nsfw: false });
  assert.equal(excluded.total, 1);
  assert.equal(excluded.posts.length, 1);

  const listed = listPosts({ community, nsfw: false });
  assert.equal(listed.total, 1);
  assert.equal(listed.posts.length, 1);
  assert.equal(listPosts({ community }).total, 2, 'listings are unfiltered by default');
});

test('an update that omits nsfw never un-flags an already-flagged comment', () => {
  const cid = 'nsfw-sticky';
  insertComments([makeComment({ cid, content: 'sticky serval', nsfw: true })]);
  insertComments([makeComment({ cid, upvote_count: 3 })]);

  assert.equal(getThread(cid)?.post.nsfw, 1);
  assert.equal(getThread(cid)?.post.upvote_count, 3, 'the rest of the update still applied');
  assert.equal(searchPosts({ q: 'serval', nsfw: false }).total, 0);
});

test('stats count only servable comments', () => {
  const before = stats();
  insertComments([
    makeComment({ cid: 'stats-visible' }),
    makeComment({ cid: 'stats-removed', removed: true }),
    makeComment({ cid: 'stats-pending', pending_approval: true }),
  ]);
  const after = stats();
  assert.equal(after.posts, before.posts + 1);
});
