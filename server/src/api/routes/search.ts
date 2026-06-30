import type { FastifyPluginAsync } from 'fastify';
import { searchPosts, type Sort, type TimeRange } from '../../db/index.js';

interface SearchQuery {
  q?: string;
  community?: string;
  sort?: Sort;
  time?: TimeRange;
  page?: number;
  limit?: number;
  replies?: boolean;
}

const searchQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string' },
    community: { type: 'string' },
    sort: { type: 'string', enum: ['new', 'old', 'top', 'replies'] },
    time: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year', 'all'], default: 'all' },
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    replies: { type: 'boolean', default: true },
  },
} as const;

const route: FastifyPluginAsync = async (app) => {
  app.get('/api/search', { schema: { querystring: searchQuerySchema } }, async (req) => {
    const q = req.query as SearchQuery;
    const query = (q.q ?? '').trim();
    if (!query) return { query: '', posts: [], page: 1, limit: q.limit ?? 25, total: 0 };
    return {
      query,
      ...searchPosts({
        q: query,
        community: q.community,
        sort: q.sort,
        time: q.time,
        page: q.page,
        limit: q.limit,
        includeReplies: q.replies,
      }),
    };
  });
};

export default route;
