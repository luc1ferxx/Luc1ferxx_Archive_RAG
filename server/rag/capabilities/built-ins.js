import { createCapabilityRegistry } from "./registry.js";
import { createArxivImportTopicCapability } from "./arxiv.js";
import { createCitationVerifyCapability } from "./citation.js";
import {
  createDocumentCompareBatchCapability,
  createDocumentDiscoveryCapability,
  createWorkspaceSearchDocumentsCapability,
} from "./documents.js";
import { createRecommendationImportSelectedCapability } from "./recommendation.js";
import { createReportExportCapability } from "./report.js";
import { createWebSearchCapability } from "./web.js";

export const createBuiltInCapabilities = ({
  arxivEnrichmentService,
  arxivImportService,
  ragService,
  recommendationImportService,
  reportExportService,
  webChatService,
} = {}) => [
  createArxivImportTopicCapability({
    arxivImportService,
  }),
  createDocumentDiscoveryCapability({
    ragService,
  }),
  createWebSearchCapability({
    webChatService,
  }),
  createWorkspaceSearchDocumentsCapability({
    ragService,
  }),
  createCitationVerifyCapability(),
  createReportExportCapability({
    reportExportService,
  }),
  createRecommendationImportSelectedCapability({
    arxivEnrichmentService,
    recommendationImportService,
  }),
  createDocumentCompareBatchCapability({
    ragService,
  }),
];

export const createDefaultCapabilityRegistry = (services = {}) =>
  createCapabilityRegistry(createBuiltInCapabilities(services));
