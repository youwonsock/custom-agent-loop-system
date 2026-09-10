import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
  WorkspaceFingerprint,
  WorkspaceIntegrityPort,
  WorkspaceWatch,
} from "../application/ports/workspace-integrity-port";

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  const lexical = fs.lstatSync(resolved);
  if (lexical.isSymbolicLink()) {
    throw new Error(`Verification root may not be a symbolic link: ${resolved}`);
  }
  if (!lexical.isDirectory()) throw new Error(`Verification root is not a directory: ${resolved}`);
  const canonical = fs.realpathSync.native(resolved);
  const normalize = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(canonical) !== normalize(resolved)) {
    throw new Error(`Verification root resolves through a link or alias: ${resolved}`);
  }
  // Windows paths are case-insensitive. Store a normalized spelling so two
  // differently-cased aliases collapse to one fingerprint root and cannot
  // evade overlap or deduplication checks.
  return normalize(canonical);
}

function relativeKey(root: string, candidate: string): string {
  const relative = path.relative(root, candidate).replace(/\\/gu, "/");
  return process.platform === "win32" ? relative.toLowerCase() : relative;
}

function normalizedPolicyPath(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  // `.` is the contract spelling for the whole project root.  Keeping that
  // meaning here is important because the default verification cwd/policy
  // uses `.` and the same exclusion rules are applied to fingerprints and
  // watcher events.
  const portable = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return portable === "." ? "" : portable;
}

function excluded(root: string, candidate: string, exclusions: readonly string[]): boolean {
  const key = relativeKey(root, candidate);
  return exclusions.some((entry) => {
    const normalized = normalizedPolicyPath(entry);
    if (!normalized) return true;
    return key === normalized || key.startsWith(`${normalized}/`);
  });
}

