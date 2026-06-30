# bitsocial-indexer

A neutral, self-hostable **crawler + search/index API + web UI** for the
[Bitsocial](https://bitsocial.net) network.

It connects to a [`bitsocial-cli`](https://github.com/bitsocialnet/bitsocial-cli)
daemon over PKC RPC, indexes the communities **you** configure into a local
SQLite database, and exposes them through a REST + full-text-search API and an
optional server-rendered web UI.

> **It ships empty.** Out of the box the indexer knows about **zero**
> communities and shows nothing — the operator decides what to index. Point it
> at a list of communities and it becomes a search engine / archive for exactly
> those.

This is the engine. A concrete deployment — choosing which communities to
index, re-skinning the UI, adding ads or analytics — is layered on top as a
separate project (see [Running your own instance](#running-your-own-instance)).

---

## Architecture

```
   Bitsocial network  (IPFS / IPNS / pubsub)
            │
   bitsocial-cli daemon  (PKC RPC, ws://localhost:9138)
            │  @pkcprotocol/pkc-js
 ┌──────────┴───────────────────────────────────┐
 │  server/   — crawler + API (one Node service) │
 │    crawler ──▶ SQLite + FTS5 ──▶ Fastify API  │
 └──────────┬───────────────────────────────────┘
            │  REST + search (the integration seam)
   ┌────────┴────────┐
   │                 │
 webui/        any external client
 (Next.js,     (e.g. a Bitsocial app's
  bitsocial.net  in-app /search board just
  skin)          calls the API)
```

The **API is the product surface.** The bundled `webui` is one consumer; a
Bitsocial client adding in-app search is another — it just calls the same
endpoints, no shared frontend code.

| Part | Stack |
|------|-------|
| `server/` | Node 22, TypeScript (ESM), [Fastify](https://fastify.dev) 5, [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + FTS5, [`@pkcprotocol/pkc-js`](https://github.com/pkcprotocol/pkc-js) |
| `webui/`  | Next.js 15 (App Router, SSR for SEO), React 19, Bitsocial brand tokens |

## Quickstart

```bash
# 1. API server  (http://localhost:4000)
cd server
npm install
npm run seed     # optional: load demo communities + posts so the UI isn't empty
npm run dev

# 2. Web UI  (http://localhost:3000)  — in another terminal
cd webui
npm install
npm run dev
```

Without `npm run seed`, the server starts with **no communities** and the UI
shows its empty / onboarding state — which is the real default. Configure
communities (below) to index live content.

## Configuration

All config is environment variables (see [`.env.example`](.env.example)). The
two that matter most:

| Var | Default | Meaning |
|-----|---------|---------|
| `COMMUNITIES` | _(empty)_ | Comma-separated community addresses to index, e.g. `art.bso,tech.bso` |
| `COMMUNITIES_SOURCE` | _(empty)_ | URL/path to a JSON list of community addresses (e.g. a client's directory). Overrides/augments `COMMUNITIES`. |
| `PKC_RPC_URL` | `ws://localhost:9138` | The `bitsocial-cli` daemon RPC endpoint |
| `DB_PATH` | `./data/indexer.db` | SQLite file (`:memory:` for ephemeral) |

If neither `COMMUNITIES` nor `COMMUNITIES_SOURCE` is set, the crawler stays
idle and the indexer serves nothing. That is intentional.

## API

CORS-enabled so browser clients can call it directly.

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Status + index counts |
| `GET /api/communities` | Indexed communities + post counts |
| `GET /api/posts` | Browse posts — `?community=&sort=new\|top\|replies\|old&time=hour..all&page=&limit=&replies=true` |
| `GET /api/posts/:cid` | A thread: original post + threaded replies |
| `GET /api/search` | Full-text search — `?q=&community=&sort=&time=&page=` |
| `GET /sitemap.xml`, `/robots.txt` | SEO |

## Running your own instance

`bitsocial-indexer` is a **tool, not a hosted service** — there is no central
instance. To run one:

1. Deploy this engine (Docker, a VPS, etc.).
2. Set `COMMUNITIES` / `COMMUNITIES_SOURCE` to the communities you want.
3. Optionally re-skin `webui` (override the theme tokens in
   [`webui/app/globals.css`](webui/app/globals.css)) and add your own branding,
   ads, or analytics in your own deployment repo.

Because this engine is **GPL-3.0-or-later** (copyleft on *distribution*, not on
running a network service), you can run a modified, private, monetised instance
without publishing your changes — the same way Etherscan is a closed service
built on open Ethereum.

## License

[GPL-3.0-or-later](LICENSE). Brand assets belong to Bitsocial Forge.
