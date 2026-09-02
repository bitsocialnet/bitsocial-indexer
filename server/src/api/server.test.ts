import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.ALLOWED_ORIGINS = 'https://5archive.org,https://staging.5archive.org,https://*.seedit.localhost';
const { buildServer, parseAllowedOrigins } = await import('./server.js');
const { insertComments, setBlocklist, setDirectorySafeForWork, upsertCommunity } = await import('../db/index.js');

const app = await buildServer();
test.after(() => app.close());

test('CORS: allows configured origins on the read API', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/health',
    headers: { origin: 'https://5archive.org' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'https://5archive.org');
});

test('CORS: preflight advertises read-only methods', async () => {
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/api/posts',
    headers: { origin: 'https://5archive.org', 'access-control-request-method': 'GET' },
  });
  assert.equal(res.headers['access-control-allow-origin'], 'https://5archive.org');
  assert.equal(res.headers['access-control-allow-methods'], 'GET, HEAD');
});

test('CORS: unlisted origins get no allow-origin header', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/health',
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('CORS: a wildcard entry admits every branch-scoped dev origin', async () => {
  for (const origin of ['https://feat-nsfw.seedit.localhost', 'https://another-branch.seedit.localhost']) {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { origin } });
    assert.equal(res.headers['access-control-allow-origin'], origin);
  }
});

test('CORS: a wildcard entry does not admit look-alike origins', async () => {
  for (const origin of [
    'https://seedit.localhost.evil.example', // suffix must still be the end
    'https://branch.seeditXlocalhost', // the literal dots are escaped
    'http://branch.seedit.localhost', // scheme is part of the match
  ]) {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { origin } });
    assert.equal(res.headers['access-control-allow-origin'], undefined, origin);
  }
});

test('parseAllowedOrigins keeps exact entries exact and compiles only wildcards', () => {
  assert.deepEqual(parseAllowedOrigins('https://5archive.org, https://staging.5archive.org'), [
    'https://5archive.org',
    'https://staging.5archive.org',
  ]);
  assert.deepEqual(parseAllowedOrigins(''), [], 'an empty allow-list still allows nothing');
  assert.equal(parseAllowedOrigins('*'), true);
  assert.equal(parseAllowedOrigins('https://5archive.org,*'), true, '"*" anywhere allows any origin');
});

test('parseAllowedOrigins anchors the compiled pattern and escapes its literal parts', () => {
  const [pattern] = parseAllowedOrigins('https://*.seedit.localhost') as RegExp[];
  assert.ok(pattern instanceof RegExp);
  assert.equal(pattern.source, '^https:\\/\\/[^/]*\\.seedit\\.localhost$');
  assert.ok(pattern.test('https://feat-x.seedit.localhost'));
  assert.ok(pattern.test('https://a.b.seedit.localhost'), 'nested labels still match');
  assert.equal(pattern.test('https://seeditXlocalhost'), false);
  assert.equal(pattern.test('https://x.seedit.localhost.evil.example'), false);
  assert.equal(pattern.test('https://evil.example/x.seedit.localhost'), false, '* cannot swallow a path');
});

