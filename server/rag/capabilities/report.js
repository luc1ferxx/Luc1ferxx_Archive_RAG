import {
  BUILT_IN_CAPABILITY_VERSION,
  CAPABILITY_IDS,
  normalizeText,
  toArray,
} from "./shared.js";

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
          citations: toArray(citations),
          metadata,
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

export const createReportExportCapability = ({ reportExportService } = {}) => ({
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
  execute: async ({ accessScope, input }) => {
    if (reportExportService?.exportReport) {
      return reportExportService.exportReport({
        accessScope,
        report: {
          citations: toArray(input.citations),
          content: input.content,
          format: normalizeReportFormat(input.format),
          metadata: input.metadata ?? {},
          title: input.title,
        },
      });
    }

    const report = buildReportExport({
      citations: input.citations,
      content: input.content,
      format: input.format,
      metadata: input.metadata ?? {},
      title: input.title,
    });

    return {
      report,
      stored: false,
      text: `Prepared report export ${report.fileName}.`,
    };
  },
});
