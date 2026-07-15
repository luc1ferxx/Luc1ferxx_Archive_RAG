import { createHash } from "node:crypto";

import { toWorkspaceArtifactReference } from "../workspace-artifacts/index.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const MAX_IDEMPOTENCY_KEY_LENGTH = 180;

export class WorkspaceArtifactWriteError extends Error {
  constructor(error) {
    const detail = normalizeText(error?.message || error).slice(0, 240);

    super(
      detail
        ? `Workspace artifact write failed: ${detail}`
        : "Workspace artifact write failed."
    );
    this.name = "WorkspaceArtifactWriteError";
    this.code = "workspace_artifact_write_failed";
    this.status = Number(error?.status ?? 500) || 500;
    this.cause = error;
  }
}

export const isWorkspaceArtifactWriteError = (error) =>
  error?.code === "workspace_artifact_write_failed";

export const buildCapabilityArtifactIdempotencyKey = ({
  namespace = "capability-artifact",
  parts = [],
} = {}) => {
  const rawKey = [namespace, ...parts]
    .map(normalizeText)
    .filter(Boolean)
    .join(":");

  if (rawKey.length <= MAX_IDEMPOTENCY_KEY_LENGTH) {
    return rawKey;
  }

  const digest = createHash("sha256").update(rawKey).digest("hex").slice(0, 32);

  return `${rawKey.slice(
    0,
    MAX_IDEMPOTENCY_KEY_LENGTH - digest.length - 1
  )}:${digest}`;
};

const buildFallbackIdempotencyKey = ({ artifact = {}, capabilityId }) => {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        artifactType: artifact.artifactType,
        capabilityId,
        content: artifact.content,
        docIds: artifact.docIds,
        payload: artifact.payload,
        title: artifact.title,
      })
    )
    .digest("hex")
    .slice(0, 32);

  return `capability-artifact:${normalizeText(capabilityId)}:${digest}`;
};

export const persistCapabilityArtifact = async ({
  accessScope = {},
  artifact = {},
  capabilityId = "",
  input = {},
  services = {},
  workspaceArtifactService,
} = {}) => {
  if (!workspaceArtifactService?.createArtifact) {
    throw new WorkspaceArtifactWriteError(
      new Error("Workspace artifact service is required.")
    );
  }

  const execution = normalizeRecord(services.artifactExecution);
  let storedArtifact;

  try {
    storedArtifact = await workspaceArtifactService.createArtifact({
      accessScope,
      artifact: {
        ...artifact,
        idempotencyKey:
          normalizeText(execution.idempotencyKey || input.idempotencyKey) ||
          buildFallbackIdempotencyKey({
            artifact,
            capabilityId,
          }),
        sourceRunId: normalizeText(
          execution.sourceRunId || input.sourceRunId || artifact.sourceRunId
        ),
        sourceTaskId: normalizeText(
          execution.sourceTaskId || input.sourceTaskId || artifact.sourceTaskId
        ),
      },
    });

    if (!storedArtifact || typeof storedArtifact !== "object") {
      throw new Error("Workspace artifact service did not return a stored artifact.");
    }
  } catch (error) {
    throw isWorkspaceArtifactWriteError(error)
      ? error
      : new WorkspaceArtifactWriteError(error);
  }

  return {
    artifact: storedArtifact,
    reference: toWorkspaceArtifactReference(storedArtifact),
  };
};
