import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as fse from "fs-extra";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function renameWithRetry(
  sourcePath: string,
  destinationPath: string,
  maxRetries = 5
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fse.rename(sourcePath, destinationPath);
      return;
    } catch (error: unknown) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        await delay(50 * Math.pow(2, attempt));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await requireParentDirectory(filePath);
  const temporaryPath =
    `${filePath}.tmp.${process.pid}.${Date.now()}.` +
    crypto.randomBytes(4).toString("hex");
  try {
    await fse.writeFile(temporaryPath, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    try { await fse.rm(temporaryPath, { force: true }); }
    catch (releaseError) { throw new AggregateError([error, releaseError], `Atomic JSON write and temporary-file cleanup failed for ${filePath}.`); }
    throw error;
  }
  try { await renameWithRetry(temporaryPath, filePath); }
  catch (error) {
    try { await fse.rm(temporaryPath, { force: true }); }
    catch (releaseError) { throw new AggregateError([error, releaseError], `Atomic JSON rename and temporary-file cleanup failed for ${filePath}.`); }
    throw error;
  }
}

export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await requireParentDirectory(filePath);
  const temporaryPath =
    `${filePath}.tmp.${process.pid}.${Date.now()}.` +
    crypto.randomBytes(4).toString("hex");
  try {
    await fse.writeFile(temporaryPath, content, "utf8");
  } catch (error) {
    try { await fse.rm(temporaryPath, { force: true }); }
    catch (releaseError) { throw new AggregateError([error, releaseError], `Atomic text write and temporary-file cleanup failed for ${filePath}.`); }
    throw error;
  }
  try { await renameWithRetry(temporaryPath, filePath); }
  catch (error) {
    try { await fse.rm(temporaryPath, { force: true }); }
    catch (releaseError) { throw new AggregateError([error, releaseError], `Atomic text rename and temporary-file cleanup failed for ${filePath}.`); }
    throw error;
  }
}

export async function atomicReadJson<T>(filePath: string): Promise<T | null> {
  let content: string;
  try {
    content = await fse.readFile(filePath, "utf8");
  } catch (error: unknown) {
    // ENOENT is the only absence that this optional reader recognizes. A
    // permission error, a directory in place of a file, or any other I/O
    // failure must remain visible to the caller instead of being relabeled as
    // corruption or replaced with defaults.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(content) as T;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    const corruptionError = new Error(`Malformed JSON: ${filePath}`);
    (corruptionError as Error & { cause?: unknown }).cause = error;
    throw corruptionError;
  }
}

export async function atomicAppendLine(filePath: string, line: string): Promise<void> {
  await requireParentDirectory(filePath);
  const temporaryPath = `${filePath}.append.${process.pid}.${Date.now()}`;
  let existing = "";
  try {
    existing = await fse.readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const newline = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  try {
    await fse.writeFile(temporaryPath, existing + newline + line + "\n", "utf8");
  } catch (error) {
    try { await fse.rm(temporaryPath, { force: true }); }
    catch (releaseError) { throw new AggregateError([error, releaseError], `Atomic append and temporary-file cleanup failed for ${filePath}.`); }
    throw error;
  }
  try { await renameWithRetry(temporaryPath, filePath); }
  catch (error) {
    try { await fse.rm(temporaryPath, { force: true }); }
    catch (releaseError) { throw new AggregateError([error, releaseError], `Atomic append rename and temporary-file cleanup failed for ${filePath}.`); }
    throw error;
  }
}

async function requireParentDirectory(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Parent directory is not initialized: ${directory}`);
    }
    throw error;
  }
  if (!stat.isDirectory()) throw new Error(`Parent path is not a directory: ${directory}`);
}
