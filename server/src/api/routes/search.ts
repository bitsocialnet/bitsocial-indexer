import type { FastifyPluginAsync } from 'fastify';
import { searchPosts, type SelfFilter, type Sort, type TimeRange } from '../../db/index.js';

interface SearchQuery {
  q?: string;
  community?: string;
  author?: string;
  site?: string;
  url?: string;
  selftext?: string;
  self?: SelfFilter;
  sort?: Sort;
  time?: TimeRange;
  page?: number;
  limit?: number;
  replies?: boolean;
  nsfw?: boolean;
}

const searchQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string' },
    community: { type: 'string' },
    // The old.reddit-style advanced filters (author:, site:, url:, selftext:,
    // self:). Free-form strings, no defaults — an absent one filters nothing —
    // and they AND with each other and with `q`. See SearchFilters in db/index.
    author: { type: 'string' },
    site: { type: 'string' },
    url: { type: 'string' },
    selftext: { type: 'string' },
    // An enum rather than a boolean, so the wire format keeps all three states:
    // `yes`, `no`, and absent. A boolean would need a default, and any default
    // silently drops half the archive from every query that omits the parameter.
    self: { type: 'string', enum: ['yes', 'no'] },
    sort: { type: 'string', enum: ['new', 'old', 'top', 'replies'] },
    time: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year', 'all'], default: 'all' },
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    replies: { type: 'boolean', default: true },
    // Safe default: NSFW results are excluded unless the client asks for them.
    nsfw: { type: 'boolean', default: false },
  },
} as const;

const route: FastifyPluginAsync = async (app) => {
  app.get('/api/search', { schema: { querystring: searchQuerySchema } }, async (req) => {
    const q = req.query as SearchQuery;
    const query = (q.q ?? '').trim();
    // No early return on an empty `q`: `?author=lena.bso` with no words is a
    // real query. searchPosts decides — free text or any advanced filter is
    // something to search, and nothing at all still returns an empty page.
    return {
      query,
      ...searchPosts({
        q: query,
        community: q.community,
        author: q.author,
        site: q.site,
        url: q.url,
        selftext: q.selftext,
        self: q.self,
        sort: q.sort,
        time: q.time,
        page: q.page,
        limit: q.limit,
        includeReplies: q.replies,
        // The schema default applies, so an absent param excludes NSFW; pass it
        // through explicitly rather than letting `undefined` mean "unfiltered".
        nsfw: q.nsfw ?? false,
      }),
    };
  });
};

export default route;
