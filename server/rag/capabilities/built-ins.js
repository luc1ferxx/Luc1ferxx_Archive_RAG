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
import { createConnectorRegistry } from "../connectors/registry.js";

const toArray = (value) => (Array.isArray(value) ? value : []);

const createConnectorCapabilities = ({
  connectorExecutors = {},
  connectorRegistry,
  connectors = [],
} = {}) => {
  const registry =
    connectorRegistry ??
    (toArray(connectors).length > 0
      ? createConnectorRegistry({
          connectors,
        })
      : null);

  return registry?.createCapabilities?.({
    executors: connectorExecutors,
  }) ?? [];
};

export const createBuiltInCapabilities = ({
  actionTaskService: providedActionTaskService,
  arxivEnrichmentService,
  arxivImportService,
  connectorExecutors,
  connectorRegistry,
  connectors,
  externalImportService,
  ragService,
  recommendationImportService,
  reportExportService,
  taskService,
  webChatService,
  workspaceArtifactService: providedWorkspaceArtifactService,
} = {}) => {
  const actionTaskService =
    providedActionTaskService ?? createActionTaskService({
      taskService,
    });
  const workspaceArtifactService = providedWorkspaceArtifactService;

  return [
    ...createConnectorCapabilities({
      connectorExecutors,
      connectorRegistry,
      connectors,
    }),
    ...[
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
        workspaceArtifactService,
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
        workspaceArtifactService,
      }),
      createSummaryCreateCapability({
        actionTaskService,
        workspaceArtifactService,
      }),
      createExternalImportCapability({
        actionTaskService,
        externalImportService,
      }),
    ],
  ];
};

export const createDefaultCapabilityRegistry = (services = {}) =>
  createCapabilityRegistry(createBuiltInCapabilities(services));
