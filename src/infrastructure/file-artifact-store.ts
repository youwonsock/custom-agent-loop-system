import { createHash } from "node:crypto";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { ArtifactStorePort } from "../application/ports/artifact-store";
import type { ArtifactReference } from "../domain/task-result";

export class FileArtifactStore implements ArtifactStorePort {
  constructor(private readonly rootDir: string) {}

  async put(content: string | Buffer, mediaType: string): Promise<ArtifactReference> {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifactId = `artifact_${sha256}`;
    const filePath = path.join(this.rootDir, "sha256", sha256.slice(0, 2), sha256);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    try {
      const handle = await fsp.open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await fsp.readFile(filePath);
      if (!existing.equals(bytes)) throw new Error(`Artifact hash collision at ${sha256}.`);
    }
    return {
      artifactId,
      sha256,
      mediaType,
      bytes: bytes.length,
      createdAt: new Date().toISOString(),
    };
  }

  async read(reference: ArtifactReference, maxBytes: number): Promise<Buffer> {
    if (reference.bytes > maxBytes) {
      throw new Error(
        `Artifact ${reference.artifactId} exceeds remaining input budget ` +
          `(${reference.bytes}/${maxBytes} bytes).`
      );
    }
    const filePath = path.join(
      this.rootDir,
      "sha256",
      reference.sha256.slice(0, 2),
      reference.sha256
    );
    const content = await fsp.readFile(filePath);
    if (content.length !== reference.bytes) {
      throw new Error(`Artifact ${reference.artifactId} byte length does not match its reference.`);
    }
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== reference.sha256 || reference.artifactId !== `artifact_${hash}`) {
      throw new Error(`Artifact ${reference.artifactId} failed integrity validation.`);
    }
    return content;
  }
}
