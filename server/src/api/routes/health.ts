import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config.js';
import { stats } from '../../db/index.js';

const route: FastifyPluginAsync = async (app) => {
  app.get('/api/health', async () => ({
    status: 'ok',
    site: config.siteName,
    ...stats(),
  }));
};

export default route;
