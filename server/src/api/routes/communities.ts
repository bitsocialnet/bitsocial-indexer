import type { FastifyPluginAsync } from 'fastify';
import { getCommunity, listCommunities } from '../../db/index.js';

const route: FastifyPluginAsync = async (app) => {
  app.get('/api/communities', async () => ({ communities: listCommunities() }));

  app.get('/api/communities/:address', async (req, reply) => {
    const { address } = req.params as { address: string };
    const community = getCommunity(address);
    if (!community) return reply.code(404).send({ error: 'community not indexed' });
    return community;
  });
};

export default route;
