# Optional Jev search reranking experiment

This developer CLI evaluates an explicitly exported, already filtered search shortlist. It is **not connected to the search route or archive UI** and makes no claim about production search quality. The indexer remains the search engine used by all archive frontends. No second search server, index, cache, or provider dependency is added.

## Preserve existing search behavior

The current indexer `/api/search` filters visibility/blocklist state, NSFW, replies, community, time, and advanced author/site/URL/selftext/self constraints before returning a page. Its FTS5 path orders by `rank` when the API `sort` is omitted. The API's explicit sorts are `new`, `old`, `top`, and `replies`; **`relevance` below is this experiment's label for the omitted-sort FTS path, not a new API parameter**. CID lookups and filter-only searches are outside this experiment.

Export at most 20 rows from **one original returned page**, retaining its query, filters, pagination and stable CID identifiers. The CLI never fetches more candidates, links or pages, changes filters, or includes candidates from elsewhere. Reranking is only allowed with explicit `--rerank --live` and `sort: "relevance"`. Other sorts retain their original order without loading credentials or calling Jev. The output preserves each supplied ID exactly once. This is page-local reordering; it cannot find relevant results that retrieval omitted or move candidates across pages.

A supplied JSON file cannot prove that its author applied server filters: `visibilityApplied` and `blocklistApplied` are explicit export attestations, not a replacement for server enforcement. Never construct this shortlist from unfiltered database rows or combine incompatible pages/queries. The server remains responsible for actual policy enforcement. Supply only text approved for TypeSafe; the model receives the query, title and snippet, never IDs, labels, author filters or other scope metadata.

```json
{
  "version": 1,
  "query": "hide post locally",
  "sort": "relevance",
  "retrieval": "fts5",
  "scope": {
    "page": 1,
    "limit": 20,
    "total": 120,
    "visibilityApplied": true,
    "blocklistApplied": true,
    "filters": { "nsfw": false, "includeReplies": true, "time": "all" }
  },
  "candidates": [
    {
      "id": "original-cid-1",
      "title": "Local hiding",
      "snippet": "Hide this post on your device only."
    },
    {
      "id": "original-cid-2",
      "title": "Delete a post",
      "snippet": "Remove the post from the community for everyone."
    }
  ]
}
```

Copy optional `community`, `author`, `site`, `url`, `selftext`, and `self` filters into `scope.filters` exactly when supplied originally. The shortlist is strict: candidate fields are only `id`, `title`, and `snippet`, with no model labels. Limits are 500 query characters, 500 title characters, 2,000 snippet characters, and 512 KiB input. Oversized input is rejected rather than silently truncated. Record the exact excerpts chosen; they determine the result.

```sh
# Baseline/shape check; zero network calls and no credential reads.
node scripts/jev/rerank.mjs --input /path/to/filtered-shortlist.json

# Explicit live experiment; one batched request for all <=20 candidates.
node scripts/jev/rerank.mjs --input /path/to/filtered-shortlist.json \
  --rerank --live --max-requests 1 --max-cost-usd 0.002

node --test scripts/jev/tests/rerank.test.mjs
```

Live commands reuse the private machine configuration in [shared setup](README.md); no per-repo key or `.env` is needed. The fixed official endpoint, pinned model, and existing input/request/cost/time limits apply. Inputs that exceed the shared client's conservative token budget also retain the baseline order. Estimated cost is separate from provider usage and is not a billing guarantee.

One Choice judgment per candidate is batched into the request, with the relevant candidate index explicitly in the question. Choices are direct, related, unrelated and uncertain. The descriptive score is `2 × P(direct) + P(related)`. It is a ranking heuristic, not a probability the result is correct. Equal scores retain their original relative order. Any uncertain answer, malformed output, weak/ambiguous choice (top probability below 0.7 or margin below 0.1), model mismatch, timeout, budget exhaustion or provider/configuration failure preserves the **entire original page order**. The experimental confidence thresholds have not been calibrated on real search traffic. No partial ranking or retry is applied.

The JSON output contains ordered stable IDs, scores when applied, bounded choice/probability diagnostics (including non-applied scores and eligibility on fallback), model/rubric identity, scope/input hashes, unchanged pagination, elapsed time, and usage. It omits query/snippet text and raw filter values. `applyCandidateOrder` can map the output permutation back to the exact original objects; it rejects additions, drops, and duplicates. No application calls this helper. Exit `0` means a complete rerank was returned; exit `2` means baseline/fallback/invalid input, never a claimed semantic success.

## Evaluate before considering product integration

