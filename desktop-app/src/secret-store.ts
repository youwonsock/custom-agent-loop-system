import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { safeStorage } from "electron";

interface SecretDocument {
  version: 1;
  secrets: Record<string, string>;
}

interface SecretLockRecord {
  ownerId: string;
  ownerPid: number;
  createdAt: string;
}

function assertKey(key: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(key)) throw new Error("Invalid secret key.");
}

function validateLockRecord(value: unknown, filePath: string): SecretLockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Secret lock owner record is invalid: ${filePath}`);
  const record = value as Partial<SecretLockRecord>;
  if (
    typeof record.ownerId !== "string" || !record.ownerId ||
    !Number.isSafeInteger(record.ownerPid) || Number(record.ownerPid) <= 0 ||
    typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
  ) throw new Error(`Secret lock owner record is invalid: ${filePath}`);
  return record as SecretLockRecord;
}

export class SecretStore {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(configRoot: string) {
    this.filePath = path.join(configRoot, "secrets.v1.json");
    this.lockPath = `${this.filePath}.lock`;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 5_000;
    const ownerId = `secret-${process.pid}-${randomBytes(8).toString("hex")}`;
    const parentStat = await fsp.stat(path.dirname(this.lockPath));
    if (!parentStat.isDirectory()) throw new Error(`Secret store parent is not a directory: ${path.dirname(this.lockPath)}`);
    let handle: fsp.FileHandle | null = null;
    while (!handle) {
      let lockCreated = false;
      try {
        handle = await fsp.open(this.lockPath, "wx");
        lockCreated = true;
        await handle.writeFile(JSON.stringify({ ownerId, ownerPid: process.pid, createdAt: new Date().toISOString() }), "utf8");
      }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (handle) {
          let closeError: unknown;
          try { await handle.close(); }
          catch (releaseError) { closeError = releaseError; }
          finally { handle = null; }
          let unlinkError: unknown;
          try { await fsp.unlink(this.lockPath); }
          catch (releaseError) {
            const releaseCode = (releaseError as NodeJS.ErrnoException).code;
            if (releaseCode !== "ENOENT") unlinkError = releaseError;
          }
          if (closeError !== undefined || unlinkError !== undefined) {
            throw new AggregateError([error, ...[closeError, unlinkError].filter((entry): entry is unknown => entry !== undefined)], `Secret lock initialization failed: ${this.lockPath}`);
          }
        }
        if (lockCreated) {
          try { await fsp.rm(this.lockPath, { force: true }); }
          catch (releaseError) { throw new AggregateError([error, releaseError], `Secret lock cleanup failed: ${this.lockPath}`); }
        }
        if (code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error("Secret store is locked.");
        try {
          const record = validateLockRecord(JSON.parse(await fsp.readFile(this.lockPath, "utf8")), this.lockPath);
          const ownerPid = record.ownerPid;
          const createdAt = Date.parse(record.createdAt);
          let alive = ownerPid === process.pid;
          if (ownerPid && ownerPid !== process.pid) {
            try { process.kill(ownerPid, 0); alive = true; }
            catch (livenessError) {
              const livenessCode = (livenessError as NodeJS.ErrnoException).code;
              if (livenessCode === "ESRCH") alive = false;
              else if (livenessCode === "EPERM" || livenessCode === "EACCES") alive = true;
              else throw livenessError;
            }
          }
          if (Date.now() - createdAt > 30_000 && !alive) {
            try { await fsp.unlink(this.lockPath); }
            catch (releaseError) {
              const releaseCode = (releaseError as NodeJS.ErrnoException).code;
              if (releaseCode !== "ENOENT") throw releaseError;
            }
          }
        } catch (inspectError) {
          const inspectCode = (inspectError as NodeJS.ErrnoException).code;
          if (inspectCode !== "ENOENT") throw inspectError;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }
    let value!: T;
    let operationError: unknown;
    try { value = await operation(); }
    catch (error) { operationError = error; }
    const releaseFailures: unknown[] = [];
    try { await handle.close(); }
    catch (error) { releaseFailures.push(error); }
    try { await fsp.rm(this.lockPath); }
    catch (error) { releaseFailures.push(error); }
    if (operationError !== undefined && releaseFailures.length > 0) throw new AggregateError([operationError, ...releaseFailures], `Secret operation and lock release failed: ${this.lockPath}`);
    if (operationError !== undefined) throw operationError;
    if (releaseFailures.length > 0) throw new AggregateError(releaseFailures, `Secret lock release failed: ${this.lockPath}`);
    return value;
  }

  private async readDocument(): Promise<SecretDocument> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.filePath, "utf8")) as Partial<SecretDocument>;
      if (parsed.version !== 1 || !parsed.secrets || typeof parsed.secrets !== "object" || Array.isArray(parsed.secrets)) throw new Error("Secret store is corrupt.");
      for (const [key, value] of Object.entries(parsed.secrets)) {
        assertKey(key);
        if (typeof value !== "string" || !/^[A-Za-z0-9+/]+=*$/u.test(value)) throw new Error("Secret store ciphertext is corrupt.");
      }
      return { version: 1, secrets: { ...parsed.secrets } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, secrets: {} };
      throw new Error(`Secret store cannot be read safely: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getAll(requiredKeys: readonly string[] = []): Promise<Record<string, string>> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable; refusing to use plaintext secrets.");
    let document: SecretDocument;
    try {
      document = await this.readDocument();
    } catch (error) {
      throw error;
    }
    for (const key of requiredKeys) {
      assertKey(key);
      if (!Object.prototype.hasOwnProperty.call(document.secrets, key)) {
        throw new Error(`Secret '${key}' is missing; re-enter it in Agent Loop tool settings.`);
      }
    }
    const values: Record<string, string> = {};
    for (const [key, encoded] of Object.entries(document.secrets)) {
      try { values[key] = safeStorage.decryptString(Buffer.from(encoded, "base64")); }
      catch { throw new Error("Secret store decryption failed; re-enter the affected secret."); }
    }
    return values;
  }

  async set(values: Record<string, string>): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable; refusing to store plaintext secrets.");
    await this.withLock(async () => {
      const document = await this.readDocument();
      for (const [key, value] of Object.entries(values)) {
        assertKey(key);
        if (typeof value !== "string") throw new Error(`Secret ${key} must be a string.`);
        document.secrets[key] = safeStorage.encryptString(value).toString("base64");
      }
      const temporary = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
      try {
        await fsp.writeFile(temporary, JSON.stringify(document, null, 2), "utf8");
        await fsp.rename(temporary, this.filePath);
      } catch (error) {
        try { await fsp.rm(temporary, { force: true }); }
        catch (releaseError) { throw new AggregateError([error, releaseError], `Secret write and temporary-file release failed: ${this.filePath}`); }
        throw error;
      }
    });
  }

  async remove(key: string): Promise<void> {
    assertKey(key);
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable; refusing to modify plaintext secrets.");
    await this.withLock(async () => {
      const document = await this.readDocument();
      delete document.secrets[key];
      const temporary = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
      try {
        await fsp.writeFile(temporary, JSON.stringify(document, null, 2), "utf8");
        await fsp.rename(temporary, this.filePath);
      } catch (error) {
        try { await fsp.rm(temporary, { force: true }); }
        catch (releaseError) { throw new AggregateError([error, releaseError], `Secret removal and temporary-file release failed: ${this.filePath}`); }
        throw error;
      }
    });
  }
}
