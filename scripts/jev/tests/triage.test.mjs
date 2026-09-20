import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { prepareGroups, triage, triageQuestions } from "../triage.mjs";
import { createJevClient, JevError } from "../client.mjs";

const event = {
  id: "sample",
  source: "indexer",
  message: "Required RPC connection refused; indexing remains stopped.",
  expected: { severity: "error", action: "inspect_dependency" },
};
const input = { version: 1, provenance: "synthetic", sanitized: true, events: [event] };
const answer = (question, choice, p = 1) => ({
  type: "choice",
  choice,
  confidence: p,
  probabilities: Object.fromEntries(
    Object.keys(question.criteria).map((key) => [
      key,
      key === choice ? p : (1 - p) / (Object.keys(question.criteria).length - 1),
    ]),
  ),
});
const clientFor = (severity = "error", action = "inspect_dependency", p = 1) => {
  let requests = 0;
  return {
    ask: async () => {
      requests++;
      return {
        model: "jev-1.13.0",
        answers: {
          severity: answer(triageQuestions.severity, severity, p),
          action: answer(triageQuestions.action, action, p),
        },
        latencyMs: 5,
      };
    },
    stats: () => ({ requests, estimatedCostUsd: null }),
  };
};

test("committed corpus is explicitly synthetic and offline never calls the client", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../fixtures/triage.json", import.meta.url), "utf8"),
  );
  const report = await triage({
    input: fixture,
    client: {
      ask: () => assert.fail("offline request"),
      stats: () => assert.fail("offline stats"),
    },
  });
  assert.equal(report.mode, "offline");
  assert.equal(report.provenance, "synthetic");
  assert.equal(report.usage.requests, 0);
  assert.equal(report.metrics.unverifiedGroups, report.uniqueGroups);
  assert.equal(report.uniqueGroups, 10);
  assert.deepEqual(report.models, []);
  assert.equal(report.rows[0].model, null);
  assert.match(report.rubricSha256, /^[a-f0-9]{64}$/);
});

test("offline CLI ignores unavailable private config and does not output selected message text", () => {
  const run = spawnSync(
    process.execPath,
    [
      new URL("../triage.mjs", import.meta.url).pathname,
      "--input",
      new URL("../fixtures/triage.json", import.meta.url).pathname,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        JEV_CONFIG_FILE: "/nonexistent/jev-fixture-only.json",
        TYPESAFE_API_KEY: "",
        JEV_MODEL: "",
      },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.usage.requests, 0);
  assert.equal(result.rows[0].status, "unverified");
  assert.ok(!run.stdout.includes("connection refused"));
});

test("exact repeats group once with occurrence counts; different source/text stay separate", async () => {
  const selected = {
    ...input,
    events: [
      { ...event, count: 3 },
      {
        ...event,
        id: "repeat",
        count: 4,
        expected: { action: "inspect_dependency", severity: "error" },
      },
      { ...event, id: "other-source", source: "moderation" },
      {
        ...event,
        id: "other-message",
        message: "Required RPC connection reset; indexing remains stopped.",
      },
    ],
  };
  const client = clientFor();
  const report = await triage({ input: selected, live: true, client });
  assert.equal(report.uniqueGroups, 3);
  assert.equal(report.usage.requests, 3);
  assert.equal(report.rows[0].occurrences, 7);
  assert.equal(report.rows[0].selectedEvents, 2);
  assert.equal(report.metrics.labeledGroups, 3);
  assert.equal(report.metrics.correct, 3);
  assert.deepEqual(report.models, ["jev-1.13.0"]);
  assert.equal(report.rows[0].model, "jev-1.13.0");
  assert.ok(!JSON.stringify(report).includes(event.message));
});

test("rejects raw fields, unlabeled real data with manufactured expectations, conflicting labels, and bounds", () => {
  for (const invalid of [
    { ...input, sanitized: false },
    { ...input, rawLogs: "private" },
    { ...input, provenance: "real" },
    { ...input, provenance: "sanitized-unlabeled" },
    { ...input, events: [] },
    { ...input, events: [{ ...event, count: 0 }] },
    { ...input, events: [{ ...event, count: 1_000_001 }] },
    { ...input, events: [{ ...event, rawError: "private" }] },
    { ...input, events: [{ ...event, message: "a".repeat(1201) }] },
    { ...input, events: [event, event] },
    {
      ...input,
      events: [
        event,
        { ...event, id: "conflict", expected: { severity: "critical", action: "security_review" } },
      ],
    },
    {
      ...input,
      events: Array.from({ length: 21 }, (_, i) => ({
        ...event,
        id: `case-${i}`,
        message: `Failure ${i}`,
      })),
    },
  ])
    assert.throws(() => prepareGroups({ input: invalid }), /invalid_or_sensitive/);
});