```sh
# Shows only baseline labeled metrics; no Jev result is claimed.
node scripts/jev/rerank-eval.mjs

# Fresh bounded synthetic evaluation, no cache or label leakage.
node scripts/jev/rerank-eval.mjs --live --max-requests 3 --max-cost-usd 0.005

# An independently reviewed, approved export corpus using the same schema.
node scripts/jev/rerank-eval.mjs --corpus /path/to/reviewed-search-cases.json \
  --cases selected-query-id --live --max-requests 1
```

Evaluation envelope: `{ "version": 1, "provenance": "synthetic" | "independently-reviewed", "cases": [...] }`. Each case has a bounded `id`, `shortlist` as above, and `labels: [{ "id": "original-cid", "grade": 0 | 1 | 2 }]` for **every** candidate. Grade 0 means irrelevant, 1 partially related, and 2 directly relevant. Independently-reviewed cases also require a human `reviewer` identifier; metadata is an assertion, not authentication of a real review.

NDCG uses graded gain `2^grade − 1` discounted by `log2(position + 1)`. MRR uses the first grade-2 direct match. Both use cutoff `min(10, shortlist length)`. Missing/duplicate/unknown labels or invalid grades fail the evaluation. A query with no relevant labels has null NDCG (excluded from the mean) and zero reciprocal rank. Live returned-order metrics include fallback pages, so provider failures cannot disappear from comparison. Reports include applied/fallback counts, elapsed time and actual token usage; ordinary search is not timed by this CLI. Per-case `usage` snapshots are labeled `client-cumulative`; use the single top-level `usage` total instead of summing these snapshots.

The three shipped fixtures are **model-authored synthetic examples with deliberately weak initial order**, not real FTS output, independently reviewed relevance labels, or evidence of a production improvement. Use representative approved FTS exports and independently reviewed labels, then compare quality, latency and cost against the same original pages. Do not tune and judge on the same fixture set. Keep ordinary search and its filters unchanged until that evidence supports a separate product integration.

## Compare a Score and Noul variant

Choice remains the default. `--primitive score` explicitly selects a second experiment:
one [Score](https://docs.typesafe.ai/primitives/score) per candidate with three described
relevance levels, plus one [Noul](https://docs.typesafe.ai/primitives/noul) asking whether
the query and excerpt supply enough evidence to judge relevance. An unrelated excerpt
can still have sufficient evidence. All questions are batched in one request.

The Score is a probability-weighted position from 0 (unrelated) to 2 (directly relevant).
Its confidence/distribution remain visible; uncertainty between adjacent relevance
levels is not treated as missing evidence. The Noul must be at least 0.9 for **every**
candidate or the whole original order is retained. This is an explicit, uncalibrated
pilot rule, not a transferred Choice threshold or a guarantee of correctness. Score
answers must have the exact level keys/legend, normalized finite probabilities and
a consistent weighted value. Observed responses need a separate half-cent rounding
allowance for each two-decimal probability and the Score. The client checks that
some underlying distribution summing to one could produce those values; it never
renormalizes them. Higher-precision values remain exact. This is compatibility with
observed serialization, not an official precision guarantee.

This variant accepts at most **10 candidates**, preserving the existing 20-question
request bound. A larger page falls back unchanged before loading credentials. It
never takes just the first ten and silently drops the rest. Keep ordinary filters,
pagination, scope and candidate IDs exactly as in the Choice experiment.

```sh
node scripts/jev/rerank.mjs --input /path/to/filtered-shortlist.json \
  --primitive score --rerank --live --max-requests 1 --max-cost-usd 0.002

# Offline paired report; neither variant calls Jev.
node scripts/jev/rerank-eval.mjs --compare

# Three shipped synthetic cases, two calls each, no retries or cached answers.
node scripts/jev/rerank-eval.mjs --compare --live \
  --max-requests 6 --max-cost-usd 0.005
```

The paired evaluator uses identical pages/labels and alternates which variant runs
first per case. It includes failed/fallback runs in each variant's returned NDCG/MRR,
counts reasons, and reports median helper latency. This compares two complete
judgment designs, not an isolated primitive change: the Score variant adds the
evidence question and uses a different eligibility rule. Do not attribute any
difference solely to Score. Per-case usage is client-cumulative; the top-level usage
is the total across both variants. Exit 2 preserves any fallback or offline result.
Comparison defaults to enough request slots for both variants on every selected
case. An explicitly smaller request budget is rejected before loading credentials;
the spend and elapsed-time caps remain independent and may still cause reported fallbacks.

Use a separately human-reviewed corpus before drawing conclusions. Synthetic
mechanics results are not search-quality evidence; no variant is installed into
the search endpoint. The [TypeSafe reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe)
motivates the retrieve-then-rank pattern, and its [workflow evals](https://evals.typesafe.ai/)
are design examples rather than independent labels for our queries.
