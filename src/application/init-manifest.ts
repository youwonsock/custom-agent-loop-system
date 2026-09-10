import { createHash } from "node:crypto";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { RootSet } from "../../root_set";
import type { JsonSchema } from "../definitions/json-schema";
import { createEmptySessionIndexProjection, validateSessionIndexProjectionV4, type SessionIndexProjectionV4 } from "../interfaces/operator/contracts";

/** Files copied by the explicit `agent-loop init` transaction. */
export const INIT_DEFINITION_FILES = [
  "agents.json",
  "agents.schema.json",
  "tasks.json",
  "tasks.schema.json",
  "workflow.json",
  "workflow.schema.json",
  "loop_config.json",
  "loop_config.schema.json",
] as const;

/** Definition documents whose digest is independent of mutable runtime settings. */
const HASHED_DEFINITION_FILES = [
  "agents.json",
  "agents.schema.json",
  "tasks.json",
  "tasks.schema.json",
  "workflow.json",
  "workflow.schema.json",
  "loop_config.schema.json",
] as const;

export const INIT_MANIFEST_FILE_NAME = "init_manifest.v1.json";

export interface InitManifestV1 {
  schemaVersion: 1;
  productVersion: string;
  definitionSha256: string;
  sessionIndexVersion: 4;
  initAt: string;
}

function manifestPath(configRoot: string): string {
  return path.join(configRoot, INIT_MANIFEST_FILE_NAME);
}

async function readFileStrict(filePath: string): Promise<Buffer> {
  return fsp.readFile(filePath);
}

