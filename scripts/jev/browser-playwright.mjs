import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, chmod, access } from "node:fs/promises";
import { tmpdir, constants as osConstants } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JevError } from "./client.mjs";

const execFileAsync = promisify(execFile);

/**
 * promisify(execFile), plus the `detached` option that execFile silently drops. A detached child
 * leads its own process group, so a Ctrl-C sent to the terminal's foreground group misses it.
 * The detached path honours cwd, env and timeout only.
 */
export function execCommand(file, args, { detached, ...options } = {}) {
  if (!detached) return execFileAsync(file, args, options);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      killed = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    // As execFile does: a grandchild such as a hung playwright-cli close keeps the pipes open, so
    // without destroying them "close" would wait for it and the timeout would bound nothing.
    const timer =
      options.timeout &&
      setTimeout(() => {
        killed = true;
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill();
      }, options.timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(`Command failed: ${file}`);
      reject(Object.assign(error, { code, signal, killed, stdout, stderr }));
    });
  });
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const locatorCode = `function locate(target) {
  let parent = page;
  if (target.within) parent = page.getByRole(target.within.role, {name: target.within.name, exact: true});
  let locator = parent.getByRole(target.role, {name: target.name, exact: true});
  if (target.nth !== undefined) locator = locator.nth(target.nth);
  return locator;
}`;

// Shared by both transports: combining observations must not change assertion semantics.
const assertionCode = (assertions) => `${locatorCode}
  const assertions = ${JSON.stringify(assertions)};
  const results = [];
  for (const assertion of assertions) {
    try {
      if (assertion.type === 'url') { results.push(page.url() === assertion.equals); continue; }
      if (assertion.type === 'bodyClass') {
        const has = await page.locator('body').evaluate((element, value) => element.classList.contains(value), assertion.value);
        results.push(has === assertion.present); continue;
      }
      const locator = locate(assertion);
      const count = await locator.count();
      if (assertion.state === 'hidden') { results.push(count === 0 || (count === 1 && !await locator.isVisible())); continue; }
      if (count !== 1 || !await locator.isVisible()) { results.push(false); continue; }
      if (assertion.state === 'visible') results.push(true);
      else if (assertion.state === 'checked') results.push(await locator.isChecked());
      else if (assertion.state === 'unchecked') results.push(!await locator.isChecked());
      else if (assertion.state === 'value') results.push(await locator.inputValue() === assertion.equals);
      else if (assertion.state === 'text') results.push(await locator.innerText() === assertion.equals);
      else results.push(false);
    } catch { results.push(false); }
  }`;

// Playwright CLI's run-code VM omits URL. Requests are already canonical absolute URLs;
// use the exact origin boundary there, and evaluate location/relative URLs inside the page.
export const canonicalNavigationAllowed = (requestUrl, origin) =>
  requestUrl.startsWith(origin + "/");
export const browserOriginGuard = (origin) =>
  `if (await page.evaluate(() => location.origin) !== ${JSON.stringify(origin)}) throw new Error('origin_changed');`;

export async function findPlaywrightCli() {
  const override = process.env.PLAYWRIGHT_CLI_BIN;
  if (override) return /[/\\]/.test(override) ? path.resolve(process.cwd(), override) : override;
  for (const relative of [
    "node_modules/.bin/playwright-cli",
    "webui/node_modules/.bin/playwright-cli",
    "packages/admin/node_modules/.bin/playwright-cli",
  ]) {
    const candidate = path.join(root, relative);
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try the next installed surface. */
    }
  }
  // PATH lookup only; this never uses npx or installs packages.
  return "playwright-cli";
}

// Ctrl-C, a harness timeout and a closed terminal respectively.
const terminationSignals = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Without a handler, SIGINT/SIGTERM/SIGHUP end Node before runBrowserPlan's finally runs, and
 * the detached browser keeps running and holding the machine-wide slot. While registered, the
 * first signal closes the driver and then exits with the conventional 128+signal status.
 * Repeated signals are ignored until that close settles: exiting earlier would abandon a close
 * that may still be waiting for a browser to open. The open and close timeouts bound the wait;
 * SIGKILL cannot be intercepted. The returned release waits for a close a signal started, and
 * the exit after it, so a caller cannot start another browser in between; then it removes the
 * handlers.
 */
