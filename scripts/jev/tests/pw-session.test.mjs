import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Drives the real scripts/pw-session.sh against a fake playwright-cli and an
// isolated lock directory. The fake marks a session `open` in `list --all` only
// once its `open` returns, drops it as soon as `close` starts, and can hold
// `open`, `close` or one caller's `list` at a gate so each race window is
// reproduced deterministically instead of by timing.
const wrapper = fileURLToPath(new URL("../../pw-session.sh", import.meta.url));
const fakeCli = `#!/bin/bash
state="$FAKE_PW_STATE"
session=''
case "\${1:-}" in -s=*) session="\${1#-s=}"; shift ;; esac
gate() {
  if [ -e "$state/hold-$1" ]; then
    : >"$state/entered-$1"
    while [ -e "$state/hold-$1" ]; do sleep 0.02; done
  fi
}
case "\${1:-}" in
  list)
    if [ -n "\${FAKE_PW_GATE:-}" ]; then gate "list-$FAKE_PW_GATE"; fi
    for entry in "$state"/open-*; do
      [ -e "$entry" ] || continue
      printf -- '- %s:\\n  - status: open\\n' "\${entry##*/open-}"
    done
    ;;
  open) gate "open-$session"; : >"$state/open-$session" ;;
  close) rm -f "$state/open-$session"; gate "close-$session" ;;
esac
`;
// Put first on PATH, it answers like the real find but can hold before
// answering, so a verdict about one lock lands after that lock was replaced.
const fakeFind = `#!/bin/bash
out="$(PATH="$FAKE_REAL_PATH" find "$@")" || exit
if [ -e "$FAKE_PW_STATE/hold-find" ]; then
  : >"$FAKE_PW_STATE/entered-find"
  while [ -e "$FAKE_PW_STATE/hold-find" ]; do sleep 0.02; done
fi
if [ -n "$out" ]; then printf '%s\\n' "$out"; fi
`;