test('API serves removed comments as redacted tombstones', async () => {
  upsertCommunity({ address: 'api.bso', last_indexed_at: 1 });
  insertComments([
    {
      cid: 'api-op',
      community_address: 'api.bso',
      post_cid: 'api-op',
      depth: 0,
      timestamp: 1,
      title: 'secret title',
      content: 'secret body',
      author_name: 'someone',
    },
  ]);
  insertComments([
    { cid: 'api-op', community_address: 'api.bso', post_cid: 'api-op', depth: 0, timestamp: 1, removed: true },
  ]);

  const res = await app.inject({ method: 'GET', url: '/api/posts/api-op' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { post: { removed: number; title: string | null; content: string | null; author_name: string | null } };
  assert.equal(body.post.removed, 1);
  assert.equal(body.post.title, null);
  assert.equal(body.post.content, null);
  assert.equal(body.post.author_name, null);
});

test('API serves blocklisted comments as takedown tombstones, reversibly', async () => {
  insertComments([
    {
      cid: 'api-blocked',
      community_address: 'api.bso',
      post_cid: 'api-blocked',
      depth: 0,
      timestamp: 1,
      title: 'infringing title',
      content: 'copyrighted zebu',
      author_name: 'uploader',
    },
  ]);
  setBlocklist([{ cid: 'api-blocked', scope: 'comment', reason: 'DMCA #7' }]);

  const res = await app.inject({ method: 'GET', url: '/api/posts/api-blocked' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    post: { takedown: number; takedown_reason: string | null; title: string | null; content: string | null; author_name: string | null };
  };
  assert.equal(body.post.takedown, 1);
  assert.equal(body.post.takedown_reason, 'DMCA #7');
  assert.equal(body.post.title, null);
  assert.equal(body.post.content, null);
  assert.equal(body.post.author_name, null);

  const search = await app.inject({ method: 'GET', url: '/api/search?q=zebu' });
  assert.equal((search.json() as { total: number }).total, 0);

  // Unblock: the stored content serves again.
  setBlocklist([]);
  const restored = await app.inject({ method: 'GET', url: '/api/posts/api-blocked' });
  const restoredBody = restored.json() as { post: { takedown: number; content: string | null } };
  assert.equal(restoredBody.post.takedown, 0);
  assert.equal(restoredBody.post.content, 'copyrighted zebu');
  const search2 = await app.inject({ method: 'GET', url: '/api/search?q=zebu' });
  assert.equal((search2.json() as { total: number }).total, 1);
});

test('search excludes NSFW by default and includes it on request', async () => {
  insertComments([
    {
      cid: 'api-nsfw',
      community_address: 'api.bso',
      post_cid: 'api-nsfw',
      depth: 0,
      timestamp: 1,
      content: 'explicit dugong',
      nsfw: true,
    },
  ]);

  const byDefault = await app.inject({ method: 'GET', url: '/api/search?q=dugong' });
  assert.equal(byDefault.statusCode, 200);
  assert.equal((byDefault.json() as { total: number }).total, 0);

  const optedIn = await app.inject({ method: 'GET', url: '/api/search?q=dugong&nsfw=true' });
  assert.equal((optedIn.json() as { total: number }).total, 1);

  const optedOut = await app.inject({ method: 'GET', url: '/api/search?q=dugong&nsfw=false' });
  assert.equal((optedOut.json() as { total: number }).total, 0);
});

test('search rejects a non-boolean nsfw parameter', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/search?q=dugong&nsfw=maybe' });
  assert.equal(res.statusCode, 400);
});

test('communities expose the resolved nsfw flag', async () => {
  upsertCommunity({ address: 'api-adult.bso', last_indexed_at: 1 });
  upsertCommunity({ address: 'api-sfw.bso', last_indexed_at: 1 });
  setDirectorySafeForWork([{ address: 'api-adult.bso', safeForWork: false }]);

  const one = await app.inject({ method: 'GET', url: '/api/communities/api-adult.bso' });
  assert.equal(one.statusCode, 200);
  assert.equal((one.json() as { nsfw: number }).nsfw, 1);

  const list = await app.inject({ method: 'GET', url: '/api/communities' });
  const { communities } = list.json() as { communities: { address: string; nsfw: number }[] };
  assert.equal(communities.find((c) => c.address === 'api-adult.bso')?.nsfw, 1);
  assert.equal(communities.find((c) => c.address === 'api-sfw.bso')?.nsfw, 0);

  setDirectorySafeForWork([]);
  const cleared = await app.inject({ method: 'GET', url: '/api/communities/api-adult.bso' });
  assert.equal((cleared.json() as { nsfw: number }).nsfw, 0, 'dropping the directory verdict drops the flag');
});

test('communities expose the crawled safeForWork alongside the resolved flag', async () => {
  upsertCommunity({ address: 'api-declared.bso', last_indexed_at: 1, safe_for_work: 0 });

  const declared = await app.inject({ method: 'GET', url: '/api/communities/api-declared.bso' });
  const body = declared.json() as { safe_for_work: number | null; nsfw: number };
  assert.equal(body.safe_for_work, 0, "the owner's own declaration is served as-is");
  assert.equal(body.nsfw, 1, 'and resolves to NSFW without any other signal');

  // A community nobody has declared for reads back as unset, not as false.
  const unset = await app.inject({ method: 'GET', url: '/api/communities/api-sfw.bso' });
  assert.equal((unset.json() as { safe_for_work: number | null }).safe_for_work, null);
});

test('search drops results from a community whose owner declared it NSFW', async () => {
  upsertCommunity({ address: 'api-declared.bso', last_indexed_at: 1, safe_for_work: 0 });
  insertComments([
    {
      cid: 'api-declared-op',
      community_address: 'api-declared.bso',
      post_cid: 'api-declared-op',
      depth: 0,
      timestamp: 1,
      content: 'tame quokka',
    },
  ]);

  const byDefault = await app.inject({ method: 'GET', url: '/api/search?q=quokka' });
  assert.equal((byDefault.json() as { total: number }).total, 0, 'the comment itself is not flagged; its community is');
  const optedIn = await app.inject({ method: 'GET', url: '/api/search?q=quokka&nsfw=true' });
  assert.equal((optedIn.json() as { total: number }).total, 1);

  // Listings stay unfiltered — only search takes a side.
  const listed = await app.inject({ method: 'GET', url: '/api/posts?community=api-declared.bso' });
  assert.equal((listed.json() as { total: number }).total, 1);
});

test('API never serves pending-approval comments', async () => {
  insertComments([
    {
      cid: 'api-pending',
      community_address: 'api.bso',
      post_cid: 'api-pending',
      depth: 0,
      timestamp: 1,
      content: 'in the mod queue',
      pending_approval: true,
    },
  ]);
  const res = await app.inject({ method: 'GET', url: '/api/posts/api-pending' });
  assert.equal(res.statusCode, 404);
});

test('search honours the old.reddit-style advanced filters', async () => {
  upsertCommunity({ address: 'api-adv.bso', last_indexed_at: 1 });
  insertComments([
    {
      cid: 'api-adv-text',
      community_address: 'api-adv.bso',
      post_cid: 'api-adv-text',
      depth: 0,
      timestamp: 1,
      author_address: 'lena.bso',
      author_name: 'Lena',
      title: 'ink study',
      content: 'notes on the tokenizer, aardwolf',
    },
    {
      cid: 'api-adv-link',
      community_address: 'api-adv.bso',
      post_cid: 'api-adv-link',
      depth: 0,
      timestamp: 2,
      author_address: 'nils.bso',
      content: 'aardwolf',
      link: 'https://www.example.com/ink-study/1',
    },
    {
      cid: 'api-adv-decoy',
      community_address: 'api-adv.bso',
      post_cid: 'api-adv-decoy',
      depth: 0,
      timestamp: 3,
      author_address: 'nils.bso',
      content: 'aardwolf',
      link: 'https://evil.example/?r=example.com',
    },
  ]);

  const total = async (query: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/search?${query}` });
    assert.equal(res.statusCode, 200, query);
    return (res.json() as { total: number }).total;
  };

  assert.equal(await total('q=aardwolf'), 3);
  assert.equal(await total('q=aardwolf&author=lena.bso'), 1, 'author: by address');
  assert.equal(await total('q=aardwolf&author=Lena'), 1, 'author: or by display name');
  assert.equal(await total('q=aardwolf&site=example.com'), 1, 'site: the parsed host, subdomains included');
  assert.equal(await total('q=aardwolf&url=ink-study'), 1, 'url: a substring of the link');
  assert.equal(await total('q=aardwolf&selftext=tokenizer'), 1, 'selftext: words in the body');
  assert.equal(await total('q=aardwolf&self=yes'), 1, 'self=yes: text posts');
  assert.equal(await total('q=aardwolf&self=no'), 2, 'self=no: link posts');
  assert.equal(await total('q=aardwolf'), 3, 'self absent: no opinion, link posts kept');
  assert.equal(await total('q=aardwolf&author=nils.bso&site=example.com&self=no'), 1, 'and they AND together');
  assert.equal(await total('q=aardwolf&author=lena.bso&site=example.com'), 0);
  assert.equal(await total('q=hoopoe&author=lena.bso'), 0, 'free text narrows the filters too');
});

test('search runs the advanced filters with no q at all', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/search?author=lena.bso' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { query: string; total: number; posts: { cid: string }[] };
  assert.equal(body.query, '');
  assert.equal(body.total, 1);
  assert.equal(body.posts[0]?.cid, 'api-adv-text');

  // Narrowing parameters are not a search by themselves: without free text or
  // an advanced filter the endpoint still returns an empty page.
  const narrowing = await app.inject({ method: 'GET', url: '/api/search?community=api-adv.bso&time=all' });
  assert.equal((narrowing.json() as { total: number }).total, 0);
});

test('search rejects an unknown self value and drops unknown parameters', async () => {
  const bad = await app.inject({ method: 'GET', url: '/api/search?q=aardwolf&self=maybe' });
  assert.equal(bad.statusCode, 400);

  // additionalProperties: false, as on /api/posts — Fastify strips what the
  // schema does not declare rather than failing the request.
  const unknown = await app.inject({ method: 'GET', url: '/api/search?q=aardwolf&nope=1' });
  assert.equal(unknown.statusCode, 200);
  assert.equal((unknown.json() as { total: number }).total, 3);
});

// ── search by CID ────────────────────────────────────────────────────────────

// Real CIDs (sha2-256 of fixture strings): the lookup is gated on parsing, so
// the placeholder cids the tests above use can never reach it.
const CID_OP = 'QmabF7Ayiu6Gb4P6cQmSk5duaNmYKFYQPt1Vs7s7kbVqAt';
const CID_REPLY = 'bafkreiae5me4knhhkqsxjj5y5ydkarontx5opxfpjrrplxqbbuyrexig4e';
const CID_UNKNOWN = 'Qmdf1E29f8rEDKqdw67H4Q6ZmzoCzHnuBWKXpL3e9k5Ssa';
const CID_PENDING = 'QmTQdrxFPKuShDZMvodDUrdTfZdcDes4d5cGCpnBiadzQP';
const CID_REMOVED = 'QmZE94S83gfqpQxLD11zBM9H3yT7kuPdePnn6BCJmza4w3';
const CID_TAKEDOWN = 'QmWoCtQy3ebbVvKAo1ohCKLBwWe5MqsVhDLnQEY342GM22';
const CID_NSFW = 'QmQv3QpsWqHQbLgrWWJJVnE7YFY5RCpZSivizYjYGS1Hdu';

const searchTotal = async (query: string): Promise<number> => {
  const res = await app.inject({ method: 'GET', url: `/api/search?${query}` });
  assert.equal(res.statusCode, 200, query);
  return (res.json() as { total: number }).total;
};

test('search finds a comment by its CIDv0, as an ordinary result', async () => {
  upsertCommunity({ address: 'api-cid.bso', last_indexed_at: 1 });
  insertComments([
    {
      cid: CID_OP,
      community_address: 'api-cid.bso',
      post_cid: CID_OP,
      depth: 0,
      timestamp: 1,
      title: 'bristling zebra',
      content: 'koala Quail caracara',
    },
    {
      cid: CID_REPLY,
      community_address: 'api-cid.bso',
      post_cid: CID_OP,
      parent_cid: CID_OP,
      depth: 1,
      timestamp: 2,
      content: 'a reply, caracara',
    },
  ]);

  const res = await app.inject({ method: 'GET', url: `/api/search?q=${CID_OP}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    query: string;
    total: number;
    page: number;
    limit: number;
    posts: { cid: string; title: string | null }[];
  };
  assert.equal(body.query, CID_OP);
  assert.equal(body.total, 1);
  assert.equal(body.page, 1);
  assert.equal(body.limit, 25);
  assert.equal(body.posts.length, 1);
  assert.equal(body.posts[0]?.cid, CID_OP);
  assert.equal(body.posts[0]?.title, 'bristling zebra', 'served with its content, like any search hit');
});

test('search finds a reply by its CIDv1, unless replies are excluded', async () => {
  const hit = await app.inject({ method: 'GET', url: `/api/search?q=${CID_REPLY}` });
  const body = hit.json() as { total: number; posts: { cid: string; depth: number }[] };
  assert.equal(body.total, 1);
  assert.equal(body.posts[0]?.cid, CID_REPLY);
  assert.equal(body.posts[0]?.depth, 1);
  assert.equal(await searchTotal(`q=${CID_REPLY}&replies=false`), 0, 'replies=false narrows a CID lookup too');
});

test('search by an unknown CID is an empty page, not an error', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/search?q=${CID_UNKNOWN}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { query: CID_UNKNOWN, posts: [], page: 1, limit: 25, total: 0 });
});

