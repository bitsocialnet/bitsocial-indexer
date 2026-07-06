import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.ALLOWED_ORIGINS = 'https://5archive.org,https://staging.5archive.org';
const { buildServer } = await import('./server.js');
const { insertComments, upsertCommunity } = await import('../db/index.js');

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
