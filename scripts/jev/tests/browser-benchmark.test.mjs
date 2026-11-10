import test from "node:test";
import assert from "node:assert/strict";
import { summarizePairs, main, readBenchmarkPlan } from "../browser-benchmark.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWithFakeCli } from "./fake-playwright-cli.mjs";

const benchmark = fileURLToPath(new URL("../browser-benchmark.mjs", import.meta.url));
// The current tree doubles as the retained baseline tree; both variants use the fake CLI.
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const liveArgs = ["--baseline-root", repository, "--live", "--samples", "1", "--warmups", "0"];

test("paired timing excludes warmups, failures and different action histories, and separates model runs", () => {
  const make = (sample, transport, extra = {}) => ({
    case: "a",
    sample,
    transport,
    mode: "deterministic",
    status: "completed",
    actions: ["click"],
    assertions: [true],
    lifecycleMs: transport === "old" ? 200 : 100,
    controlCalls: transport === "old" ? 12 : 7,
    adapterMode: transport === "old" ? "legacy-separate" : "combined-aria",
    ...extra,
  });
  const runs = [
    make(0, "old"),
    make(0, "combined"),
    make(1, "old", { status: "incomplete" }),
    make(1, "combined"),
    make(2, "old"),
    make(2, "combined", { actions: ["different"] }),
    make(3, "old", { warmup: true }),
    make(3, "combined", { warmup: true }),
    make(0, "old", { mode: "jev" }),
    make(0, "combined", { mode: "jev", lifecycleMs: 300, adapterMode: "snapshot-command" }),
  ];
  const result = summarizePairs(runs);
  assert.equal(result[0].pairs, 3);
  assert.equal(result[0].comparablePairs, 1);
  assert.equal(result[0].medianPairedReductionFraction, 0.5);
  assert.equal(result[1].medianPairedReductionFraction, -0.5);
  assert.deepEqual(result[1].combinedAdapterModes, ["snapshot-command"]);
});

test("SIGTERM during a live benchmark closes the owned browser and releases the shared slot", async () => {
  const run = await runWithFakeCli(benchmark, liveArgs, "hang");
  try {
    await run.waitUntilRunning();
    assert.equal(await run.lockHeld(), true);
    run.child.kill("SIGTERM");
    const { code, signal } = await run.exited;
    assert.deepEqual({ code, signal }, { code: 143, signal: null });
    assert.ok((await run.calls()).some((line) => /^-s=jev-\d+-[0-9a-f]+ close$/.test(line)));
    assert.equal(await run.browserRunning(), false);
    assert.equal(await run.lockHeld(), false);
  } finally {
    await run.cleanup();
  }
});

// A retained helper tree keeps its own driver lifecycle: close neither waits for a wrapper open
// that is still starting the browser nor is shared between the signal handler and the run.
const retainedTree = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-retained-tree-"));
  await fs.mkdir(path.join(root, "scripts/jev"), { recursive: true });
  const wrapper = JSON.stringify(path.join(repository, "scripts/pw-session.sh"));
  await fs.writeFile(
    path.join(root, "scripts/jev/browser-playwright.mjs"),
    `export function createPlaywrightDriver({ execute }) {
  const session = "retained-" + process.pid;
  let opening = false;
  return {
    async open() {
      opening = true;
      await execute(${wrapper}, ["open", session, "about:blank"], {});
      await execute(process.env.PLAYWRIGHT_CLI_BIN, ["-s=" + session, "run-code", "async page => true"], {});
    },
    async close() {
      if (opening) await execute(${wrapper}, ["close", session], {});
    },
  };
}
`,
  );
  await fs.writeFile(
    path.join(root, "scripts/jev/browser-plan.mjs"),
    `export { runBrowserPlan } from ${JSON.stringify(new URL("../browser-plan.mjs", import.meta.url).href)};\n`,
  );
  return root;
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const { name, mode, interrupt, status, expectedCalls } of [
  {
    name: "SIGTERM during the wrapper open",
    mode: "slow-open",
    interrupt: (run) => run.child.kill("SIGTERM"),
    status: 143,
    // The open finishes starting its browser, then that browser is closed exactly once.
    expectedCalls: ["open", "open-done", "close"],
  },
  {
    name: "Two SIGTERMs during the wrapper open",
    mode: "slow-open",
    interrupt: async (run) => {
      run.child.kill("SIGTERM");
      await pause(150);
      run.child.kill("SIGTERM");
    },
    status: 143,
    expectedCalls: ["open", "open-done", "close"],
  },
  {
    name: "Ctrl-C during the wrapper open",
    mode: "slow-open",
    // Ctrl-C reaches the whole process group, so the wrapper open dies with the slot taken.
    interrupt: (run) => process.kill(-run.child.pid, "SIGINT"),
    status: 130,
    expectedCalls: ["open", "close"],
  },
  {
    name: "Ctrl-C during the wrapper open and again during the close",
    mode: "slow-open slow-close",
    // The second one lands while the wrapper close is still stopping the browser.
    interrupt: async (run) => {
      process.kill(-run.child.pid, "SIGINT");
      await run.waitUntilRunning("closing");
      process.kill(-run.child.pid, "SIGINT");
    },
    status: 130,
    expectedCalls: ["open", "close"],
  },
])
  test(`${name}: a retained tree's browser is closed once, after its wrapper open`, async () => {
    const baseline = await retainedTree();
    const run = await runWithFakeCli(
      benchmark,
      ["--baseline-root", baseline, ...liveArgs.slice(2)],
      mode,
    );
    try {
      await run.waitUntilRunning();
      await interrupt(run);
      const { code, signal } = await run.exited;
      assert.deepEqual({ code, signal }, { code: status, signal: null });
      // An open orphaned by an early exit would only finish now.
      if (expectedCalls.includes("open-done")) await run.waitForCall("open-done");
      const calls = (await run.calls()).map(
        (line) => line.replace(/^-s=\S+ /, "").split(" ")[0],
      );
      assert.deepEqual(calls, expectedCalls);
      assert.equal(await run.browserRunning(), false);
      assert.equal(await run.lockHeld(), false);
      assert.deepEqual(await run.tempLeft(), []);
    } finally {
      await run.cleanup();
      await fs.rm(baseline, { recursive: true, force: true });
    }
  });

test("benchmark rejects empty scopes and excessive samples or model budgets before launching anything", async () => {
  await assert.rejects(main([]), /invalid_benchmark_options/);
  for (const args of [
    ["--samples", "0"],
    ["--warmups", "3"],
    ["--max-cost-usd", "0.03"],
  ]) {
    await assert.rejects(
      main(["--plan", "absent.json", "--baseline-root", "/absent", ...args]),
      /invalid_benchmark_options/,
    );
  }
});

test("plan reader is bounded and refuses non-files and symlinks before browser execution", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-benchmark-input-"));
  try {
    const file = path.join(directory, "plan.json");
    await fs.writeFile(file, '{"version":1}');
    assert.deepEqual(await readBenchmarkPlan(file), { version: 1 });
    await fs.symlink(file, path.join(directory, "link.json"));
    await assert.rejects(readBenchmarkPlan(path.join(directory, "link.json")));
    await assert.rejects(readBenchmarkPlan(directory));
    await fs.writeFile(file, "x".repeat(100001));
    await assert.rejects(readBenchmarkPlan(file), /invalid_benchmark_plan/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
