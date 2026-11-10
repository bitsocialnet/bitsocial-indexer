import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Stands in for playwright-cli behind the real scripts/pw-session.sh wrapper, so the slot lock
// and process lifecycle can be exercised without a browser. The mode is a space-separated list:
// "hang" blocks every page command until the session is closed; "fail" returns no page result
// and fails the browser close; "slow-open" keeps the browser starting for a second;
// "slow-close" keeps the browser stopping for a second. The browser marker exists from the end
// of open until close.
const script = `#!/bin/bash
printf '%s\\n' "$*" >>"$FAKE_CLI_DIR/calls.log"
mode() { case " $FAKE_CLI_MODE " in *" $1 "*) return 0 ;; esac; return 1; }
case "\${2:-}" in
  open)
    if mode slow-open; then
      touch "$FAKE_CLI_DIR/running"
      sleep 1
    fi
    touch "$FAKE_CLI_DIR/browser"
    printf 'open-done\\n' >>"$FAKE_CLI_DIR/calls.log"
    ;;
  close)
    if mode slow-close; then
      touch "$FAKE_CLI_DIR/closing"
      sleep 1
    fi
    rm -f "$FAKE_CLI_DIR/browser"
    touch "$FAKE_CLI_DIR/closed"
    if mode fail; then exit 1; fi
    ;;
  run-code)
    if mode hang; then
      touch "$FAKE_CLI_DIR/running"
      for _ in $(seq 200); do
        if [ -f "$FAKE_CLI_DIR/closed" ]; then break; fi
        sleep 0.05
      done
    fi
    ;;
esac
`;

const plan = {
  version: 1,
  url: "http://127.0.0.1:4173/",
  goal: "Open settings.",
  actions: [{ id: "open", op: "click", role: "button", name: "Settings" }],
  requiredActions: ["open"],
  assertions: [{ type: "bodyClass", value: "dark", present: true }],
};

const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );

/** Runs a helper entry point against the fake CLI with private lock and temp directories. */
export async function runWithFakeCli(entry, args, mode) {
  const directory = await mkdtemp(path.join(tmpdir(), "jev-fake-cli-"));
  // The helper's own temp directories land here, so a leaked one is visible and never shared.
  const temp = path.join(directory, "tmp");
  await mkdir(temp);
  const cli = path.join(directory, "playwright-cli");
  await writeFile(cli, script);
  await chmod(cli, 0o755);
  const planFile = path.join(directory, "plan.json");
  await writeFile(planFile, JSON.stringify(plan));
  const lock = path.join(directory, "lock");
  // Its own process group, so cleanup can also stop fake commands a killed helper left behind.
  const child = spawn(process.execPath, [entry, "--plan", planFile, ...args], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      PLAYWRIGHT_CLI_BIN: cli,
      PLAYWRIGHT_RESOURCE_LOCK_DIR: lock,
      TMPDIR: temp,
      FAKE_CLI_DIR: directory,
      FAKE_CLI_MODE: mode,
    },
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  const exited = new Promise((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal, stdout })),
  );
  return {
    child,
    exited,
    lockHeld: () => exists(lock),
    browserRunning: () => exists(path.join(directory, "browser")),
    tempLeft: () => readdir(temp),
    async calls() {
      return (await readFile(path.join(directory, "calls.log"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean);
    },
    /** Waits for the open or page command to start ("running") or a slow close ("closing"). */
    async waitUntilRunning(marker = "running") {
      for (let i = 0; i < 500 && !(await exists(path.join(directory, marker))); i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (!(await exists(path.join(directory, marker))))
        throw new Error(`fake browser never reached ${marker}`);
    },
    /** Waits for a logged call, such as an orphaned open finishing after the helper exited. */
    async waitForCall(line) {
      for (let i = 0; i < 250 && !(await this.calls()).includes(line); i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
    },
    async cleanup() {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* The whole group already exited. */
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
