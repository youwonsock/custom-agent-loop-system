import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  INIT_DEFINITION_FILES,
  createInitManifest,
  emptySessionIndex,
  hashDefinitionFiles,
  initManifestPath,
  readInitManifest,
  readSessionIndexStrict,
  validateInitializedRoots,
  validatePackagedSchemaDocument,
} from "./init-manifest";
import { createEmptySessionIndexProjection } from "../interfaces/operator/contracts";

test("init manifest hashes immutable definition material and validates the packaged schema vocabulary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-init-hash-"));
  try {
    for (const fileName of INIT_DEFINITION_FILES) {
      await writeFile(path.join(root, fileName), fileName, "utf8");
    }
    const first = await hashDefinitionFiles(root);
    await writeFile(path.join(root, "workflow.json"), "changed", "utf8");
    assert.notEqual(await hashDefinitionFiles(root), first);

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        child: { $ref: "#/$defs/child" },
      },
      required: ["name"],
      $defs: { child: { type: ["string", "null"] } },
    };
    assert.deepEqual(validatePackagedSchemaDocument(schema, "test.schema"), schema);
    const invalid: unknown[] = [
      null,
      { type: "object" },
      { type: "object", properties: { child: { $ref: "other" } } },
      { type: "object", properties: { child: { $ref: "#/$defs/missing" } } },
      { type: "object", properties: { child: { type: "date" } } },
      { type: "object", properties: { child: { oneOf: [] } } },
      { type: "object", properties: { child: { required: [1] } } },
    ];
    for (const value of invalid) assert.throws(() => validatePackagedSchemaDocument(value, "bad.schema"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init and session index readers fail closed on malformed state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-init-read-"));
  try {
    assert.equal(await readInitManifest(root), null);
    const digest = "a".repeat(64);
    const manifest = createInitManifest("7.0.0", digest);
    await writeFile(initManifestPath(root), JSON.stringify(manifest), "utf8");
    assert.deepEqual(await readInitManifest(root), manifest);
    for (const value of [
      { ...manifest, schemaVersion: 2 },
      { ...manifest, definitionSha256: "bad" },
      { ...manifest, sessionIndexVersion: 3 },
      { ...manifest, initAt: "invalid" },
    ]) {
      await writeFile(initManifestPath(root), JSON.stringify(value), "utf8");
      await assert.rejects(() => readInitManifest(root), /manifest is invalid/u);
    }
    await writeFile(initManifestPath(root), "{", "utf8");
    await assert.rejects(() => readInitManifest(root), /not valid JSON/u);
    assert.throws(() => createInitManifest("7.0.0", "bad"), /SHA-256/u);

    const indexPath = path.join(root, "sessions_index.json");
    assert.equal(await readSessionIndexStrict(indexPath), null);
    await writeFile(indexPath, JSON.stringify(createEmptySessionIndexProjection()), "utf8");
    assert.deepEqual(await readSessionIndexStrict(indexPath), emptySessionIndex());
    await writeFile(indexPath, "{", "utf8");
    await assert.rejects(() => readSessionIndexStrict(indexPath), /not valid JSON/u);
    await writeFile(indexPath, JSON.stringify({ version: 999 }), "utf8");
    await assert.rejects(() => readSessionIndexStrict(indexPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateInitializedRoots binds the packaged and copied definitions to the manifest", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-loop-init-validate-"));
  const configRoot = path.join(base, "config");
  const dataRoot = path.join(base, "data");
  try {
    await mkdir(configRoot, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    for (const fileName of INIT_DEFINITION_FILES) {
      await cp(path.join(process.cwd(), fileName), path.join(configRoot, fileName));
    }
    const digest = await hashDefinitionFiles(process.cwd());
    await writeFile(initManifestPath(configRoot), JSON.stringify(createInitManifest("7.0.0", digest)), "utf8");
    await writeFile(path.join(dataRoot, "sessions_index.json"), JSON.stringify(createEmptySessionIndexProjection()), "utf8");
    const roots = { codeRoot: process.cwd(), configRoot, dataRoot };
    await assert.doesNotReject(() => validateInitializedRoots(roots, "7.0.0"));

    await writeFile(path.join(configRoot, "workflow.json"), "tampered", "utf8");
    await assert.rejects(() => validateInitializedRoots(roots, "7.0.0"), /do not match the commit manifest/u);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
