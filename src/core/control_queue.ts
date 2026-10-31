import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  ControlAck,
  ControlQueuePaths,
  ControlRequest,
  atomicWriteJsonFile,
  createId,
  readJsonFile,
} from "./resilience";

export function getControlQueuePaths(
  sessionDir: string,
  controlDirName = "control",
): ControlQueuePaths {
  const root = path.join(sessionDir, controlDirName);
  return {
    root,
    requests: path.join(root, "requests"),
    processing: path.join(root, "processing"),
    acks: path.join(root, "acks"),
  };
}

export async function ensureControlQueue(
  paths: ControlQueuePaths,
): Promise<void> {
  await Promise.all([
    fsp.mkdir(paths.requests, { recursive: true }),
    fsp.mkdir(paths.processing, { recursive: true }),
    fsp.mkdir(paths.acks, { recursive: true }),
  ]);
}

export async function enqueueControlRequest(
  paths: ControlQueuePaths,
  type: ControlRequest["type"],
  message: string | null = null,
): Promise<ControlRequest> {
  await ensureControlQueue(paths);
  const request: ControlRequest = {
    requestId: createId("control"),
    type,
    createdAt: new Date().toISOString(),
    message: message?.trim() || null,
  };
  await atomicWriteJsonFile(
    path.join(paths.requests, `${request.requestId}.json`),
    request,
  );
  return request;
}

export interface ClaimedControlRequest {
  request: ControlRequest;
  processingPath: string;
}

export async function claimNextControlRequest(
  paths: ControlQueuePaths,
): Promise<ClaimedControlRequest | null> {
  await ensureControlQueue(paths);
  const files = (await fsp.readdir(paths.requests).catch(() => [])).filter(
    (fileName) => fileName.endsWith(".json"),
  );
  const candidates: Array<{ request: ControlRequest; fileName: string }> = [];
  for (const fileName of files) {
    const request = await readJsonFile<ControlRequest>(
      path.join(paths.requests, fileName),
    );
    if (request && (request.type === "STOP" || request.type === "INTERRUPT")) {
      candidates.push({ request, fileName });
    }
  }
  candidates.sort((a, b) => {
    if (a.request.type !== b.request.type)
      return a.request.type === "STOP" ? -1 : 1;
    return a.request.createdAt.localeCompare(b.request.createdAt);
  });

  for (const candidate of candidates) {
    const sourcePath = path.join(paths.requests, candidate.fileName);
    const processingPath = path.join(paths.processing, candidate.fileName);
    try {
      await fsp.rename(sourcePath, processingPath);
    } catch {
      // Another process claimed it.
      continue;
    }
    const ack: ControlAck = {
      requestId: candidate.request.requestId,
      type: candidate.request.type,
      acceptedAt: new Date().toISOString(),
      completedAt: null,
      result: "accepted",
      message: null,
    };
    // The claim is ours once renamed. A missing accepted ack must not lose a STOP.
    await atomicWriteJsonFile(
      path.join(paths.acks, candidate.fileName),
      ack,
    ).catch(() => {});
    return { request: candidate.request, processingPath };
  }
  return null;
}

export async function recoverClaimedControlRequests(
  paths: ControlQueuePaths,
): Promise<void> {
  await ensureControlQueue(paths);
  const files = (await fsp.readdir(paths.processing).catch(() => [])).filter(
    (fileName) => fileName.endsWith(".json"),
  );
  for (const fileName of files) {
    const processingPath = path.join(paths.processing, fileName);
    const request = await readJsonFile<ControlRequest>(processingPath);
    if (!request) continue;
    const ack = await readJsonFile<ControlAck>(path.join(paths.acks, fileName));
    if (ack?.completedAt) {
      await fsp.rm(processingPath, { force: true }).catch(() => {});
      continue;
    }
    await fsp
      .rename(processingPath, path.join(paths.requests, fileName))
      .catch(() => {});
  }
}

export async function completeControlRequest(
  paths: ControlQueuePaths,
  claimed: ClaimedControlRequest,
  result: ControlAck["result"],
  message: string | null = null,
): Promise<void> {
  const existing = await readJsonFile<ControlAck>(
    path.join(paths.acks, `${claimed.request.requestId}.json`),
  );
  const ack: ControlAck = {
    requestId: claimed.request.requestId,
    type: claimed.request.type,
    acceptedAt: existing?.acceptedAt ?? new Date().toISOString(),
    completedAt: new Date().toISOString(),
    result,
    message,
  };
  await atomicWriteJsonFile(
    path.join(paths.acks, `${claimed.request.requestId}.json`),
    ack,
  );
  await fsp.rm(claimed.processingPath, { force: true }).catch(() => {});
}

export async function readControlAck(
  paths: ControlQueuePaths,
  requestId: string,
): Promise<ControlAck | null> {
  return readJsonFile<ControlAck>(path.join(paths.acks, `${requestId}.json`));
}