/** Hash immutable definition material in a stable name/content order. */
export async function hashDefinitionFiles(root: string): Promise<string> {
  const digest = createHash("sha256");
  for (const fileName of HASHED_DEFINITION_FILES) {
    digest.update(fileName);
    digest.update("\0");
    digest.update(await readFileStrict(path.join(root, fileName)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function assertManifest(value: unknown, filePath: string): InitManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Initialization manifest is not an object: ${filePath}`);
  }
  const candidate = value as Partial<InitManifestV1>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.productVersion !== "string" ||
    !candidate.productVersion ||
    typeof candidate.definitionSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.definitionSha256) ||
    candidate.sessionIndexVersion !== 4 ||
    typeof candidate.initAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.initAt))
  ) {
    throw new Error(`Initialization manifest is invalid: ${filePath}`);
  }
  return candidate as InitManifestV1;
}

/**
 * Validate the schema document itself before using it to validate packaged
 * definitions. The runtime schema validator intentionally supports only the
 * JSON-Schema vocabulary used by this product, so an incomplete or malformed
 * schema must stop initialization instead of silently weakening validation.
 */
export function validatePackagedSchemaDocument(value: unknown, label: string): JsonSchema {
  const references: Array<{ ref: string; location: string }> = [];
  const schemaTypes = new Set(["null", "boolean", "number", "integer", "string", "array", "object"]);
  const visit = (candidate: unknown, location: string): void => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`${label} contains an invalid schema node at ${location}.`);
    }
    const schema = candidate as Record<string, unknown>;
    if (schema.$ref !== undefined) {
      if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/$defs/") || schema.$ref.length <= "#/$defs/".length) {
        throw new Error(`${label} contains an unsupported schema reference at ${location}.`);
      }
      references.push({ ref: schema.$ref.slice("#/$defs/".length), location });
    }
    if (
      schema.type !== undefined &&
      ((typeof schema.type !== "string" && !Array.isArray(schema.type)) ||
        (typeof schema.type === "string" && !schemaTypes.has(schema.type)) ||
        (Array.isArray(schema.type) && (schema.type.length === 0 || schema.type.some((entry) => typeof entry !== "string" || !schemaTypes.has(entry)))))
    ) {
      throw new Error(`${label} has an invalid type declaration at ${location}.`);
    }
    for (const field of ["required", "enum"] as const) {
      if (schema[field] !== undefined && !Array.isArray(schema[field])) throw new Error(`${label}.${field} must be an array at ${location}.`);
    }
    if (schema.required !== undefined && (schema.required as unknown[]).some((entry) => typeof entry !== "string" || !entry)) {
      throw new Error(`${label}.required contains an invalid field at ${location}.`);
    }
    for (const field of ["oneOf", "allOf"] as const) {
      if (schema[field] !== undefined) {
        if (!Array.isArray(schema[field]) || (schema[field] as unknown[]).length === 0) throw new Error(`${label}.${field} must contain schema nodes at ${location}.`);
        (schema[field] as unknown[]).forEach((entry, index) => visit(entry, `${location}.${field}[${index}]`));
      }
    }
    for (const field of ["if", "then", "items", "propertyNames"] as const) {
      if (schema[field] !== undefined) visit(schema[field], `${location}.${field}`);
    }
    if (schema.properties !== undefined) {
      if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) throw new Error(`${label}.properties must be an object at ${location}.`);
      for (const [key, child] of Object.entries(schema.properties as Record<string, unknown>)) visit(child, `${location}.properties.${key}`);
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === "object") {
      visit(schema.additionalProperties, `${location}.additionalProperties`);
    } else if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
      throw new Error(`${label}.additionalProperties must be a boolean or schema at ${location}.`);
    }
    if (schema.$defs !== undefined) {
      if (!schema.$defs || typeof schema.$defs !== "object" || Array.isArray(schema.$defs)) throw new Error(`${label}.$defs must be an object.`);
      for (const [key, child] of Object.entries(schema.$defs as Record<string, unknown>)) visit(child, `${location}.$defs.${key}`);
    }
  };
  visit(value, "$");
  const schema = value as Record<string, unknown>;
  if (
    schema.type !== "object" ||
    !schema.properties ||
    typeof schema.properties !== "object" ||
    (schema.required !== undefined && !Array.isArray(schema.required))
  ) {
    throw new Error(`${label} must declare an object schema with a properties map.`);
  }
  const definitions = schema.$defs as Record<string, unknown> | undefined;
  for (const reference of references) {
    if (!definitions || !Object.prototype.hasOwnProperty.call(definitions, reference.ref)) {
      throw new Error(`${label} contains an unresolved schema reference '#/$defs/${reference.ref}' at ${reference.location}.`);
    }
  }
  return value as JsonSchema;
}

export async function readInitManifest(configRoot: string): Promise<InitManifestV1 | null> {
  const filePath = manifestPath(configRoot);
  try {
    return assertManifest(JSON.parse((await fsp.readFile(filePath, "utf8"))), filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`Initialization manifest is not valid JSON: ${filePath}`);
    throw error;
  }
}

export function createInitManifest(productVersion: string, definitionSha256: string): InitManifestV1 {
  if (!/^[a-f0-9]{64}$/u.test(definitionSha256)) throw new Error("Definition digest must be a SHA-256 value.");
  return {
    schemaVersion: 1,
    productVersion,
    definitionSha256,
    sessionIndexVersion: 4,
    initAt: new Date().toISOString(),
  };
}

export async function readSessionIndexStrict(filePath: string): Promise<SessionIndexProjectionV4 | null> {
  try {
    const value = JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
    return validateSessionIndexProjectionV4(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`Session index is not valid JSON: ${filePath}`);
    throw error;
  }
}

export async function validateInitializedRoots(
  roots: Pick<RootSet, "codeRoot" | "configRoot" | "dataRoot">,
  productVersion: string,
  sessionIndexFileName = "sessions_index.json"
): Promise<InitManifestV1> {
  const manifest = await readInitManifest(roots.configRoot);
  if (!manifest) throw new Error(`Agent Loop is not initialized at ${roots.configRoot}. Run the init command first.`);
  if (manifest.productVersion !== productVersion) {
    throw new Error(`Initialization manifest product version ${manifest.productVersion} does not match ${productVersion}.`);
  }
  const packagedHash = await hashDefinitionFiles(roots.codeRoot);
  if (manifest.definitionSha256 !== packagedHash) {
    throw new Error("Initialization manifest does not match the packaged definitions.");
  }
  for (const fileName of INIT_DEFINITION_FILES) {
    const destination = path.join(roots.configRoot, fileName);
    const stat = await fsp.stat(destination);
    if (!stat.isFile()) throw new Error(`Initialized definition is not a file: ${destination}`);
  }
  const configHash = await hashDefinitionFiles(roots.configRoot);
  if (manifest.definitionSha256 !== configHash) {
    throw new Error("Initialized definition files do not match the commit manifest.");
  }
  const indexPath = path.join(roots.dataRoot, sessionIndexFileName);
  const index = await readSessionIndexStrict(indexPath);
  if (!index) throw new Error(`Session index is not initialized at ${indexPath}.`);
  return manifest;
}

export function emptySessionIndex(): SessionIndexProjectionV4 {
  return createEmptySessionIndexProjection();
}

export function initManifestPath(configRoot: string): string {
  return manifestPath(configRoot);
}
