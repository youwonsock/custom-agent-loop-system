import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, ChildProcess } from "node:child_process";
import { createServer as reservePort } from "node:net";
import type { Browser } from "playwright";
import { terminateProcessTreeBounded } from "./process_lifecycle";
import { atomicWriteJsonFile, checkProcessLiveness, delay } from "./resilience";

import { checks, validateBrowserSpec } from "./browser_spec";
import { executeStep } from "./browser_steps";
import { inside, sourceHashes } from "./verification_sources";
export { validateBrowserSpec } from "./browser_spec";
export interface BrowserReport {
  version: 1;
  runId: string;
  startedAt: string;
  endedAt: string;
  allPassed: boolean;
  origin: string | null;
  serverPid: number | null;
  serverStopped: boolean;
  sourceHashes: Record<string, string>;
  error: string | null;
  steps: Array<{
    id: string;
    type: string;
    status: "passed" | "failed" | "not_run";
    error?: string;
  }>;
}
/** Runs inside the calling native CLI's existing sandbox; it never changes approvals. */
export async function runBrowserVerification(options: {
  target: string;
  spec: string;
  output?: string;
  signal?: AbortSignal;
}): Promise<BrowserReport> {
  const root = await fs.realpath(options.target),
    outputRoot = await inside(
      root,
      options.output ?? "verification/browser",
      true,
    ),
    runId = randomUUID();
  if (outputRoot === root)
    throw new Error("Verification output cannot be the project root");
  const out = await inside(root, path.join(outputRoot, runId), true);
  const controller = new AbortController(),
    abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new Error("Browser verification total timeout")),
    120000,
  );
  timer.unref();
  const report: BrowserReport = {
    version: 1,
    runId,
    startedAt: new Date().toISOString(),
    endedAt: "",
    allPassed: false,
    origin: null,
    serverPid: null,
    serverStopped: true,
    sourceHashes: {},
    error: null,
    steps: [],
  };
  let server: ChildProcess | undefined,
    browser: Browser | undefined,
    closeBrowser: (() => void) | undefined,
    log = "",
    specFile: string | undefined;
  try {
    controller.signal.throwIfAborted();
    specFile = await inside(root, options.spec);
    const spec = validateBrowserSpec(
      JSON.parse(await fs.readFile(specFile, "utf8")),
    );
    report.steps = spec.steps.map((s) => ({
      id: s.id,
      type: s.type,
      status: "not_run",
    }));
    report.sourceHashes = await sourceHashes(root, out);
    report.sourceHashes[
      path.relative(root, specFile).split(path.sep).join("/")
    ] = createHash("sha256")
      .update(await fs.readFile(specFile))
      .digest("hex");
    const requireFromTarget = createRequire(path.join(root, "package.json"));
    let modulePath: string;
    try {
      modulePath = requireFromTarget.resolve("playwright");
    } catch {
      modulePath = require.resolve("playwright");
    }
    const playwright = require(modulePath) as typeof import("playwright");
    // Headless-only Playwright installations intentionally omit the full
    // Chromium executable. Launch the actual browser before starting a server,
    // preserving the prerequisite failure contract without checking that path.
    try { browser = await playwright.chromium.launch({headless:true}); }
    catch(error) { throw new Error(`Chromium unavailable: ${error instanceof Error?error.message:String(error)}`); }
    controller.signal.throwIfAborted();
    const reservation = reservePort();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    controller.signal.throwIfAborted();
    const argv = spec.server.command;
    server = spawn(
      argv[0] === "node" ? process.execPath : argv[0]!,
      argv.slice(1),
      {
        cwd: root,
        env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    report.serverPid = server.pid ?? null;
    report.serverStopped = false;
    let spawnError: Error | undefined;
    server.on("error", (e) => {
      spawnError = e;
    });
    const capture = (b: Buffer) => {
      if (log.length < 1000000) log += b.toString();
    };
    server.stdout!.on("data", capture);
    server.stderr!.on("data", capture);
    const startup = Date.now() + 10000;
    while (!report.origin) {
      controller.signal.throwIfAborted();
      if (spawnError) throw spawnError;
      if (server.exitCode !== null || server.signalCode)
        throw new Error(
          `Generated server exited before ready: ${log.slice(-4000)}`,
        );
      const match = log.match(/http:\/\/127\.0\.0\.1:(\d+)(?:\/|\b)/);
      if (match) {
        if (Number(match[1]) !== port)
          throw new Error(
            "Generated server printed a different port; existing server reuse is forbidden.",
          );
        report.origin = `http://127.0.0.1:${port}`;
      } else if (Date.now() > startup)
        throw new Error(
          "Generated server did not print its actual loopback URL within 10 seconds.",
        );
      else await delay(25);
    }
    closeBrowser = () => {
      void browser?.close().catch(() => {});
    };
    controller.signal.addEventListener("abort", closeBrowser, { once: true });
    controller.signal.throwIfAborted();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    context.setDefaultTimeout(5000);
    await context.tracing.start({ screenshots: true, snapshots: true });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === report.origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const snapshots = new Map<string, string[]>();
    try {
      if (server.exitCode !== null || server.signalCode)
        throw new Error("Owned server exited before browser checks.");
      await page.goto(report.origin, { waitUntil: "networkidle" });
      for (let i = 0; i < spec.steps.length; i++) {
        controller.signal.throwIfAborted();
        if (server.exitCode !== null || server.signalCode)
          throw new Error("Owned server exited during browser checks.");
        const step = spec.steps[i]!;
        try {
          const assertionDeadline = Date.now() + 5000;
          for (;;) {
            controller.signal.throwIfAborted();
            try {
              await executeStep(page, step, snapshots, errors, report.origin);
              break;
            } catch (error) {
              if (
                !checks.has(step.type) ||
                step.type === "noConsoleErrors" ||
                Date.now() >= assertionDeadline
              )
                throw error;
              await delay(50);
            }
          }
          report.steps[i]!.status = "passed";
          if (step.type === "viewport")
            await page.screenshot({
              path: path.join(out, `viewport-${i}.png`),
              fullPage: true,
            });
        } catch (e) {
          report.steps[i]!.status = "failed";
          report.steps[i]!.error = String(e);
          throw e;
        }
      }
      await page.screenshot({
        path: path.join(out, "final.png"),
        fullPage: true,
      });
      if (
        spec.steps.some((step) => step.type === "noConsoleErrors") &&
        errors.length
      )
        throw new Error(errors.join("\n").slice(0, 4000));
    } catch (e) {
      await page
        .screenshot({ path: path.join(out, "failure.png"), fullPage: true })
        .catch(() => {});
      throw e;
    } finally {
      await context.tracing
        .stop({ path: path.join(out, "trace.zip") })
        .catch(() => {});
    }
    report.allPassed = true;
    await fs.writeFile(
      path.join(out, "browser-errors.json"),
      JSON.stringify(errors, null, 2),
    );
    // Check source/spec freshness while the owned server is still running.
    const after = await sourceHashes(root, out);
    after[path.relative(root, specFile).split(path.sep).join("/")] = createHash(
      "sha256",
    )
      .update(await fs.readFile(specFile))
      .digest("hex");
    if (JSON.stringify(after) !== JSON.stringify(report.sourceHashes))
      throw new Error(
        "Source changed during browser verification; rerun on current files.",
      );
    await fs.writeFile(path.join(out, "server.log"), log);
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    report.allPassed = false;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (closeBrowser)
      controller.signal.removeEventListener("abort", closeBrowser);
    await browser?.close().catch(() => {});
    if (server?.pid) {
      report.serverStopped =
        (await terminateProcessTreeBounded(server.pid, 2000)) === "dead";
    } else report.serverStopped = true;
    if (!report.serverStopped) {
      report.allPassed = false;
      report.error = "Owned server termination could not be confirmed.";
    }
    if (server?.pid && checkProcessLiveness(server.pid) !== "dead")
      report.allPassed = false;
    await fs.writeFile(path.join(out, "server.log"), log);
    if (report.allPassed && specFile) {
      try {
        const current = await sourceHashes(root, out);
        current[path.relative(root, specFile).split(path.sep).join("/")] =
          createHash("sha256")
            .update(await fs.readFile(specFile))
            .digest("hex");
        if (JSON.stringify(current) !== JSON.stringify(report.sourceHashes))
          throw new Error(
            "Source changed before owned server cleanup completed.",
          );
      } catch (e) {
        report.allPassed = false;
        report.error = String(e);
      }
    }
    if (controller.signal.aborted) {
      report.allPassed = false;
      report.error = String(
        controller.signal.reason ?? "Browser verification cancelled",
      );
    }
    report.endedAt = new Date().toISOString();
    await fs.writeFile(
      path.join(out, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    await atomicWriteJsonFile(path.join(outputRoot, "report.json"), report);
  }
  return report;
}
