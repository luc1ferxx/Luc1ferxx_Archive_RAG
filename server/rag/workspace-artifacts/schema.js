export const WORKSPACE_ARTIFACT_VERSION = "1.0.0";

export const ARTIFACT_TYPES = Object.freeze({
  documentCollection: "document_collection",
  report: "report",
  summary: "summary",
});

export const ARTIFACT_STATUSES = Object.freeze({
  active: "active",
  archived: "archived",
});

export const WORKSPACE_ARTIFACT_LIMITS = Object.freeze({
  citationCount: 100,
  contentBytes: 512 * 1024,
  docIdCount: 500,
  listOffset: 1_000_000,
  payloadBytes: 256 * 1024,
});

const VALID_ARTIFACT_TYPES = new Set(Object.values(ARTIFACT_TYPES));
const SENSITIVE_KEY_PATTERN =
  /(?:^|_)(?:api_?key|approval|auth|authorization|client_?secret|cookie|credentials?|password|private_?key|prompt|raw_?trace|secret|token)(?:$|_)/i;
const MAX_ID_LENGTH = 180;
const MAX_TITLE_LENGTH = 240;
const MAX_STRUCTURED_DEPTH = 12;

const normalizeText = (value, maxLength = MAX_TITLE_LENGTH) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const normalizeUnboundedText = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeIdentifier = (value, label, { required = false } = {}) => {
  const normalized = normalizeUnboundedText(value);

  if (required && !normalized) {
    throw new WorkspaceArtifactValidationError(`${label} is required.`);
  }

  if (normalized.length > MAX_ID_LENGTH) {
    throw new WorkspaceArtifactValidationError(
      `${label} exceeds the ${MAX_ID_LENGTH}-character workspace artifact limit.`
    );
  }

  return normalized;
};

const normalizeContent = (value) => String(value ?? "").trim();

export const normalizeWorkspaceArtifactAccessScope = (accessScope = {}) => ({
  userId: normalizeIdentifier(accessScope.userId, "accessScope.userId"),
  workspaceId: normalizeIdentifier(
    accessScope.workspaceId,
    "accessScope.workspaceId"
  ),
});

const isSensitiveKey = (key) =>
  SENSITIVE_KEY_PATTERN.test(
    String(key ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
  );

export const sanitizeWorkspaceArtifactStructuredValue = (value, depth = 0) => {
  if (depth > MAX_STRUCTURED_DEPTH || value === undefined) {
    return undefined;
  }

  if (value === null || ["boolean", "number", "string"].includes(typeof value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeWorkspaceArtifactStructuredValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }

  if (typeof value !== "object") {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveKey(key))
      .map(([key, item]) => [
        key,
        sanitizeWorkspaceArtifactStructuredValue(item, depth + 1),
      ])
      .filter(([, item]) => item !== undefined)
  );
};

const byteLength = (value) => Buffer.byteLength(value, "utf8");

const assertWithinByteLimit = ({ label, limit, value }) => {
  if (byteLength(value) > limit) {
    throw new WorkspaceArtifactValidationError(
      `${label} exceeds the ${limit}-byte workspace artifact limit.`
    );
  }
};

const normalizeDocIds = (value) => {
  const docIds = [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => normalizeIdentifier(item, "docId"))
        .filter(Boolean)
    ),
  ];

  if (docIds.length > WORKSPACE_ARTIFACT_LIMITS.docIdCount) {
    throw new WorkspaceArtifactValidationError(
      `docIds exceeds the ${WORKSPACE_ARTIFACT_LIMITS.docIdCount}-item workspace artifact limit.`
    );
  }

  return docIds;
};

const normalizeFileName = (value) =>
  normalizeText(value, MAX_ID_LENGTH)
    .replace(/[\\/]+/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "");

const normalizeCitationManifest = (value) => {
  const citations = (Array.isArray(value) ? value : [])
    .map((citation) => {
      const source =
        citation && typeof citation === "object" && !Array.isArray(citation)
          ? citation
          : {};
      const compactCitation = {
        arxivId: normalizeText(source.arxivId, MAX_ID_LENGTH),
        chunkId: normalizeText(source.chunkId, MAX_ID_LENGTH),
        docId: normalizeText(source.docId, MAX_ID_LENGTH),
        excerpt: normalizeText(source.excerpt, 1200),
        fileName: normalizeText(source.fileName, MAX_TITLE_LENGTH),
        pageNumber:
          Number.isInteger(Number(source.pageNumber)) && Number(source.pageNumber) > 0
            ? Number(source.pageNumber)
            : undefined,
        relatedToDocId: normalizeText(source.relatedToDocId, MAX_ID_LENGTH),
        sourceType: normalizeText(source.sourceType, 80),
        title: normalizeText(source.title, MAX_TITLE_LENGTH),
        url: normalizeText(source.url, 1000),
      };

      return Object.fromEntries(
        Object.entries(compactCitation).filter(([, item]) => item !== "" && item !== undefined)
      );
    })
    .filter((citation) => Object.keys(citation).length > 0);

  if (citations.length > WORKSPACE_ARTIFACT_LIMITS.citationCount) {
    throw new WorkspaceArtifactValidationError(
      `citationManifest exceeds the ${WORKSPACE_ARTIFACT_LIMITS.citationCount}-item workspace artifact limit.`
    );
  }

  return citations;
};

