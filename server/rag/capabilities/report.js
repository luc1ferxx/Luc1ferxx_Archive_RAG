import {
  BUILT_IN_CAPABILITY_VERSION,
  CAPABILITY_IDS,
  normalizeText,
  toArray,
} from "./shared.js";
import {
  ARTIFACT_TYPES,
  sanitizeWorkspaceArtifactStructuredValue,
} from "../workspace-artifacts/index.js";
import { persistCapabilityArtifact } from "./artifacts.js";

const slugify = (value = "report") => {
  const slug = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "report";
};

const normalizeReportFormat = (format) => {
  const normalizedFormat = normalizeText(format).toLowerCase();

  return ["json", "markdown"].includes(normalizedFormat)
    ? normalizedFormat
    : "markdown";
};

const formatCitationLine = (citation = {}, index) => {
  const label =
    normalizeText(citation.title) ||
    normalizeText(citation.fileName) ||
    normalizeText(citation.docId) ||
    normalizeText(citation.url) ||
    `Source ${index + 1}`;
  const location = [
    normalizeText(citation.docId) ? `docId: ${normalizeText(citation.docId)}` : "",
    citation.pageNumber ? `page ${citation.pageNumber}` : "",
    normalizeText(citation.url),
  ]
    .filter(Boolean)
    .join(", ");

  return `- ${label}${location ? ` (${location})` : ""}`;
};

const buildReportExport = ({
  citations = [],
  content,
  format,
  metadata = {},
  title,
} = {}) => {
  const normalizedFormat = normalizeReportFormat(format);
  const normalizedTitle = normalizeText(title) || "Agent report";
  const fileName = `${slugify(normalizedTitle)}.${
    normalizedFormat === "json" ? "json" : "md"
  }`;

  if (normalizedFormat === "json") {
    return {
      content: JSON.stringify(
        {
          title: normalizedTitle,
          content: normalizeText(content),
          citations:
            sanitizeWorkspaceArtifactStructuredValue(toArray(citations)) ?? [],
          metadata:
            sanitizeWorkspaceArtifactStructuredValue(metadata) ?? {},
        },
        null,
        2
      ),
      fileName,
      format: normalizedFormat,
      mimeType: "application/json",
    };
  }

  return {
    content: [
      `# ${normalizedTitle}`,
      "",
      normalizeText(content),
      "",
      ...(toArray(citations).length > 0
        ? [
            "## Sources",
            "",
            ...toArray(citations).map(formatCitationLine),
          ]
        : []),
    ]
      .join("\n")
      .trim(),
    fileName,
    format: normalizedFormat,
    mimeType: "text/markdown",
  };
};

const buildArtifactReport = ({ input = {}, report = {} } = {}) => {
  if (normalizeReportFormat(report.format || input.format) !== "json") {
    return report;
  }

  let structuredReport;

  try {
    structuredReport = JSON.parse(String(report.content ?? ""));
  } catch {
    structuredReport = {
      citations: toArray(input.citations),
      content: normalizeText(input.content),
      metadata: input.metadata ?? {},
      title: normalizeText(input.title) || "Agent report",
    };
  }

  return {
    ...report,
    content: JSON.stringify(
      sanitizeWorkspaceArtifactStructuredValue(structuredReport) ?? {},
      null,
      2
    ),
  };
};

export const createReportExportCapability = ({
  reportExportService,
  workspaceArtifactService,
} = {}) => ({
  id: CAPABILITY_IDS.reportExport,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "Report Export",
  inputSchema: {
    type: "object",
    required: ["title", "content"],
    properties: {
      citations: {
        type: "array",
      },
      content: {
        type: "string",
      },
      format: {
        type: "string",
      },
      metadata: {
        type: "object",
      },
      title: {
        type: "string",
      },
    },
  },
  accessScope: {
    required: true,
  },
  approvalPolicy: {
    mode: "user_confirmation",
    writesWorkspace: true,
    userConfirmationRequired: true,
  },
  privacyPolicy: {
    externalCall: false,
    sanitizedInputFields: ["title", "format"],
    storesResult: true,
  },
  execute: async ({ accessScope, input, services }) => {
    const compatibilityResult = reportExportService?.exportReport
      ? await reportExportService.exportReport({
        accessScope,
        report: {
          citations: toArray(input.citations),
          content: input.content,
          format: normalizeReportFormat(input.format),
          metadata: input.metadata ?? {},
          title: input.title,
        },
      })
      : null;

    const report = compatibilityResult?.report ??
      buildReportExport({
        citations: input.citations,
        content: input.content,
        format: input.format,
        metadata: input.metadata ?? {},
        title: input.title,
      });
    const artifactReport = buildArtifactReport({
      input,
      report,
    });
    const { reference } = await persistCapabilityArtifact({
      accessScope,
      artifact: {
        artifactType: ARTIFACT_TYPES.report,
        citationManifest: toArray(input.citations),
        content: artifactReport.content,
        docIds: toArray(input.citations).map((citation) => citation?.docId),
        fileName: report.fileName,
        format: report.format,
        mimeType: report.mimeType,
        payload: {
          metadata: input.metadata ?? {},
        },
        title: input.title,
      },
      capabilityId: CAPABILITY_IDS.reportExport,
      input,
      services,
      workspaceArtifactService,
    });

    return {
      ...(compatibilityResult ?? {}),
      artifact: reference,
      report,
      stored: true,
      text:
        normalizeText(compatibilityResult?.text) ||
        `Prepared report export ${report.fileName}.`,
    };
  },
});
