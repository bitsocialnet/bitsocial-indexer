/**
 * Demo data. Run with `npm run seed`, or set SEED_DEMO=true to load on boot.
 *
 * This is NOT a 5chan/5archive dataset — it's neutral placeholder content so the
 * bundled UI has something to render. A real instance indexes live communities
 * via the crawler instead.
 */
import { fileURLToPath } from 'node:url';
import { insertComments, upsertCommunity, type CommentInput } from './index.js';

const now = Math.floor(Date.now() / 1000);
const ago = (h: number) => now - h * 3600;

interface Seed {
  community: string;
  title: string;
  author: string;
  content: string;
  link?: string;
  up: number;
  down: number;
  hours: number;
  replies: { author: string; content: string; up: number; hours: number }[];
}

const COMMUNITIES: Record<string, { title: string; description: string }> = {
  'technology.bso': { title: 'Technology', description: 'Computing, networks, and the decentralized web.' },
  'art.bso': { title: 'Art', description: 'Original work, critique, and process.' },
  'bitcoin.eth': { title: 'Bitcoin', description: 'Peer-to-peer electronic cash.' },
  'movies.bso': { title: 'Movies', description: 'Film discussion and recommendations.' },
};

const THREADS: Seed[] = [
  {
    community: 'technology.bso',
    title: 'Self-hosting a search index for a p2p network',
    author: 'satoshi.eth',
    content:
      'Been running an indexer that crawls a handful of communities into SQLite + FTS5. Search latency is sub-millisecond even at a few hundred thousand comments. Anyone else self-hosting discovery layers?',
    up: 142,
    down: 4,
    hours: 3,
    replies: [
      { author: 'lena.bso', content: 'FTS5 with the porter tokenizer is shockingly good for the size. What are you doing for ranking?', up: 21, hours: 2 },
      { author: 'mark', content: 'bm25 via the rank column. Works fine until you want personalization.', up: 9, hours: 1 },
    ],
  },
  {
    community: 'technology.bso',
    title: 'IPNS resolution is the slow part, not IPFS',
    author: 'devnull.bso',
    content: 'Profiled my crawler. 80% of wall-clock is waiting on IPNS records to resolve. Pinning helps but the first resolve is brutal.',
    up: 67,
    down: 1,
    hours: 9,
    replies: [{ author: 'satoshi.eth', content: 'Cache the last-known CID and resolve in the background. Stale-while-revalidate.', up: 14, hours: 8 }],
  },
  {
    community: 'art.bso',
    title: 'Ink study — 30 minutes, no undo',
    author: 'mori.bso',
    content: 'Trying to commit to lines. Posting the rough ones too so it is honest.',
    link: 'https://example.com/ink-study.png',
    up: 203,
    down: 2,
    hours: 6,
    replies: [
      { author: 'guest', content: 'The confidence in the lower-left strokes is great. Hands still fighting you a bit.', up: 31, hours: 5 },
      { author: 'lena.bso', content: 'Honesty in the rough ones is the whole point. Keep them.', up: 12, hours: 4 },
    ],
  },
  {
    community: 'bitcoin.eth',
    title: 'What actually happens to fees at the next halving?',
    author: 'anon',
    content: 'Block subsidy drops again. Curious whether fee pressure has matured enough to matter this cycle or if it is still subsidy-dominated.',
    up: 88,
    down: 17,
    hours: 14,
    replies: [{ author: 'devnull.bso', content: 'Look at fee/subsidy ratio over the last two cycles, the trend is clearly up but noisy.', up: 22, hours: 12 }],
  },
  {
    community: 'movies.bso',
    title: 'Underrated sci-fi from the last decade',
    author: 'reel.bso',
    content: 'Looking for something cerebral, not spectacle. Already seen Arrival and Annihilation.',
    up: 54,
    down: 0,
    hours: 22,
    replies: [
      { author: 'mori.bso', content: 'Coherence (2013). One location, tiny budget, ruins your evening in a good way.', up: 40, hours: 20 },
      { author: 'anon', content: 'Predestination if you can handle the loops.', up: 8, hours: 19 },
    ],
  },
];

export function seedDemo(): number {
  for (const [address, meta] of Object.entries(COMMUNITIES)) {
    upsertCommunity({ address, title: meta.title, description: meta.description, added_at: now, last_indexed_at: now });
  }

  let n = 0;
  THREADS.forEach((t, i) => {
    const opCid = `demo-op-${i}`;
    const op: CommentInput = {
      cid: opCid,
      community_address: t.community,
      post_cid: opCid,
      parent_cid: null,
      depth: 0,
      timestamp: ago(t.hours),
      author_address: `${t.author}`,
      author_name: t.author,
      title: t.title,
      content: t.content,
      link: t.link ?? null,
      thumbnail_url: null,
      upvote_count: t.up,
      downvote_count: t.down,
      reply_count: t.replies.length,
      raw: null,
    };
    const replies: CommentInput[] = t.replies.map((r, j) => ({
      cid: `demo-reply-${i}-${j}`,
      community_address: t.community,
      post_cid: opCid,
      parent_cid: opCid,
      depth: 1,
      timestamp: ago(r.hours),
      author_address: r.author,
      author_name: r.author,
      title: null,
      content: r.content,
      link: null,
      thumbnail_url: null,
      upvote_count: r.up,
      downvote_count: 0,
      reply_count: 0,
      raw: null,
    }));
    n += insertComments([op, ...replies]);
  });
  return n;
}

// Run directly: `tsx src/db/seed.ts`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const inserted = seedDemo();
  console.log(`Seeded ${inserted} demo comments across ${Object.keys(COMMUNITIES).length} communities.`);
}