async function harness(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "pw-session-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = path.join(directory, "state");
  const lock = path.join(directory, "slot.lock");
  const cli = path.join(directory, "playwright-cli");
  const bin = path.join(directory, "bin");
  await mkdir(state);
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  await mkdir(bin);
  await writeFile(path.join(bin, "find"), fakeFind);
  await chmod(path.join(bin, "find"), 0o755);
  const withFakeFind = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_REAL_PATH: process.env.PATH };
  const run = (args, extraEnv = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn("bash", [wrapper, ...args], {
        cwd: directory,
        env: {
          ...process.env,
          PLAYWRIGHT_CLI_BIN: cli,
          PLAYWRIGHT_RESOURCE_LOCK_DIR: lock,
          FAKE_PW_STATE: state,
          ...extraEnv,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  const hold = (gate) => writeFile(path.join(state, `hold-${gate}`), "");
  const unhold = (gate) => rm(path.join(state, `hold-${gate}`), { force: true });
  const entered = async (gate) => {
    const marker = path.join(state, `entered-${gate}`);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (existsSync(marker)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`the wrapper never reached the ${gate} gate`);
  };
  const owner = async () => {
    try {
      return (await readFile(path.join(lock, "owner"), "utf8")).trim();
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  // A lock left behind by a holder whose browser is gone.
  const staleLock = async (session) => {
    await mkdir(lock);
    await writeFile(path.join(lock, "owner"), `${session}\n`);
    await writeFile(path.join(lock, "started-at"), "2020-01-01T00:00:00Z\n");
    await writeFile(path.join(lock, "workspace"), `${directory}\n`);
  };
  return { lock, run, hold, unhold, entered, owner, staleLock, withFakeFind };
}

test("a slot whose browser is still launching is not reclaimed by another open", async (t) => {
  const { run, hold, unhold, entered, owner } = await harness(t);
  await hold("open-a");
  const opening = run(["open", "a"]);
  await entered("open-a");

  const contender = await run(["open", "b"]);
  assert.equal(contender.code, 75, contender.stderr);
  assert.doesNotMatch(contender.stderr, /reclaimed stale slot/);
  assert.equal(await owner(), "a");

  await unhold("open-a");
  const opened = await opening;
  assert.equal(opened.code, 0, opened.stderr);
  // Once the launch finished, liveness comes from the browser list again.
  const status = await run(["status"]);
  assert.match(status.stdout, /Browser: running/);
});

test("a slot whose browser is closing is not reclaimed, so close still releases it", async (t) => {
  const { run, hold, unhold, entered, owner } = await harness(t);
  assert.equal((await run(["open", "a"])).code, 0);
  await hold("close-a");
  const closing = run(["close", "a"]);
  await entered("close-a");

  const contender = await run(["open", "b"]);
  assert.equal(contender.code, 75, contender.stderr);
  assert.equal(await owner(), "a");

  await unhold("close-a");
  const closed = await closing;
  assert.equal(closed.code, 0, closed.stderr);
  assert.match(closed.stdout, /released browser slot for 'a'/);
  assert.equal(await owner(), null);
});

test("a lock whose owner is not written yet counts as held until it is old", async (t) => {
  const { lock, run, owner } = await harness(t);
  await mkdir(lock);
  const fresh = await run(["open", "b"]);
  assert.equal(fresh.code, 75, fresh.stderr);

  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(lock, old, old);
  const reclaimed = await run(["open", "b"]);
  assert.equal(reclaimed.code, 0, reclaimed.stderr);
  assert.match(reclaimed.stderr, /reclaimed stale slot from 'unknown'/);
  assert.equal(await owner(), "b");
});

test("a wrapper PID that is gone or too old does not keep a stale lock", async (t) => {
  const { lock, run, owner, staleLock } = await harness(t);
  const now = Math.floor(Date.now() / 1000);
  for (const claim of [`2147483646 ${now}`, `${process.pid} ${now - 3600}`]) {
    await staleLock("x");
    await writeFile(path.join(lock, "pid"), `${claim}\n`);
    const result = await run(["open", "b"]);
    assert.equal(result.code, 0, `${claim}: ${result.stderr}`);
    assert.match(result.stderr, /reclaimed stale slot from 'x'/);
    assert.equal(await owner(), "b");
    assert.equal((await run(["close", "b"])).code, 0);
  }
});

test("a second reclaimer of the same stale lock leaves the fresh lock alone", async (t) => {
  const { run, hold, unhold, entered, owner, staleLock } = await harness(t);
  await staleLock("x");
  // C reads owner `x`, then stalls inside `playwright-cli list --all`.
  await hold("list-c");
  const late = run(["open", "c"], { FAKE_PW_GATE: "c" });
  await entered("list-c");

  // Meanwhile B judges the same lock stale, reclaims it and opens its browser.
  const first = await run(["open", "b"]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /reclaimed stale slot from 'x'/);
  assert.equal(await owner(), "b");

  // C's verdict about `x` is now out of date and must not touch B's lock.
  await unhold("list-c");
  const second = await late;
  assert.equal(second.code, 75, second.stderr);
  assert.doesNotMatch(second.stderr, /reclaimed stale slot/);
  assert.equal(await owner(), "b");
});

test("a fresh ownerless lock is not taken for the old one it replaced", async (t) => {
  const { lock, run, hold, unhold, entered, withFakeFind } = await harness(t);
  await mkdir(lock);
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(lock, old, old);
  // C judges the old ownerless lock dead, then stalls before acting on that.
  await hold("find");
  const late = run(["open", "c"], withFakeFind);
  await entered("find");

  // Meanwhile another contender reclaims it and has only just created its own
  // lock: no owner, start time or PID stamp yet, like the old one.
  await rm(lock, { recursive: true });
  await mkdir(lock);
  await writeFile(path.join(lock, "marker"), "");

  await unhold("find");
  const result = await late;
  assert.equal(result.code, 75, result.stderr);
  assert.doesNotMatch(result.stderr, /reclaimed stale slot/);
  assert.ok(existsSync(path.join(lock, "marker")), "the fresh lock was replaced");
});