export function closeOnTermination(
  driver,
  { target = process, exit = (status) => process.exit(status) } = {},
) {
  let stopping;
  const handler = (signal) => {
    stopping ||= (async () => {
      try {
        await driver.close();
      } catch {
        /* Exiting either way; a failed close cannot be retried from here. */
      }
      exit(128 + osConstants.signals[signal]);
    })();
  };
  for (const signal of terminationSignals) target.on(signal, handler);
  return async () => {
    await stopping;
    for (const signal of terminationSignals) target.off(signal, handler);
  };
}

export function createPlaywrightDriver({ execute = execCommand } = {}) {
  const session = `jev-${process.pid}-${randomBytes(4).toString("hex")}`;
  let directory,
    cli,
    plan,
    started,
    opened,
    closing,
    // "unknown" until the capability probe proves which observation transport is usable.
    observationMode = "unknown",
    opening = false;
  const childEnv = { ...process.env };
  delete childEnv.TYPESAFE_API_KEY;
  delete childEnv.TYPESAFE_API_KEY_FILE;
  delete childEnv.JEV_CONFIG_FILE;
  delete childEnv.JEV_MODEL;
  async function command(args, wrapper = false, cleanup = false) {
    // Once close has begun, for example from a termination signal, no new browser work starts.
    if (closing && !cleanup) throw new JevError("browser_closed");
    const remaining = cleanup ? 15_000 : plan.limits.deadlineMs - (Date.now() - started);
    if (remaining <= 0) throw new JevError("deadline_exceeded");
    try {
      const result = await execute(wrapper ? path.join(root, "scripts/pw-session.sh") : cli, args, {
        cwd: directory,
        env: { ...childEnv, PLAYWRIGHT_CLI_BIN: cli },
        timeout: Math.min(remaining, 30_000),
        maxBuffer: 512_000,
        // Its own process group: a repeated Ctrl-C reaches the whole foreground group and
        // would otherwise kill the close before it stops the browser and releases the slot.
        detached: cleanup,
      });
      if (
        cleanup &&
        /^pw-session: warning: closing browser .* exited \d+/m.test(result.stderr || "")
      )
        throw new JevError("cleanup_failed");
      if (/^### Error/m.test(result.stdout)) throw new JevError("browser_command_failed");
      return result.stdout;
    } catch (error) {
      if (error.code === 75) {
        opening = false;
        throw new JevError("browser_slot_busy");
      }
      if (error instanceof JevError) throw error;
      throw new JevError(error.killed ? "browser_command_timeout" : "browser_command_failed");
    }
  }
  async function code(body, cleanup = false) {
    const output = await command(
      [`-s=${session}`, "run-code", `async page => { ${body} }`],
      false,
      cleanup,
    );
    const match = output.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/);
    if (!match) throw new JevError("browser_result_missing");
    try {
      return JSON.parse(match[1].trim());
    } catch {
      throw new JevError("browser_result_invalid");
    }
  }
  function guard() {
    return browserOriginGuard(plan.origin);
  }
  return {
    get adapterMode() {
      return observationMode;
    },
    async open(validatedPlan) {
      plan = validatedPlan;
      started = Date.now();
      cli = await findPlaywrightCli();
      directory = await mkdtemp(path.join(tmpdir(), "bitsocial-jev-browser-"));
      await chmod(directory, 0o700);
      const config = path.join(directory, "config.json");
      await writeFile(
        config,
        JSON.stringify({
          browser: { isolated: true, contextOptions: { serviceWorkers: "block" } },
          outputDir: directory,
        }),
        { mode: 0o600 },
      );
      opening = true;
      // Start blank so navigation guards exist before the plan URL is visited.
      opened = command(
        ["open", session, "about:blank", "--browser=chrome", `--config=${config}`],
        true,
      );
      await opened;
      const capabilities = await code(`
        const origin = ${JSON.stringify(plan.origin)};
        const navigationAllowed = ${canonicalNavigationAllowed.toString()};
        page.setDefaultTimeout(4000);
        page.setDefaultNavigationTimeout(10000);
        await page.addInitScript(() => { window.__NO_DEV_TOOLBAR__ = true; window.__VISUAL_TESTING__ = true; });
        await page.context().route('**/*', async route => {
          const request = route.request();
          if (request.isNavigationRequest() && request.frame().parentFrame() === null && !navigationAllowed(request.url(), origin)) await route.abort();
          else await route.continue();
        });
        page.context().on('page', popup => { if (popup !== page) void popup.close(); });
        await page.goto(${JSON.stringify(plan.url)}, {waitUntil: 'domcontentloaded'});
        return {ariaSnapshot: typeof page.ariaSnapshot === 'function'};
      `);
      observationMode = capabilities?.ariaSnapshot === true ? "combined-aria" : "snapshot-command";
    },
    async observe(assertions = []) {
      if (observationMode === "combined-aria") {
        const observation = await code(`${guard()}
          const snapshot = await page.ariaSnapshot({mode: 'ai'});
          ${assertionCode(assertions)}
          ${guard()} return {url: page.url(), snapshot, assertions: results};`);
        // A method can exist on an older installation without supporting AI mode.
        // Default ARIA output has roles but no actionable refs. Preserve the CLI's
        // supported serialization in that case; other failures still fail closed.
        if (
          typeof observation.snapshot !== "string" ||
          !/(?:^|\n)\s*-\s+(?!text:)[a-z]/.test(observation.snapshot) ||
          /\[ref=[a-zA-Z0-9_-]+\]/.test(observation.snapshot)
        )
          return observation;
        observationMode = "snapshot-command";
      }
      // Older installed CLIs keep their supported snapshot command. Never substitute
      // a ref-less default ARIA snapshot or silently retry a failing combined call.
      const snapshotFile = path.join(directory, "snapshot.yml");
      await command([`-s=${session}`, "snapshot", `--filename=${snapshotFile}`]);
      const result = await code(
        `${guard()} ${assertionCode(assertions)} ${guard()} return {url: page.url(), assertions: results};`,
      );
      return { ...result, snapshot: await readFile(snapshotFile, "utf8") };
    },
    async act(action) {
      const result = await code(`
        ${guard()} ${locatorCode}
        const action = ${JSON.stringify(action)};
        const expected = locate(action);
        const current = page.locator('aria-ref=' + action.ref);
        if (await expected.count() !== 1 || await current.count() !== 1 || !await current.isVisible() || !await current.isEnabled()) return false;
        const expectedElement = await expected.elementHandle();
        if (!await current.evaluate((element, expectedElement) => element === expectedElement, expectedElement)) return false;
        const hrefAllowed = await current.evaluate((element, origin) => {
          const href = element.getAttribute('href');
          return !href || new URL(href, location.href).origin === origin;
        }, ${JSON.stringify(plan.origin)});
        if (!hrefAllowed) return false;
        if (action.op === 'click') await current.click();
        else if (action.op === 'fill') await current.fill(action.value);
        else if (action.op === 'select') await current.selectOption({label: action.value});
        else if (action.op === 'check') await current.check();
        else if (action.op === 'uncheck') await current.uncheck();
        else return false;
        ${guard()} return true;
      `);
      if (result !== true) throw new JevError("stale_or_blocked_target");
    },
    async assert(assertions) {
      return code(`${guard()} ${assertionCode(assertions)} return results;`);
    },
    async text(target) {
      return code(`${guard()} ${locatorCode} const locator = locate(${JSON.stringify(target)});
        if (await locator.count() !== 1 || !await locator.isVisible()) return null;
        return locator.innerText();`);
    },
    async reload() {
      await code(`${guard()} await page.reload({waitUntil: 'domcontentloaded'}); return true;`);
    },
    close() {
      // Shared: a termination signal and runBrowserPlan's finally can both close the driver.
      closing ||= (async () => {
        // A wrapper open still starting the browser settles first, so this close stops that
        // browser instead of racing it and leaving it running.
        await opened?.catch(() => {});
        try {
          if (opening) await command(["close", session], true, true);
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      })();
      return closing;
    },
  };
}
