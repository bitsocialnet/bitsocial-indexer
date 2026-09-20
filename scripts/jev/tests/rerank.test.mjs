import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JevError } from "../client.mjs";
import {
  applyCandidateOrder,
  fingerprint,
  readRerankJson,
  rerankShortlist,
  validateShortlist,
} from "../rerank.mjs";
import { evaluateReranking, rankingMetrics, validateRerankCorpus } from "../rerank-eval.mjs";

const shortlist = () => ({
  version: 1,
  query: "hide post locally",
  sort: "relevance",
  retrieval: "fts5",
  scope: {
    page: 2,
    limit: 2,
    total: 10,
    filters: {
      nsfw: false,
      includeReplies: false,
      time: "week",
      author: "author-filter",
      community: "community-filter",
      site: "site-filter",
      url: "url-filter",
      selftext: "body-filter",
      self: "yes",
    },
    visibilityApplied: true,
    blocklistApplied: true,
  },
  candidates: [
    { id: "a", title: "Global deletion", snippet: "Removes the post for everyone." },
    { id: "b", title: "Local hiding", snippet: "Hide on this device only." },
  ],
});
const answer = (choice) => ({
  choice,
  confidence: 0.98,
  probabilities: Object.fromEntries(
    ["direct", "related", "unrelated", "uncertain"].map((grade) => [
      grade,
      grade === choice ? 0.97 : 0.01,
    ]),
  ),
});
const response = (...choices) => ({
  model: "jev-1.13.0",
  answers: Object.fromEntries(
    choices.map((choice, index) => [`candidate_${index}`, answer(choice)]),
  ),
});
const options = (ask) => ({ enabled: true, live: true, model: "jev-1.13.0", client: { ask } });

test("one batched request submits only query and candidate text, preserves all IDs/filter/page metadata", async () => {
  const input = shortlist();
  const before = JSON.stringify(input);
  let calls = 0;
  const result = await rerankShortlist(
    input,
    options(async ({ state, questions }) => {
      calls++;
      assert.deepEqual(Object.keys(state).sort(), ["candidates", "query"]);
      assert.deepEqual(state.candidates.map(Object.keys), [
        ["title", "snippet"],
        ["title", "snippet"],
      ]);
      assert.ok(!JSON.stringify(state).includes("author-filter"));
      assert.equal(Object.keys(questions).length, 2);
      assert.match(questions.candidate_1.instructions, /state\.candidates\[1\]/);
      return response("unrelated", "direct");
    }),
  );
  assert.equal(calls, 1);
  assert.deepEqual(result.order, ["b", "a"]);
  assert.deepEqual(result.baselineOrder, ["a", "b"]);
  assert.equal(result.scopeSha256, fingerprint(input.scope));
  assert.deepEqual([result.page, result.limit, result.total], [2, 2, 10]);
  assert.equal(JSON.stringify(input), before);
  assert.strictEqual(applyCandidateOrder(input.candidates, result.order)[0], input.candidates[1]);
  assert.ok(!JSON.stringify(result).includes("Removes the post"));
});

test("non-relevance sorts, no opt-in, offline, and short pages never invoke inference", async () => {
  const ask = async () => {
    throw new Error("must not call");
  };
  for (const sort of ["new", "old", "top", "replies"]) {
    const input = { ...shortlist(), sort };
    const result = await rerankShortlist(input, options(ask));
    assert.equal(result.reason, "explicit_sort_preserved");
    assert.deepEqual(result.order, ["a", "b"]);
  }
  assert.equal(
    (await rerankShortlist(shortlist(), { ...options(ask), enabled: false })).reason,
    "not_enabled",
  );
  assert.equal(
    (await rerankShortlist(shortlist(), { ...options(ask), live: false })).reason,
    "live_disabled",
  );
  assert.equal(
    (await rerankShortlist({ ...shortlist(), candidates: [] }, options(ask))).reason,
    "shortlist_too_small",
  );
});

test("any failure, exhausted budget, malformed or ambiguous answer preserves the entire original order", async () => {
  const malformed = response("unrelated", "direct");
  malformed.answers.candidate_0.probabilities.direct = 5;
  const nearTie = response("unrelated", "direct");
  nearTie.answers.candidate_0.probabilities = {
    direct: 0.48,
    unrelated: 0.49,
    related: 0.02,
    uncertain: 0.01,
  };
  const cases = [
    response("uncertain", "direct"),
    { model: "wrong", answers: {} },
    response("direct"),
    {
      ...response("direct", "related"),
      answers: { unknown_id: answer("direct"), candidate_1: answer("related") },
    },
    malformed,
    nearTie,
  ];
  for (const value of cases) {
    const result = await rerankShortlist(
      shortlist(),
      options(async () => value),
    );
    assert.deepEqual(result.order, ["a", "b"]);
    assert.equal(result.applied, false);
  }
  for (const error of [
    new JevError("request_budget_exceeded"),
    new Error("PRIVATE PROVIDER BODY"),
  ]) {
    const result = await rerankShortlist(
      shortlist(),
      options(async () => {
        throw error;
      }),
    );
    assert.deepEqual(result.order, ["a", "b"]);
    assert.equal(result.applied, false);
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  }
});

test("ties preserve original order and applying an invalid permutation cannot add/drop/duplicate candidates", async () => {
  const input = shortlist();
  const result = await rerankShortlist(
    input,
    options(async () => response("direct", "direct")),
  );
  assert.deepEqual(result.order, ["a", "b"]);
  for (const ids of [["a"], ["a", "a"], ["a", "new"], ["a", "b", "new"]])
    assert.throws(() => applyCandidateOrder(input.candidates, ids), /exactly once/);
  const many = Array.from({ length: 20 }, (_, index) => ({ id: `id-${index}` }));
  assert.deepEqual(
    applyCandidateOrder(many, many.map((row) => row.id).reverse()),
    [...many].reverse(),
  );
});

