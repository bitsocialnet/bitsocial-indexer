import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const communityAddress = 'perf-fixture-board';
export const communityTitle = 'Perf fixture community';
export const threadCid = 'perf-thread-001';
export const threadTitle = 'Perf needle thread';
const timestamp = 1_700_000_000;

const comment = (cid, overrides = {}) => ({
  cid, community_address: communityAddress, post_cid: cid, parent_cid: null,
  depth: 0, timestamp, author_address: 'perf-author', author_name: 'Fixture author',
  title: 'Perf fixture thread', content: 'Deterministic archive content.', link: null,
  thumbnail_url: null, upvote_count: 8, downvote_count: 1, reply_count: 0,
  indexed_at: timestamp, archived: 1, removed: 0, deleted: 0, mod_reason: null,
  takedown: 0, takedown_reason: null, ...overrides,
});

const posts = [
  comment(threadCid, { title: threadTitle, reply_count: 2 }),
  comment('perf-thread-002', { title: 'Perf second thread', timestamp: timestamp - 1 }),
  comment('perf-thread-003', { title: 'Perf third thread', timestamp: timestamp - 2 }),
];
const replies = [1, 2].map((number) => comment(`perf-reply-00${number}`, {
  post_cid: threadCid, parent_cid: threadCid, depth: 1, title: null,
  content: `Fixture reply ${number}`, timestamp: timestamp + number,
}));
const community = {
  address: communityAddress, title: communityTitle, description: 'Controlled performance fixture',
  added_at: timestamp, last_indexed_at: timestamp, post_count: posts.length,
};

/** The application fetches on the server, so browser request mocks cannot supply these responses. */
export async function startFixtureApi(port = 0) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let data;
    if (url.pathname === '/api/health') {
      data = { status: 'ok', site: 'perf-fixture', communities: 1, posts: posts.length,
        replies: replies.length, lastIndexedAt: timestamp };
    } else if (url.pathname === '/api/communities') {
      data = { communities: [community] };
    } else if (url.pathname === `/api/communities/${communityAddress}`) {
      data = community;
    } else if (url.pathname === '/api/posts' || url.pathname === '/api/search') {
      const query = url.searchParams.get('q') ?? '';
      const selected = url.pathname === '/api/search'
        ? posts.filter((post) => `${post.title} ${post.content}`.toLowerCase().includes(query.toLowerCase()))
        : posts;
      const requestedCommunity = url.searchParams.get('community');
      const matching = requestedCommunity && requestedCommunity !== communityAddress ? [] : selected;
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const limit = Math.max(1, Number(url.searchParams.get('limit')) || 25);
      data = { posts: matching.slice((page - 1) * limit, page * limit), page, limit, total: matching.length,
        ...(url.pathname === '/api/search' ? { query } : {}) };
    } else if (url.pathname.startsWith('/api/posts/')) {
      const cid = decodeURIComponent(url.pathname.slice('/api/posts/'.length));
      const post = [...posts, ...replies].find((entry) => entry.cid === cid);
      if (post) data = { post, replies: cid === threadCid ? replies : [] };
    }
    response.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data ?? { error: 'Unknown fixture endpoint' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    env: { INDEXER_API: `http://127.0.0.1:${address.port}`, UPSTREAM_NAME: '', UPSTREAM_URL: '' },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

// Optional standalone fixture for a separately started profiling build.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const fixture = await startFixtureApi(Number(process.env.REACT_PERF_API_PORT ?? 0));
  console.log(`INDEXER_API=${fixture.env.INDEXER_API}`);
  const close = () => { void fixture.close().then(() => process.exit(0)); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