test('search never returns a pending-approval comment by CID', async () => {
  const row = { cid: CID_PENDING, community_address: 'api-cid.bso', post_cid: CID_PENDING, depth: 0, timestamp: 1, content: 'in the mod queue' };
  insertComments([{ ...row, pending_approval: true }]);
  assert.equal(await searchTotal(`q=${CID_PENDING}`), 0, 'mod-queue content is never indexed');

  insertComments([row]);
  assert.equal(await searchTotal(`q=${CID_PENDING}`), 1);
  insertComments([{ ...row, pending_approval: true }]);
  assert.equal(await searchTotal(`q=${CID_PENDING}`), 0, 'and a row sent back to the queue stops being served');
});

test('search returns a removed comment by CID as the redacted tombstone', async () => {
  const row = {
    cid: CID_REMOVED,
    community_address: 'api-cid.bso',
    post_cid: CID_REMOVED,
    depth: 0,
    timestamp: 1,
    title: 'secret title',
    content: 'secret body',
    author_name: 'someone',
  };
  insertComments([row]);
  insertComments([{ ...row, removed: true, mod_reason: 'spam' }]);

  const res = await app.inject({ method: 'GET', url: `/api/search?q=${CID_REMOVED}` });
  const body = res.json() as {
    total: number;
    posts: { cid: string; removed: number; mod_reason: string | null; title: string | null; content: string | null; author_name: string | null }[];
  };
  assert.equal(body.total, 1);
  const tomb = body.posts[0];
  assert.equal(tomb?.cid, CID_REMOVED);
  assert.equal(tomb?.removed, 1);
  assert.equal(tomb?.mod_reason, 'spam');
  assert.equal(tomb?.title, null);
  assert.equal(tomb?.content, null);
  assert.equal(tomb?.author_name, null);

  const thread = await app.inject({ method: 'GET', url: `/api/posts/${CID_REMOVED}` });
  assert.deepEqual(tomb, (thread.json() as { post: unknown }).post, 'the very tombstone /api/posts/:cid serves');
});

