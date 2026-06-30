import { buildServer } from './api/server.js';
import { config } from './config.js';
import { startCrawler, stopCrawler } from './crawler/crawler.js';
import { getDb } from './db/index.js';

async function main(): Promise<void> {
  getDb(); // initialise schema

  if (config.seedDemo) {
    const { seedDemo } = await import('./db/seed.js');
    console.log(`[seed] loaded ${seedDemo()} demo comments`);
  }

  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });

  // Idle unless the operator configured communities to index.
  void startCrawler();

  const shutdown = async () => {
    stopCrawler();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
