import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
/** Merges must not depend on the user's identity or run their hooks. */
const git = (cwd: string, ...args: string[]) =>
  run(
    "git",
    [
      "-c",
      "user.name=Agent Graph",
      "-c",
      "user.email=agent-graph@localhost",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
  ).then((r) => r.stdout.trim());

export interface Part {
  task: string;
  directory: string;
  branch: string;
}
export interface PartCheckouts {
  base: string;
  parts: Part[];
  root: string;
  prefix: string;
}
export interface PartsResult {
  merged: string[];
  conflicts: string[];
}

/** Null when parts cannot start from a known state: not a repository, or uncommitted work. */
export async function checkOutParts(
  target: string,
  root: string,
  prefix: string,
  tasks: string[],
): Promise<PartCheckouts | null> {
  let base: string;
  try {
    base = await git(target, "rev-parse", "HEAD");
    if (await git(target, "status", "--porcelain")) return null;
  } catch {
    return null;
  }
  await fs.mkdir(root, { recursive: true });
  const parts: Part[] = [];
  for (const [i, task] of tasks.entries()) {
    const directory = path.join(root, `part-${i + 1}`),
      branch = `${prefix}/part-${i + 1}`;
    await git(target, "worktree", "add", "-q", "-b", branch, directory, base);
    // Tests need the project's dependencies, which git does not check out.
    await fs
      .symlink(
        path.join(target, "node_modules"),
        path.join(directory, "node_modules"),
        "junction",
      )
      .catch(() => {});
    parts.push({ task, directory, branch });
  }
  return { base, parts, root, prefix };
}

async function commitPart({ directory, task }: Part): Promise<void> {
  await git(directory, "add", "-A", "--", ".", ":!node_modules");
  if (
    await git(directory, "status", "--porcelain", "--", ".", ":!node_modules")
  )
    await git(
      directory,
      "commit",
      "-q",
      "--no-verify",
      "-m",
      task.slice(0, 72),
    );
}

/**
 * Merges in a checkout of its own, so a conflict never touches the project, and
 * applies the outcome as uncommitted changes, as a sequential implementation leaves it.
 */
export async function mergeParts(
  target: string,
  { base, parts, root, prefix }: PartCheckouts,
  finished: Part[],
): Promise<PartsResult> {
  const integration = path.join(root, "integration"),
    branch = `${prefix}/integration`;
  await git(target, "worktree", "add", "-q", "-b", branch, integration, base);
  const result: PartsResult = { merged: [], conflicts: [] };
  for (const part of parts) {
    if (!finished.includes(part)) continue;
    await commitPart(part);
    try {
      await git(
        integration,
        "merge",
        "-q",
        "--no-edit",
        "--no-ff",
        part.branch,
      );
      result.merged.push(part.task);
    } catch {
      await git(integration, "merge", "--abort").catch(() => {});
      result.conflicts.push(part.task);
    }
  }
  const patch = path.join(root, "merged.patch");
  await fs.writeFile(
    patch,
    await git(target, "diff", "--binary", base, branch).then((d) =>
      d ? `${d}\n` : "",
    ),
  );
  if ((await fs.stat(patch)).size) await git(target, "apply", patch);
  return result;
}

/** Removes every checkout and branch of these parts, including after a crash. */
export async function removeParts(
  target: string,
  root: string,
  prefix: string,
): Promise<void> {
  // By branch: git writes paths its own way, with other separators on Windows.
  const list = await git(target, "worktree", "list", "--porcelain").catch(
    () => "",
  );
  for (const entry of list.split(/

+/)) {
    const directory = /^worktree (.+)$/m.exec(entry)?.[1],
      branch = /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1];
    if (directory && branch?.startsWith(`${prefix}/`))
      await git(target, "worktree", "remove", "--force", directory).catch(
        () => {},
      );
  }
  await git(target, "worktree", "prune").catch(() => {});
  const branches = await git(
    target,
    "branch",
    "--list",
    "--format=%(refname:short)",
    `${prefix}/*`,
  ).catch(() => "");
  for (const branch of branches.split("\n").filter(Boolean))
    await git(target, "branch", "-q", "-D", branch).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
