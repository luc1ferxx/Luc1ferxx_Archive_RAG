const toArray = (value) => (Array.isArray(value) ? value : []);

const getFallbackExtension = (artifact = {}) => {
  if (artifact.format === "markdown") {
    return "md";
  }

  return artifact.format || (artifact.artifactType === "document_collection" ? "json" : "txt");
};

export const toWorkspaceArtifactReference = (artifact = {}) => ({
  artifactId: artifact.artifactId ?? "",
  artifactType: artifact.artifactType ?? "",
  fileName: artifact.fileName ?? "",
  format: artifact.format ?? "",
  mimeType: artifact.mimeType ?? "",
  sourceRunId: artifact.sourceRunId ?? "",
  sourceTaskId: artifact.sourceTaskId ?? "",
  status: artifact.status ?? "",
  title: artifact.title ?? "",
});

export const toWorkspaceArtifactSummary = (artifact = {}) => ({
  ...toWorkspaceArtifactReference(artifact),
  citationCount: toArray(artifact.citationManifest).length,
  createdAt: artifact.createdAt ?? "",
  docCount: toArray(artifact.docIds).length,
  updatedAt: artifact.updatedAt ?? "",
});

export const toWorkspaceArtifactDetail = (artifact = {}) => ({
  ...toWorkspaceArtifactSummary(artifact),
  archivedAt: artifact.archivedAt ?? null,
  citationManifest: structuredClone(toArray(artifact.citationManifest)),
  content: String(artifact.content ?? ""),
  docIds: structuredClone(toArray(artifact.docIds)),
  payload: structuredClone(
    artifact.payload && typeof artifact.payload === "object"
      ? artifact.payload
      : {}
  ),
  version: artifact.version ?? "",
});

export const toWorkspaceArtifactDownload = (artifact = {}) => {
  const isStructuredCollection =
    artifact.artifactType === "document_collection" || !String(artifact.content ?? "");
  const body = isStructuredCollection
    ? JSON.stringify(
        {
          artifactId: artifact.artifactId ?? "",
          artifactType: artifact.artifactType ?? "",
          citationManifest: structuredClone(toArray(artifact.citationManifest)),
          docIds: structuredClone(toArray(artifact.docIds)),
          payload: structuredClone(
            artifact.payload && typeof artifact.payload === "object"
              ? artifact.payload
              : {}
          ),
          title: artifact.title ?? "",
          version: artifact.version ?? "",
        },
        null,
        2
      )
    : String(artifact.content ?? "");
  const extension = getFallbackExtension(artifact);

  return {
    fileBuffer: Buffer.from(body, "utf8"),
    fileName:
      artifact.fileName ||
      `${artifact.artifactType || "artifact"}-${artifact.artifactId || "download"}.${extension}`,
    mimeType:
      artifact.mimeType ||
      (isStructuredCollection ? "application/json" : "text/plain"),
  };
};
