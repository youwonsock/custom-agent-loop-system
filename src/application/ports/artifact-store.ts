import type { ArtifactReference } from "../../domain/task-result";

export interface ArtifactStorePort {
  put(content: string | Buffer, mediaType: string): Promise<ArtifactReference>;
  read(reference: ArtifactReference, maxBytes: number): Promise<Buffer>;
}
