import { createCapabilityRegistry } from "./registry.js";
import {
  createActionTaskService,
  createDocumentOrganizeCapability,
  createExternalImportCapability,
  createSummaryCreateCapability,
  createTaskCreateCapability,
} from "./actions.js";
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
  actionTaskService: providedActionTaskService,
  arxivEnrichmentService,
  arxivImportService,
  externalImportService,
  ragService,
  recommendationImportService,
  reportExportService,
  taskService,
  webChatService,
} = {}) => {
  const actionTaskService =
    providedActionTaskService ?? createActionTaskService({
      taskService,
    });

  return [
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
    createTaskCreateCapability({
      actionTaskService,
    }),
    createDocumentOrganizeCapability({
      actionTaskService,
      ragService,
    }),
    createSummaryCreateCapability({
      actionTaskService,
    }),
    createExternalImportCapability({
      actionTaskService,
      externalImportService,
    }),
  ];
};

export const createDefaultCapabilityRegistry = (services = {}) =>
  createCapabilityRegistry(createBuiltInCapabilities(services));