export class WorkspaceArtifactValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceArtifactValidationError";
    this.code = "invalid_workspace_artifact";
    this.status = 400;
  }
}

export const normalizeWorkspaceArtifact = ({
  accessScope = {},
  artifact = {},
  artifactId,
  timestamp,
} = {}) => {
  const normalizedArtifactType = normalizeText(artifact.artifactType, 80);
  const normalizedArtifactId = normalizeIdentifier(
    artifactId || artifact.artifactId,
    "artifactId",
    { required: true }
  );
  const normalizedIdempotencyKey = normalizeIdentifier(
    artifact.idempotencyKey,
    "idempotencyKey",
    { required: true }
  );
  const normalizedTitle = normalizeText(artifact.title, MAX_TITLE_LENGTH);

  if (!VALID_ARTIFACT_TYPES.has(normalizedArtifactType)) {
    throw new WorkspaceArtifactValidationError(
      `artifactType must be one of: ${[...VALID_ARTIFACT_TYPES].join(", ")}.`
    );
  }

  if (!normalizedTitle) {
    throw new WorkspaceArtifactValidationError("title is required.");
  }

  const content = normalizeContent(artifact.content);
  const payload = sanitizeWorkspaceArtifactStructuredValue(artifact.payload) ?? {};
  const serializedPayload = JSON.stringify(payload);

  assertWithinByteLimit({
    label: "content",
    limit: WORKSPACE_ARTIFACT_LIMITS.contentBytes,
    value: content,
  });
  assertWithinByteLimit({
    label: "payload",
    limit: WORKSPACE_ARTIFACT_LIMITS.payloadBytes,
    value: serializedPayload,
  });

  const normalizedTimestamp = normalizeText(timestamp, 80);
  const scope = normalizeWorkspaceArtifactAccessScope(accessScope);

  return {
    archivedAt: null,
    artifactId: normalizedArtifactId,
    artifactType: normalizedArtifactType,
    citationManifest: normalizeCitationManifest(artifact.citationManifest),
    content,
    createdAt: normalizedTimestamp,
    docIds: normalizeDocIds(artifact.docIds),
    fileName: normalizeFileName(artifact.fileName),
    format: normalizeText(artifact.format, 80),
    idempotencyKey: normalizedIdempotencyKey,
    mimeType: normalizeText(artifact.mimeType, 160),
    ownerUserId: scope.userId,
    payload,
    sourceRunId: normalizeIdentifier(artifact.sourceRunId, "sourceRunId"),
    sourceTaskId: normalizeIdentifier(artifact.sourceTaskId, "sourceTaskId"),
    status: ARTIFACT_STATUSES.active,
    title: normalizedTitle,
    updatedAt: normalizedTimestamp,
    version: WORKSPACE_ARTIFACT_VERSION,
    workspaceId: scope.workspaceId,
  };
};

export const buildWorkspaceArtifactScopeKey = (accessScope = {}) => {
  const scope = normalizeWorkspaceArtifactAccessScope(accessScope);

  return `${scope.userId}\u0000${scope.workspaceId}`;
};

export const normalizeWorkspaceArtifactListQuery = ({
  artifactType = "",
  limit = 50,
  offset = 0,
  status = ARTIFACT_STATUSES.active,
} = {}) => {
  const normalizedArtifactType = normalizeText(artifactType, 80);
  const normalizedStatus =
    normalizeText(status, 80) || ARTIFACT_STATUSES.active;

  if (
    normalizedArtifactType &&
    !VALID_ARTIFACT_TYPES.has(normalizedArtifactType)
  ) {
    throw new WorkspaceArtifactValidationError(
      `artifactType must be one of: ${[...VALID_ARTIFACT_TYPES].join(", ")}.`
    );
  }

  if (!Object.values(ARTIFACT_STATUSES).includes(normalizedStatus)) {
    throw new WorkspaceArtifactValidationError(
      `status must be one of: ${Object.values(ARTIFACT_STATUSES).join(", ")}.`
    );
  }

  const numericLimit = Number(limit);
  const numericOffset = Number(offset);

  if (!Number.isFinite(numericLimit)) {
    throw new WorkspaceArtifactValidationError("limit must be a finite number.");
  }

  if (
    !Number.isFinite(numericOffset) ||
    numericOffset > WORKSPACE_ARTIFACT_LIMITS.listOffset
  ) {
    throw new WorkspaceArtifactValidationError(
      `offset must be a finite number no greater than ${WORKSPACE_ARTIFACT_LIMITS.listOffset}.`
    );
  }

  return {
    artifactType: normalizedArtifactType,
    limit: Math.min(100, Math.max(1, Math.floor(numericLimit || 50))),
    offset: Math.max(0, Math.floor(numericOffset || 0)),
    status: normalizedStatus,
  };
};
