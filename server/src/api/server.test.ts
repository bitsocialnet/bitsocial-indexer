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