async function collectFiles(
  rootBase: string,
  currentRoot: string,
  exclusions: readonly string[],
  output: string[],
  directories: string[]
): Promise<void> {
  const entries = (await fsp.readdir(currentRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const candidate = path.join(currentRoot, entry.name);
    // Exclusions are project-relative policy paths. Keep the original root
    // while recursing; using the current subdirectory as the base would make
    // `generated` unexpectedly exclude `src/generated` as well.
    if (excluded(rootBase, candidate, exclusions)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in a verification fingerprint: ${candidate}`);
    }
    if (entry.isDirectory()) {
      // Dirent metadata is only a point-in-time observation. Re-check with
      // lstat before following the directory so a replacement between
      // readdir and recursion cannot turn a symlink into an approved root.
      const current = await fsp.lstat(candidate);
      if (current.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in a verification fingerprint: ${candidate}`);
      }
      if (!current.isDirectory()) {
        throw new Error(`Filesystem entry changed while fingerprinting: ${candidate}`);
      }
      directories.push(candidate);
      await collectFiles(rootBase, candidate, exclusions, output, directories);
    } else if (entry.isFile()) {
      const current = await fsp.lstat(candidate);
      if (current.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in a verification fingerprint: ${candidate}`);
      }
      if (!current.isFile()) {
        throw new Error(`Filesystem entry changed while fingerprinting: ${candidate}`);
      }
      output.push(candidate);
    } else {
      throw new Error(`Unsupported filesystem entry in verification fingerprint: ${candidate}`);
    }
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class FileWorkspaceIntegrity implements WorkspaceIntegrityPort {
  async fingerprint(
    projectRoot: string,
    additionalRoots: readonly string[],
    excludedPaths: readonly string[]
  ): Promise<WorkspaceFingerprint> {
    const roots = [projectRoot, ...additionalRoots].map(canonicalRoot);
    const allFiles: string[] = [];
    const allDirectories: string[] = [];
    const uniqueRoots = [...new Set(roots)].sort();
    for (let index = 0; index < uniqueRoots.length; index += 1) {
      for (let other = index + 1; other < uniqueRoots.length; other += 1) {
        if (uniqueRoots[other].startsWith(`${uniqueRoots[index]}${path.sep}`)) {
          throw new Error(`Verification roots overlap: ${uniqueRoots[index]} and ${uniqueRoots[other]}`);
        }
      }
    }
    for (const root of uniqueRoots) {
      const files: string[] = [];
      allDirectories.push(root);
      await collectFiles(root, root, excludedPaths, files, allDirectories);
      allFiles.push(...files);
    }
    allDirectories.sort((left, right) => left.localeCompare(right));
    allFiles.sort((left, right) => left.localeCompare(right));
    const digest = createHash("sha256");
    const fileHashes: Record<string, string> = {};
    const fileModes: Record<string, number> = {};
    for (const directory of allDirectories) {
      const stat = await fsp.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Directory changed while fingerprinting: ${directory}`);
      }
      const owningRoot = uniqueRoots.find((root) => directory === root || directory.startsWith(`${root}${path.sep}`));
      if (!owningRoot) throw new Error(`Fingerprint directory is outside approved roots: ${directory}`);
      digest.update(relativeKey(owningRoot, directory));
      digest.update("\0");
      digest.update(owningRoot);
      digest.update("\0directory\0");
      digest.update(String(stat.mode));
      digest.update("\0");
    }
    for (const filePath of allFiles) {
      const stat = await fsp.lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`File changed while fingerprinting: ${filePath}`);
      }
      const owningRoot = uniqueRoots.find((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`));
      if (!owningRoot) throw new Error(`Fingerprint file is outside approved roots: ${filePath}`);
      digest.update(relativeKey(owningRoot, filePath));
      digest.update("\0");
      digest.update(owningRoot);
      digest.update("\0file\0");
      digest.update(String(stat.size));
      digest.update("\0");
      digest.update(String(stat.mode));
      digest.update("\0");
      const contentHash = await hashFile(filePath);
      const after = await fsp.lstat(filePath);
      if (after.isSymbolicLink() || !after.isFile() || after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs || after.mode !== stat.mode) {
        throw new Error(`File changed while fingerprinting: ${filePath}`);
      }
      digest.update(contentHash);
      digest.update("\0");
      const key = `${owningRoot}/${relativeKey(owningRoot, filePath)}`.replace(/\\/gu, "/");
      fileHashes[key] = contentHash;
      fileModes[key] = stat.mode;
    }
    return {
      digest: digest.digest("hex"),
      files: allFiles.length,
      paths: allFiles,
      directoryPaths: allDirectories,
      fileHashes,
      fileModes,
    };
  }

  watch(
    projectRoot: string,
    additionalRoots: readonly string[],
    excludedPaths: readonly string[]
  ): WorkspaceWatch {
    // Apply the same link/alias rejection used by fingerprinting before
    // installing watchers. A watcher on a symlink can otherwise observe a
    // path outside the approved workspace while reporting it as in-scope.
    const roots = [projectRoot, ...additionalRoots].map((root) => canonicalRoot(root));
    const watchers: fs.FSWatcher[] = [];
    let isDirty = false;
    let isReliable = true;
    const mark = (watchDirectory: string, name: string): void => {
      if (!name) return;
      const absolute = path.resolve(watchDirectory, name);
      // `canonicalRoot()` stores Windows roots in case-folded form, while
      // fs.watch may return the spelling used by the directory entry. Fold
      // the event path before comparing it so a case-only difference cannot
      // make an in-scope mutation disappear from the watcher.
      const comparable = process.platform === "win32" ? absolute.toLowerCase() : absolute;
      const root = roots.find((candidate) => comparable === candidate || comparable.startsWith(`${candidate}${path.sep}`));
      if (root && !excluded(root, comparable, excludedPaths)) isDirty = true;
    };
    const directories: string[] = [];
    const collectDirectories = (root: string): void => {
      if (!fs.existsSync(root)) { isReliable = false; return; }
      let stat: fs.Stats;
      try {
        const lexical = fs.lstatSync(root);
        if (lexical.isSymbolicLink()) { isReliable = false; return; }
        stat = lexical;
      } catch { isReliable = false; return; }
      if (!stat.isDirectory()) { isReliable = false; return; }
      directories.push(root);
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const candidate = path.join(root, entry.name);
        if (entry.isSymbolicLink()) { isReliable = false; continue; }
        if (entry.isDirectory()) collectDirectories(candidate);
      }
    };
    for (const root of roots) collectDirectories(root);
    for (const directory of directories) {
      try {
        const watcher = fs.watch(directory, (_event, filename) => {
          // An omitted filename is itself an uncertainty.  Mark the watch
          // dirty rather than pretending the event was for an excluded file.
          if (!filename) {
            isReliable = false;
            isDirty = true;
            return;
          }
          mark(directory, String(filename));
        });
        watcher.on("error", () => { isReliable = false; isDirty = true; });
        watchers.push(watcher);
      } catch {
        isReliable = false;
        isDirty = true;
      }
    }
    return {
      get reliable() { return isReliable; },
      dirty: () => isDirty,
      close: () => { for (const watcher of watchers) watcher.close(); },
    };
  }
}