test('search returns a taken-down comment by CID as the takedown tombstone, never its content', async () => {
  insertComments([
    {
      cid: CID_TAKEDOWN,
      community_address: 'api-cid.bso',
      post_cid: CID_TAKEDOWN,
      depth: 0,
      timestamp: 1,
      title: 'infringing title',
      content: 'copyrighted body',
      author_name: 'uploader',
      link: 'https://example.com/leak',
    },
  ]);
  setBlocklist([{ cid: CID_TAKEDOWN, scope: 'comment', reason: 'DMCA #9' }]);

  const res = await app.inject({ method: 'GET', url: `/api/search?q=${CID_TAKEDOWN}` });
  const body = res.json() as {
    total: number;
    posts: { takedown: number; takedown_reason: string | null; title: string | null; content: string | null; link: string | null }[];
  };
  assert.equal(body.total, 1);
  assert.equal(body.posts[0]?.takedown, 1);
  assert.equal(body.posts[0]?.takedown_reason, 'DMCA #9');
  assert.equal(body.posts[0]?.title, null);
  assert.equal(body.posts[0]?.content, null);
  assert.equal(body.posts[0]?.link, null);

  // No oracle over the redacted columns: a content filter hides the tombstone
  // rather than answering yes/no about what it hides.
  for (const filter of ['url=leak', 'site=example.com', 'author=uploader', 'self=no', 'selftext=copyrighted']) {
    assert.equal(await searchTotal(`q=${CID_TAKEDOWN}&${filter}`), 0, filter);
  }

  setBlocklist([]);
  assert.equal(await searchTotal(`q=${CID_TAKEDOWN}&url=leak`), 1, 'restored content is filterable again');
});