test("rejects common secrets and private identifiers before any live request", async () => {
  const snippets = [
    "Authorization: Bearer fake-test-token",
    "api_key=fake-test-secret",
    "Cookie: session=fake-value",
    "password: fake-test-value",
    "https://endpoint.invalid/private?key=fake",
    "user@example.invalid",
    "10.20.30.40",
    "[2001:db8::1]",
    "/root/private/settings.json",
    "sk-fake-test-token",
    "ghp_fake_test_token",
    "-----BEGIN PRIVATE KEY-----",
    "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.signature",
    "A".repeat(40),
  ];
  for (const message of snippets)
    await assert.rejects(
      triage({
        input: { ...input, events: [{ ...event, message }] },
        live: true,
        client: { ask: () => assert.fail("private text sent") },
      }),
      /invalid_or_sensitive/,
    );
});

test("uncertainty, contradictions, provider errors, and budgets remain unverified, never correct", async () => {
  for (const client of [
    clientFor("uncertain", "uncertain"),
    clientFor("error", "inspect_dependency", 0.65),
    clientFor("critical", "observe"),
    {
      ask: async () => {
        throw new JevError("budget_exhausted");
      },
      stats: () => ({ requests: 0 }),
    },
    {
      ask: async () => {
        throw new Error("PRIVATE_ERROR and Authorization: secret");
      },
      stats: () => ({ requests: 1 }),
    },
  ]) {
    const report = await triage({ input, live: true, client });
    assert.equal(report.metrics.abstentions, 1);
    assert.equal(report.metrics.correct, 0);
    assert.equal(report.metrics.falseDismissals, 0);
    assert.equal(report.rows[0].status, "unverified");
    assert.ok(!JSON.stringify(report).includes("PRIVATE_ERROR"));
  }
});

test("wrong dismissals are measured separately from abstention and ordinary category mismatch", async () => {
  const dismissed = await triage({
    input,
    live: true,
    client: clientFor("informational", "observe"),
  });
  assert.equal(dismissed.metrics.falseDismissals, 1);
  assert.equal(dismissed.metrics.mismatches, 1);
  assert.equal(dismissed.metrics.abstentions, 0);
  const wrongCategory = await triage({
    input,
    live: true,
    client: clientFor("error", "inspect_application"),
  });
  assert.equal(wrongCategory.metrics.falseDismissals, 0);
  assert.equal(wrongCategory.metrics.mismatches, 1);
});

test("real selected samples have no invented labels or accuracy denominator", async () => {
  const { expected, ...unlabeled } = event;
  const report = await triage({
    input: { ...input, provenance: "sanitized-unlabeled", events: [unlabeled] },
    live: true,
    client: clientFor(),
  });
  assert.equal(report.metrics.labelProvenance, "none");
  assert.equal(report.metrics.labeledGroups, 0);
  assert.equal(report.metrics.correct, 0);
});

test("missing, aliased, or malformed response model stays unverified without exposing its value", async () => {
  for (const model of [undefined, null, 123, "jev-latest", "PRIVATE_MODEL_VALUE"]) {
    const client = clientFor();
    const ask = client.ask;
    client.ask = async () => ({ ...(await ask()), model });
    const report = await triage({ input, live: true, client });
    assert.equal(report.rows[0].status, "unverified");
    assert.equal(report.rows[0].reason, "invalid_response");
    assert.equal(report.rows[0].model, null);
    assert.deepEqual(report.models, []);
    assert.ok(!JSON.stringify(report).includes("PRIVATE_MODEL_VALUE"));
  }
});

test("actual client rejects unknown choice and enforces request budget without duplicate calls", async () => {
  let calls = 0;
  const client = createJevClient({
    live: true,
    apiKey: "fixture-key",
    model: "jev-1.13.0",
    maxRequests: 1,
    fetchImpl: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            severity: answer(triageQuestions.severity, "invented"),
            action: answer(triageQuestions.action, "inspect_dependency"),
          },
          usage: { input_tokens: 20, output_tokens: 10 },
        }),
      );
    },
  });
  const report = await triage({
    input: {
      ...input,
      events: [event, { ...event, id: "second", message: "Another selected error." }],
    },
    live: true,
    client,
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    report.rows.map((row) => row.reason),
    ["invalid_response", "budget_exhausted"],
  );
  assert.equal(report.metrics.abstentions, 2);
  assert.equal(report.usage.estimatedCostUsd, null);
});

test("CLI failure is generic and private input never appears in output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-triage-test-"));
  try {
    const file = join(dir, "private.json");
    await writeFile(
      file,
      JSON.stringify({ ...input, events: [{ ...event, message: "password: PRIVATE_TEST_VALUE" }] }),
    );
    const run = spawnSync(
      process.execPath,
      [new URL("../triage.mjs", import.meta.url).pathname, "--input", file, "--live"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(run.status, 2);
    assert.equal(JSON.parse(run.stdout).status, "unverified");
    assert.ok(!`${run.stdout}${run.stderr}`.includes("PRIVATE_TEST_VALUE"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