test("malformed scopes, duplicate IDs, excessive candidates and embedded label fields fail before inference", () => {
  for (const mutate of [
    (input) => {
      input.scope.blocklistApplied = false;
    },
    (input) => {
      delete input.scope.filters.nsfw;
    },
    (input) => {
      input.scope.filters.time = "unknown";
    },
    (input) => {
      input.scope.page = 0;
    },
    (input) => {
      input.scope.limit = 1;
    },
    (input) => {
      input.retrieval = "cid-lookup";
    },
    (input) => {
      input.candidates[1].id = "a";
    },
    (input) => {
      input.candidates[1].grade = 2;
    },
    (input) => {
      input.candidates[1].snippet = "a".repeat(2001);
    },
    (input) => {
      input.candidates = Array.from({ length: 21 }, (_, index) => ({
        id: `${index}`,
        title: "Title",
        snippet: "Snippet",
      }));
      input.scope.limit = 25;
      input.scope.total = 25;
    },
  ]) {
    const input = shortlist();
    mutate(input);
    assert.throws(() => validateShortlist(input));
  }
});

test("NDCG uses graded discounted gains and MRR counts only direct matches; all-zero labels stay explicit", () => {
  const labels = [
    { id: "partial", grade: 1 },
    { id: "direct", grade: 2 },
    { id: "no", grade: 0 },
  ];
  const baseline = rankingMetrics(["partial", "direct", "no"], labels);
  assert.equal(baseline.reciprocalRank, 0.5);
  assert.ok(Math.abs(baseline.ndcg - (1 + 3 / Math.log2(3)) / (3 + 1 / Math.log2(3))) < 1e-12);
  assert.equal(rankingMetrics(["direct", "partial", "no"], labels).ndcg, 1);
  assert.equal(rankingMetrics(["partial", "direct", "no"], labels, 1).reciprocalRank, 0);
  assert.deepEqual(rankingMetrics(["x"], [{ id: "x", grade: 0 }]), {
    cutoff: 1,
    ndcg: null,
    reciprocalRank: 0,
    directRelevantCandidates: 0,
  });
  for (const wrong of [
    [{ id: "partial", grade: 1 }],
    [
      { id: "partial", grade: 1 },
      { id: "direct", grade: 3 },
      { id: "no", grade: 0 },
    ],
    [
      { id: "partial", grade: 1 },
      { id: "partial", grade: 2 },
      { id: "no", grade: 0 },
    ],
  ])
    assert.throws(() => rankingMetrics(["partial", "direct", "no"], wrong));
});

test("evaluation separates offline baseline from live returned order, with labels withheld and fallbacks included", async () => {
  const corpus = {
    version: 1,
    provenance: "synthetic",
    cases: [
      {
        id: "fixture",
        shortlist: shortlist(),
        labels: [
          { id: "a", grade: 0 },
          { id: "b", grade: 2 },
        ],
      },
    ],
  };
  const offline = await evaluateReranking(corpus);
  assert.equal(offline.summary.returnedNdcg, null);
  assert.equal(offline.summary.baselineMrr, 0.5);
  const client = {
    ask: async (payload) => {
      assert.ok(!JSON.stringify(payload).includes("grade"));
      assert.ok(!JSON.stringify(payload).includes("labels"));
      return response("unrelated", "direct");
    },
  };
  const live = await evaluateReranking(corpus, { live: true, client, model: "jev-1.13.0" });
  assert.equal(live.summary.returnedNdcg, 1);
  assert.equal(live.summary.returnedMrr, 1);
  const fallback = await evaluateReranking(corpus, {
    live: true,
    client: {
      ask: async () => {
        throw new Error();
      },
    },
    model: "jev-1.13.0",
  });
  assert.equal(fallback.summary.fallbacks, 1);
  assert.equal(fallback.summary.returnedMrr, 0.5);
  assert.throws(
    () => validateRerankCorpus({ ...corpus, provenance: "independently-reviewed" }),
    /reviewer/,
  );
});

test("CLI --live without --rerank keeps offline original order even with an invalid private config", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-rerank-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "shortlist.json");
  await fs.writeFile(file, JSON.stringify(shortlist()));
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../rerank.mjs", import.meta.url)), "--input", file, "--live"],
    {
      encoding: "utf8",
      env: { ...process.env, JEV_CONFIG_FILE: "/absent-configuration-fixture" },
    },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).reason, "not_enabled");
  await fs.writeFile(file, "a".repeat(512 * 1024 + 1));
  await assert.rejects(() => readRerankJson(file), /512 KiB/);
});

test("shipped fixtures are valid synthetic corpora and do not claim measured retrieval performance", async () => {
  const corpus = validateRerankCorpus(
    JSON.parse(await fs.readFile(new URL("../fixtures/rerank.json", import.meta.url), "utf8")),
  );
  assert.equal(corpus.provenance, "synthetic");
  assert.match(corpus.description, /not independently human-reviewed/);
  assert.equal(corpus.cases.length, 3);
});

test("a file that grows after stat remains bounded and is rejected", async () => {
  const originalOpen = fs.open;
  let closed = false;
  fs.open = async () => ({
    stat: async () => ({ isFile: () => true, size: 2 }),
    // Model a file changed to >512 KiB between stat and its first read.
    read: async (buffer, offset, length) => {
      buffer.fill(32, offset, offset + length);
      return { bytesRead: length };
    },
    close: async () => {
      closed = true;
    },
  });
  try {
    await assert.rejects(() => readRerankJson("growth-fixture"), /grew beyond/);
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(closed, true);
});
