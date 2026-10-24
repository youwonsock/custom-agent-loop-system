import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
export async function inside(
  root: string,
  file: string,
  create = false,
): Promise<string> {
  const resolved = path.resolve(root, file);
  if (resolved !== root && !resolved.startsWith(root + path.sep))
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
    if (realAncestor !== root && !realAncestor.startsWith(root + path.sep))
      throw new Error("Verification symlink leaves target project.");
    await fs.mkdir(resolved, { recursive: true });
  }
  const real = await fs.realpath(resolved);
  if (real !== root && !real.startsWith(root + path.sep))
    throw new Error("Verification symlink leaves target project.");
  return real;
}
export async function sourceHashes(
  root: string,
  output: string,
  productionOnly = false,
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
  if (productionOnly)
    for (const name of [
      "test",
      "tests",
      ".agent-graph",
      "dist",
      "build",
      "out",
      ".next",
      ".nuxt",
      ".vite",
      ".cache",
    ])
      ignored.add(name);
  async function walk(dir: string): Promise<void> {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = path.join(dir, entry.name);
      if (
        file === output ||
        ignored.has(entry.name) ||
        (productionOnly &&
          /\.(?:test|spec)\.[cm]?[jt]sx?$|^playwright\.config\./.test(
            entry.name,
          ))
      )
        continue;
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
export async function productionHashes(
  target: string,
): Promise<Record<string, string>> {
  const root = await fs.realpath(target);
  return sourceHashes(root, path.join(root, "verification", "browser"), true);
}
