import * as crypto from "node:crypto";
import * as path from "node:path";
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
  await fse.ensureDir(path.dirname(filePath));
  const temporaryPath =
    `${filePath}.tmp.${process.pid}.${Date.now()}.` +
    crypto.randomBytes(4).toString("hex");
  await fse.writeFile(temporaryPath, JSON.stringify(data, null, 2), "utf8");
  await renameWithRetry(temporaryPath, filePath);
}

export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  const temporaryPath =
    `${filePath}.tmp.${process.pid}.${Date.now()}.` +
    crypto.randomBytes(4).toString("hex");
  await fse.writeFile(temporaryPath, content, "utf8");
  await renameWithRetry(temporaryPath, filePath);
}

export async function atomicReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fse.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    const backupPath = `${filePath}.corrupt.${Date.now()}`;
    try {
      await fse.copy(filePath, backupPath);
      console.error(`[atomicReadJson] Corrupted JSON at ${filePath}. Backed up to ${backupPath}.`);
    } catch {
      console.error(`[atomicReadJson] Corrupted JSON at ${filePath} and backup failed.`);
    }
    return null;
  }
}

export async function atomicAppendLine(filePath: string, line: string): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.append.${process.pid}.${Date.now()}`;
  let existing = "";
  try {
    existing = await fse.readFile(filePath, "utf8");
  } catch {
    existing = "";
  }
  const newline = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await fse.writeFile(temporaryPath, existing + newline + line + "\n", "utf8");
  await renameWithRetry(temporaryPath, filePath);
}

