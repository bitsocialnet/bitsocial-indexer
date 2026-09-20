#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createJevClient } from "./client.mjs";
import {
  applyCandidateOrder,
  fingerprint,
  readRerankJson,
  rerankShortlist,
  RerankInputError,
  validateShortlist,
} from "./rerank.mjs";

export function rankingMetrics(ids, labels, k = Math.min(10, ids.length)) {
  if (
    !Array.isArray(labels) ||
    labels.length !== ids.length ||
    !Number.isInteger(k) ||
    k < 1 ||
    k > ids.length
  )
    throw new RerankInputError("Metrics require one label per candidate and a valid cutoff");
  const grades = new Map();
  for (const row of labels) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !Number.isInteger(row.grade) ||
      row.grade < 0 ||
      row.grade > 2 ||
      grades.has(row.id)
    )
      throw new RerankInputError("Relevance grades must be unique IDs with integers 0, 1, or 2");
    grades.set(row.id, row.grade);
  }
  applyCandidateOrder(labels, ids);
  const gain = (ordered) =>
    ordered
      .slice(0, k)
      .reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  const dcg = gain(ids.map((id) => grades.get(id)));
  const ideal = gain([...grades.values()].sort((a, b) => b - a));
  const firstDirect = ids.slice(0, k).findIndex((id) => grades.get(id) === 2);
  return {
    cutoff: k,
    ndcg: ideal ? dcg / ideal : null,
    reciprocalRank: firstDirect < 0 ? 0 : 1 / (firstDirect + 1),
    directRelevantCandidates: labels.filter((row) => row.grade === 2).length,
  };
}

export function validateRerankCorpus(input) {
  if (
    !input ||
    input.version !== 1 ||
    !["synthetic", "independently-reviewed"].includes(input.provenance) ||
    !Array.isArray(input.cases) ||
    !input.cases.length ||
    input.cases.length > 20
  )
    throw new RerankInputError("Evaluation needs 1 to 20 cases and explicit provenance");
  const ids = new Set();
  for (const entry of input.cases) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(entry.id) ||
      ids.has(entry.id)
    )
      throw new RerankInputError("Evaluation case IDs must be unique and bounded");
    ids.add(entry.id);
    validateShortlist(entry.shortlist);
    if (!entry.shortlist.candidates.length)
      throw new RerankInputError("Evaluation requires a nonempty shortlist");
    rankingMetrics(
      entry.shortlist.candidates.map((row) => row.id),
      entry.labels,
    );
    if (
      input.provenance === "independently-reviewed" &&
      (typeof entry.reviewer !== "string" || !entry.reviewer.trim())
    )
      throw new RerankInputError("Reviewed examples require human reviewer metadata");
  }
  return input;
}

export async function evaluateReranking(corpus, { client, model, live = false } = {}) {
  validateRerankCorpus(corpus);
  const results = [];
  for (const entry of corpus.cases) {
    const baselineOrder = entry.shortlist.candidates.map((candidate) => candidate.id);
    const report = await rerankShortlist(entry.shortlist, { enabled: true, live, client, model });
    results.push({
      id: entry.id,
      baseline: rankingMetrics(baselineOrder, entry.labels),
      returnedOrder: live ? rankingMetrics(report.order, entry.labels) : null,
      report,
    });
  }
  const mean = (values) => {
    const available = values.filter((value) => value !== null && value !== undefined);
    return available.length
      ? available.reduce((sum, value) => sum + value, 0) / available.length
      : null;
  };
  return {
    version: 1,
    live,
    model: model || null,
    corpusSha256: fingerprint(corpus),
    provenance: corpus.provenance,
    note: "Developer experiment; synthetic input order is not an actual FTS benchmark. Graded labels are never sent to Jev. MRR uses grade 2 as a direct match. NDCG excludes all-zero-label cases from its mean. Returned-order metrics include deterministic fallbacks. No population or threshold-quality claim.",
    summary: {
      cases: results.length,
      applied: results.filter((row) => row.report.applied).length,
      fallbacks: live ? results.filter((row) => !row.report.applied).length : 0,
      baselineNdcg: mean(results.map((row) => row.baseline.ndcg)),
      returnedNdcg: live ? mean(results.map((row) => row.returnedOrder.ndcg)) : null,
      baselineMrr: mean(results.map((row) => row.baseline.reciprocalRank)),
      returnedMrr: live ? mean(results.map((row) => row.returnedOrder.reciprocalRank)) : null,
    },
    results,
    usage: client?.stats?.() ?? null,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      corpus: {
        type: "string",
        default: fileURLToPath(new URL("./fixtures/rerank.json", import.meta.url)),
      },
      cases: { type: "string" },
      live: { type: "boolean", default: false },
      model: { type: "string" },
      "max-requests": { type: "string", default: "5" },
      "max-cost-usd": { type: "string", default: "0.005" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/jev/rerank-eval.mjs [--corpus reviewed-shortlists.json] [--cases query1,query2] [--live --max-requests 5 --max-cost-usd 0.005]\nOffline reports only labeled baseline metrics. Live evaluates each bounded shortlist in one request; labels are withheld.",
    );
    return 0;
  }
  const input = validateRerankCorpus(await readRerankJson(values.corpus));
  const selected =
    values.cases === undefined
      ? null
      : values.cases
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean);
  if (
    selected &&
    (!selected.length || selected.some((id) => !input.cases.some((row) => row.id === id)))
  )
    throw new RerankInputError("Every selected case must exist");
  const corpus = selected
    ? { ...input, cases: input.cases.filter((row) => selected.includes(row.id)) }
    : input;
  const maxRequests = Number(values["max-requests"]),
    maxCostUsd = Number(values["max-cost-usd"]);
  if (
    !Number.isInteger(maxRequests) ||
    maxRequests < 1 ||
    maxRequests > 20 ||
    !Number.isFinite(maxCostUsd) ||
    maxCostUsd <= 0 ||
    maxCostUsd > 0.01
  )
    throw new RerankInputError("Invalid evaluation budgets");
  const client = values.live
    ? createJevClient({ live: true, model: values.model, maxRequests, maxCostUsd })
    : undefined;
  const model = client ? client.assertReady().model : null;
  const report = await evaluateReranking(corpus, { client, model, live: values.live });
  console.log(JSON.stringify(report, null, 2));
  return !values.live || report.summary.fallbacks ? 2 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error(
        "Rerank evaluation could not run. Check the bounded corpus, labels and budgets; private input/provider contents are not printed.",
      );
      process.exitCode = 2;
    });
