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

All config is environment variables (see [`server/.env.example`](server/.env.example)).

### `server/`

| Var | Default | Meaning |
|-----|---------|---------|
| `COMMUNITIES` | _(empty)_ | Comma-separated community addresses to index, e.g. `art.bso,tech.bso` |
| `COMMUNITIES_SOURCE` | _(empty)_ | URL/path to a JSON list of community addresses (e.g. a client's directory). Overrides/augments `COMMUNITIES`. |
| `PKC_RPC_URL` | `ws://localhost:9138` | The `bitsocial-cli` daemon RPC endpoint |
| `DB_PATH` | `./data/indexer.db` | SQLite file (`:memory:` for ephemeral) |
| `CRAWL_INTERVAL_MS` | `60000` | Per-community delay before the next refresh |
| `CRAWL_CONCURRENCY` | `4` | Maximum communities crawled at once |
| `CRAWL_TIMEOUT_MS` | `300000` | Hard timeout for one community crawl; a timeout resets the RPC client |
| `ALLOWED_ORIGINS` | `*` | CORS allow-list, comma-separated (`*` = any origin — fine for a public read-only API). An entry may contain `*` as a wildcard, e.g. `https://*.seedit.localhost` matches every branch-scoped dev origin. `CORS_ORIGIN` is accepted as a legacy fallback. |
| `BLOCKLIST_SOURCE` | _(empty)_ | Path to a JSON file of CIDs to take down (operator blocklist, see below). |
| `NSFW_OVERRIDES_SOURCE` | _(empty)_ | Path to a JSON file of operator NSFW verdicts per community (see below). |

If neither `COMMUNITIES` nor `COMMUNITIES_SOURCE` is set, the crawler stays
idle and the indexer serves nothing. That is intentional.

#### Takedowns (`BLOCKLIST_SOURCE`)

An archive keeps serving content after it disappears from the source network,
so upstream moderation can no longer reach it — takedown requests (DMCA,
illegal content) need an operator-side mechanism. Point `BLOCKLIST_SOURCE` at
a JSON file where each entry is a bare CID string or
`{ "cid": "…", "scope": "comment" | "thread", "reason": "…" }` (`scope`
defaults to `comment`; `thread` takes down a post **and all its replies** by
the post's CID). Add a CID to the file and it is redacted within a minute —
the file is re-read whenever it changes, no restart needed; remove the entry
and the stored content is served again (the redaction never destroys the
archived data). Blocklisted comments leave listings and search but stay in
threads as redacted tombstones, marked `takedown: 1` (plus the optional
`takedown_reason`) on the API so UIs can distinguish them from upstream
moderation, and they stay redacted across re-crawls. The bundled web UI shows
them as `[removed — takedown request]` and documents the policy on its
`/legal` page (see `CONTACT_EMAIL` below).

#### NSFW communities (`NSFW_OVERRIDES_SOURCE`)

The protocol has `comment.nsfw` on individual posts but no
`community.features.nsfw`, so a client cannot ask the network whether a whole
community is NSFW — the indexer is the place that knows. Each indexed community
gets an `nsfw` flag on `GET /api/communities` (and `/api/communities/:address`),
resolved from three signals, **highest precedence first**:

1. **Operator override** — `NSFW_OVERRIDES_SOURCE`, a JSON file where each entry
   is a bare address or `{ "address": "…", "nsfw": false, "reason": "…" }`.
   `nsfw` defaults to `true`, and an explicit `false` clears the flag, so a bad
   inference is correctable. Like the blocklist, the file is re-read whenever it
   changes — no restart needed.
2. **The configured community list** — an entry in `COMMUNITIES_SOURCE` may
   carry its own `nsfw` boolean (the field Bitsocial directory lists already
   define). It is read once, when the crawler schedules the list.
3. **Inference from content** — any indexed comment in the community carrying
   the protocol's `nsfw` flag means the community accepts NSFW content.

`GET /api/search?nsfw=` filters on the result: `false` (**the default**) drops
anything NSFW — the comment is flagged, or its community is — and `true`
includes it. Listings (`/api/posts`) and the sitemap are not filtered.

### `webui/`

| Var | Default | Meaning |
|-----|---------|---------|
| `INDEXER_API` | `http://localhost:4000` | Where the UI reads the API from (server-side fetch) |
| `SITE_NAME` | `Bitsocial` | Instance name in the header / page titles |
| `SITE_BADGE` | `Indexer` | Small pill next to the name (empty to hide) |
| `SITE_URL` | `http://localhost:3000` | Public origin of the web UI — canonical URLs, OpenGraph tags, `robots.txt`, sitemaps |
| `THEME` | `default` | UI skin: `default` (Bitsocial dark) or `5chan` (classic imageboard look) |
| `BRAND_TEXT` | _(empty)_ | Optional footer attribution line, e.g. `A Bitsocial Forge product`. Unset = nothing rendered |
| `BRAND_URL` | _(empty)_ | Makes `BRAND_TEXT` a link |
| `CONTACT_EMAIL` | _(empty)_ | Contact address for content-removal / takedown requests, shown on the `/legal` archive-policy page. Unset = the page says requests are handled by the instance operator |

The web UI serves its own `robots.txt` and a `sitemap.xml` **sitemap index**
(one child sitemap per community, capped at the 5,000 most recent posts each,
enumerated through the paginated `/api/posts` listing and cached for an hour).

## API

CORS-enabled so browser clients can call it directly.

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Status + index counts |
| `GET /api/communities` | Indexed communities + post counts + `nsfw` flag |
| `GET /api/posts` | Browse posts — `?community=&sort=new\|top\|replies\|old&time=hour..all&page=&limit=&replies=true` |
| `GET /api/posts/:cid` | A thread: original post + threaded replies |
| `GET /api/search` | Full-text search — `?q=&community=&sort=&time=&page=&nsfw=` (NSFW excluded by default) |
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
