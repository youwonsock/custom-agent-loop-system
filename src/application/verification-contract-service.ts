import type { ArtifactReference } from "../domain/task-result";
import {
  VerificationApprovalCandidate,
  VerificationCommandSpec,
  VerificationContract,
  VerificationContractDraft,
  hashVerificationCandidate,
} from "../domain/verification";
import type { ArtifactStorePort } from "./ports/artifact-store";
import type { WorkspaceFingerprint, WorkspaceIntegrityPort } from "./ports/workspace-integrity-port";
import { createVerificationContract, hashVerificationContract } from "./verification-runner";

export interface VerificationContractPreparation {
  contract: VerificationContract;
  baseline: ArtifactReference;
  fingerprint: WorkspaceFingerprint;
}

export interface VerificationContractCandidate {
  candidate: VerificationApprovalCandidate;
  fingerprint: WorkspaceFingerprint;
  baseline: ArtifactReference;
  diff: ArtifactReference;
}

type CandidateDraftArgument =
  | Readonly<Record<string, number>>
  | Readonly<Partial<VerificationContractDraft>>;

function isDraftArgument(value: CandidateDraftArgument | undefined): value is Readonly<Partial<VerificationContractDraft>> {
  if (!value || typeof value !== "object") return false;
  return [
    "commands",
    "totalTimeoutMs",
    "protectedPaths",
    "testRoots",
    "allowedNewTestRoots",
    "generatedOutputPaths",
  ].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** Owns baseline, diff, and reapproval artifacts for a verification contract. */
export class VerificationContractService {
  constructor(
    private readonly integrity: WorkspaceIntegrityPort,
    private readonly artifacts: ArtifactStorePort
  ) {}

  async createInitial(
    commands: ReadonlyArray<VerificationCommandSpec>,
    projectRoot: string,
    additionalRoots: ReadonlyArray<string>,
    approvedRequestId = "system-initial",
    draft?: Partial<VerificationContractDraft>
  ): Promise<VerificationContractPreparation> {
    const fingerprint = await this.integrity.fingerprint(
      projectRoot,
      additionalRoots,
      draft?.generatedOutputPaths ?? []
    );
    const baseline = await this.artifacts.put(
      JSON.stringify(fingerprint),
      "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1"
    );
    const contract = createVerificationContract(
      [...commands],
      fingerprint.digest,
      approvedRequestId,
      fingerprint,
      draft
    );
    return {
      contract: { ...contract, baselineArtifactId: baseline.artifactId },
      baseline,
      fingerprint,
    };
  }

  async candidate(
    contract: Readonly<VerificationContract>,
    projectRoot: string,
    additionalRoots: ReadonlyArray<string>,
    baselinePaths: ReadonlyArray<string> = contract.baselinePaths ?? [],
    baselineFileHashes: Readonly<Record<string, string>> = contract.baselineFileHashes ?? {},
    baselineFileModesOrDraft: CandidateDraftArgument = contract.baselineFileModes ?? {},
    proposedDraft?: Readonly<Partial<VerificationContractDraft>>
  ): Promise<VerificationContractCandidate> {
    // Keep the sixth argument source-compatible with the original service
    // signature, where callers passed a proposed draft immediately after the
    // baseline hashes.  New callers pass baseline mode metadata first so mode
    // changes are included in the candidate hash.
    const baselineFileModes = isDraftArgument(baselineFileModesOrDraft)
      ? (contract.baselineFileModes ?? {})
      : baselineFileModesOrDraft;
    const effectiveDraft = isDraftArgument(baselineFileModesOrDraft)
      ? baselineFileModesOrDraft
      : proposedDraft;
    const fingerprint = await this.integrity.fingerprint(
      projectRoot,
      additionalRoots,
      contract.generatedOutputPaths
    );
    const before = new Set(baselinePaths);
    const current = new Set(fingerprint.paths);
    const addedPaths = [...current].filter((item) => !before.has(item)).sort();
    const deletedPaths = [...before].filter((item) => !current.has(item)).sort();
    const modifiedPaths = [...current]
      .filter((item) => before.has(item) && current.has(item))
      .filter((item) => {
        const beforeHash = baselineFileHashes[item];
        const afterHash = fingerprint.fileHashes?.[item];
        const beforeMode = baselineFileModes[item];
        const afterMode = fingerprint.fileModes?.[item];
        return (beforeHash !== undefined && afterHash !== undefined && beforeHash !== afterHash) ||
          (beforeMode !== undefined && afterMode !== undefined && beforeMode !== afterMode);
      });
    const changedPaths = [...new Set([...addedPaths, ...modifiedPaths, ...deletedPaths])].sort();
    const body = {
      baseRevision: contract.revision,
      commands: (effectiveDraft?.commands ?? contract.commands).map((command) => ({
        ...command,
        args: [...command.args],
        requirementIds: [...command.requirementIds],
      })),
      changedPaths,
      addedPaths,
      modifiedPaths,
      deletedPaths,
      baselineFingerprint: fingerprint.digest,
      baselinePaths: [...fingerprint.paths],
      ...(fingerprint.fileHashes ? { baselineFileHashes: { ...fingerprint.fileHashes } } : {}),
      ...(fingerprint.fileModes ? { baselineFileModes: { ...fingerprint.fileModes } } : {}),
      totalTimeoutMs: effectiveDraft?.totalTimeoutMs ?? contract.totalTimeoutMs,
      protectedPaths: [...(effectiveDraft?.protectedPaths ?? contract.protectedPaths)],
      testRoots: [...(effectiveDraft?.testRoots ?? contract.testRoots)],
      allowedNewTestRoots: [...(effectiveDraft?.allowedNewTestRoots ?? contract.allowedNewTestRoots)],
      generatedOutputPaths: [...(effectiveDraft?.generatedOutputPaths ?? contract.generatedOutputPaths)],
    };
    const diff = await this.artifacts.put(
      JSON.stringify(body),
      "application/vnd.custom-agent-loop.verification-diff+json;version=1"
    );
    // Keep a separately typed, content-addressed fingerprint artifact for the
    // new baseline. The diff is operator evidence; it is not a substitute for
    // the baseline used by the proof invariant.
    const baseline = await this.artifacts.put(
      JSON.stringify(fingerprint),
      "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1"
    );
    const candidate: VerificationApprovalCandidate = {
      ...body,
      baselineArtifactId: baseline.artifactId,
      candidateHash: hashVerificationCandidate({
        baseRevision: body.baseRevision,
        commands: body.commands,
        baselineFingerprint: body.baselineFingerprint,
        baselinePaths: body.baselinePaths,
        baselineFileHashes: body.baselineFileHashes,
        totalTimeoutMs: body.totalTimeoutMs,
        protectedPaths: body.protectedPaths,
        testRoots: body.testRoots,
        allowedNewTestRoots: body.allowedNewTestRoots,
        generatedOutputPaths: body.generatedOutputPaths,
        baselineFileModes: body.baselineFileModes,
        changedPaths,
        addedPaths,
        modifiedPaths,
        deletedPaths,
        diffArtifactId: diff.artifactId,
        baselineArtifactId: baseline.artifactId,
      }),
      diffArtifactId: diff.artifactId,
    };
    return { candidate, fingerprint, baseline, diff };
  }

  apply(
    contract: Readonly<VerificationContract>,
    candidate: Readonly<VerificationApprovalCandidate>,
    requestId: string,
    approvedAt: string
  ): VerificationContract {
    if (candidate.baseRevision !== contract.revision) {
      throw new Error("Verification candidate is based on an old contract revision.");
    }
    if (hashVerificationCandidate(candidate) !== candidate.candidateHash) {
      throw new Error("Verification candidate hash does not match its contents.");
    }
    const draft = {
      commands: candidate.commands.map((command) => ({
        ...command,
        args: [...command.args],
        requirementIds: [...command.requirementIds],
      })),
      totalTimeoutMs: candidate.totalTimeoutMs ?? contract.totalTimeoutMs,
      protectedPaths: [...(candidate.protectedPaths ?? contract.protectedPaths)],
      testRoots: [...(candidate.testRoots ?? contract.testRoots)],
      allowedNewTestRoots: [...(candidate.allowedNewTestRoots ?? contract.allowedNewTestRoots)],
      generatedOutputPaths: [...(candidate.generatedOutputPaths ?? contract.generatedOutputPaths)],
    };
    return {
      ...draft,
      revision: contract.revision + 1,
      contractHash: hashVerificationContract(draft),
      approvedRequestId: requestId,
      approvedAt,
      baselineArtifactId: candidate.baselineArtifactId ?? contract.baselineArtifactId,
      baselineFingerprint: candidate.baselineFingerprint ?? contract.baselineFingerprint,
      ...(candidate.baselinePaths ? { baselinePaths: [...candidate.baselinePaths] } : {}),
      ...(candidate.baselineFileHashes ? { baselineFileHashes: { ...candidate.baselineFileHashes } } : {}),
      ...(candidate.baselineFileModes ? { baselineFileModes: { ...candidate.baselineFileModes } } : {}),
    };
  }
}
