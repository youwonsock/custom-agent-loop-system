import * as fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isWithin } from "./access_paths";
export async function inside(
  root: string,
  file: string,
  create = false,
): Promise<string> {
  const resolved = path.resolve(root, file);
  if (!isWithin(root, resolved))
    throw new Error("Verification path must stay in target project.");
  if (create) {
    let ancestor = resolved;
    while (true) {
      try {
        await fs.access(ancestor);
        break;
      } catch {
        const parent = path.dirname(ancestor);
        if (parent === ancestor)
          throw new Error("No accessible output ancestor");
        ancestor = parent;
      }
    }
    const realAncestor = await fs.realpath(ancestor);
    if (!isWithin(root, realAncestor))
      throw new Error("Verification symlink leaves target project.");
    await fs.mkdir(resolved, { recursive: true });
  }
  const real = await fs.realpath(resolved);
  if (!isWithin(root, real))
    throw new Error("Verification symlink leaves target project.");
  return real;
}
const BUILD_OUTPUT = [
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".vite",
  ".cache",
];
function gitIgnores(root: string, name: string): boolean {
  return (
    spawnSync("git", ["check-ignore", "-q", "--", `${name}/`], {
      cwd: root,
      stdio: "ignore",
    }).status === 0
  );
}
export async function sourceHashes(
  root: string,
  output: string,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const ignored = new Set([
    "node_modules",
    ".git",
    "verification",
    "artifacts",
    "test-results",
    "playwright-report",
    "coverage",
    ".DS_Store",
  ]);
  // A test role has to build. A build folder git ignores is output, but one the
  // project tracks may hold its real code, so that one stays guarded.
  for (const name of BUILD_OUTPUT)
    if (existsSync(path.join(root, name)) && gitIgnores(root, name))
      ignored.add(name);
  async function walk(dir: string): Promise<void> {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = path.join(dir, entry.name);
      if (file === output || ignored.has(entry.name)) continue;
      if (entry.isSymbolicLink())
        throw new Error(
          `Source symlinks require an explicit project copy: ${path.relative(root, file)}`,
        );
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        if (Object.keys(hashes).length >= 10000)
          throw new Error("Source hash limit exceeded.");
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        hashes[path.relative(root, file).split(path.sep).join("/")] =
          hash.digest("hex");
      }
    }
  }
  await walk(root);
  return hashes;
}
