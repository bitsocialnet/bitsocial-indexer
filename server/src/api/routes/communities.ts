import type { FastifyPluginAsync } from 'fastify';
import { getCommunity, listCommunities, type CommunitySort } from '../../db/index.js';

const listQuerySchema = {
  type: 'object',
  properties: {
    sort: { type: 'string', enum: ['new', 'active'] },
  },
} as const;

const route: FastifyPluginAsync = async (app) => {
  app.get('/api/communities', { schema: { querystring: listQuerySchema } }, async (req) => {
    const { sort } = req.query as { sort?: CommunitySort };
    return { communities: listCommunities(sort) };
  });

  app.get('/api/communities/:address', async (req, reply) => {
    const { address } = req.params as { address: string };
    const community = getCommunity(address);
    if (!community) return reply.code(404).send({ error: 'community not indexed' });
    return community;
  });
};

export default route;