test('search by CID composes with community', async () => {
  assert.equal(await searchTotal(`q=${CID_OP}&community=api-cid.bso`), 1);
  assert.equal(await searchTotal(`q=${CID_OP}&community=api.bso`), 0, 'a CID in another community is not in this one');
});

test('search by CID still honours the NSFW default', async () => {
  insertComments([
    { cid: CID_NSFW, community_address: 'api-cid.bso', post_cid: CID_NSFW, depth: 0, timestamp: 1, content: 'explicit', nsfw: true },
  ]);
  assert.equal(await searchTotal(`q=${CID_NSFW}`), 0, 'a pasted CID is not a way around the instance policy');
  assert.equal(await searchTotal(`q=${CID_NSFW}&nsfw=true`), 1);
});

test('search treats a CID with other words as text, and leaves word queries alone', async () => {
  const total = (q: string) => searchTotal(`q=${encodeURIComponent(q)}`);
  assert.equal(await total(`${CID_OP} caracara`), 0, 'mixed input is a text search, which cannot match a CID');
  assert.equal(await total(`caracara ${CID_OP}`), 0);
  assert.equal(await total(CID_OP.slice(0, -1)), 0, 'a truncated CID is not a CID');
  assert.equal(await total('caracara'), 2, 'an ordinary word query is unaffected');
  // Words that start like a multibase prefix (Q, b, z, k) are still words.
  assert.equal(await total('Quail'), 1);
  assert.equal(await total('bristling'), 1);
  assert.equal(await total('zebra'), 1);
  assert.equal(await total('koala'), 1);
});
