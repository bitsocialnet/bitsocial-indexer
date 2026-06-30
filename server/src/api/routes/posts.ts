import type { FastifyPluginAsync } from 'fastify';
import { getThread, listPosts, type Sort, type TimeRange } from '../../db/index.js';

interface ListQuery {
  community?: string;
  sort?: Sort;
  time?: TimeRange;
  page?: number;
  limit?: number;
  replies?: boolean;
}

// Shared querystring schema — Fastify coerces query strings to these types.
export const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    community: { type: 'string' },
    sort: { type: 'string', enum: ['new', 'old', 'top', 'replies'], default: 'new' },
    time: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year', 'all'], default: 'all' },
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    replies: { type: 'boolean', default: false },
  },
} as const;

const route: FastifyPluginAsync = async (app) => {
  app.get('/api/posts', { schema: { querystring: listQuerySchema } }, async (req) => {
    const q = req.query as ListQuery;
    return listPosts({
      community: q.community,
      sort: q.sort,
      time: q.time,
      page: q.page,
      limit: q.limit,
      includeReplies: q.replies,
    });
  });

  app.get('/api/posts/:cid', async (req, reply) => {
    const { cid } = req.params as { cid: string };
    const thread = getThread(cid);
    if (!thread) return reply.code(404).send({ error: 'post not found' });
    return thread;
  });
};

export default route;
