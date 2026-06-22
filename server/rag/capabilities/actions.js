import { randomUUID } from "node:crypto";

import {
  createTaskService,
  TASK_STATUSES,
} from "../tasks.js";
import {
  BUILT_IN_CAPABILITY_VERSION,
  CAPABILITY_IDS,
  normalizeText,
  normalizeTextList,
  toArray,
} from "./shared.js";

export const ACTION_TASK_TYPE = "agent_action";

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const normalizeActionId = (value, fallback) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || fallback;

const compactDocument = (document = {}) => ({
  docId: normalizeText(document.docId),
  fileName: normalizeText(document.fileName),
  tags: normalizeTextList(document.profile?.tags ?? document.tags),
});

const buildActionTaskId = ({ action, taskId }) =>
  normalizeText(taskId) ||
  `${ACTION_TASK_TYPE}:${normalizeActionId(action, "action")}:${randomUUID()}`;

export const createActionTaskService = ({
  taskService = createTaskService(),
} = {}) => ({
  async createActionTask({
    accessScope = {},
    action = "",
    input = {},
    label = "",
    result = {},
    status = TASK_STATUSES.completed,
    subject = null,
    summary = "",
    taskId = "",
  } = {}) {
    return taskService.upsertTask({
      accessScope,
      task: {
        action: normalizeText(action),
        id: buildActionTaskId({
          action,
          taskId,
        }),
        input: normalizeRecord(input),
        label: normalizeText(label) || normalizeText(action),
        result: normalizeRecord(result),
        status,
        subject: normalizeRecord(subject, null),
        summary: normalizeText(summary),
        type: ACTION_TASK_TYPE,
      },
    });
  },
});

export const createInMemoryActionTaskService = (options = {}) =>
  createActionTaskService({
    taskService: createTaskService(),
    ...options,
  });

const persistActionTask = async ({
  accessScope,
  action,
  actionTaskService,
  input,
  label,
  result,
  status,
  subject,
  summary,
} = {}) => {
  if (!actionTaskService?.createActionTask) {
    throw new Error("Action task service is required for action capabilities.");
  }

  return actionTaskService.createActionTask({
    accessScope,
    action,
    input,
    label,
    result,
    status,
    subject,
    summary,
    taskId: input.taskId,
  });
};

const buildTaskText = ({ action, label, task } = {}) =>
  `${label || action} recorded as task ${task?.id ?? "unknown"}.`;

export const createTaskCreateCapability = ({ actionTaskService } = {}) => ({
  id: CAPABILITY_IDS.taskCreate,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "Create Task",
  inputSchema: {
    type: "object",
    required: ["title"],
    properties: {
      assignee: {
        type: "string",
      },
      description: {
        type: "string",
      },
      dueDate: {
        type: "string",
      },
      priority: {
        type: "string",
      },
      tags: {
        type: "array",
      },
      taskId: {
        type: "string",
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
    sanitizedInputFields: [
      "taskId",
      "title",
      "description",
      "priority",
      "dueDate",
      "assignee",
      "tags",
    ],
    storesResult: true,
  },
  execute: async ({ accessScope, input }) => {
    const task = await persistActionTask({
      accessScope,
      action: CAPABILITY_IDS.taskCreate,
      actionTaskService,
      input,
      label: input.title,
      result: {
        assignee: normalizeText(input.assignee),
        dueDate: normalizeText(input.dueDate),
        priority: normalizeText(input.priority),
        tags: normalizeTextList(input.tags),
        title: normalizeText(input.title),
      },
      status: TASK_STATUSES.pending,
      subject: {
        type: "task",
        title: normalizeText(input.title),
      },
      summary: normalizeText(input.description) || normalizeText(input.title),
    });

    return {
      task,
      text: buildTaskText({
        action: CAPABILITY_IDS.taskCreate,
        label: "Task",
        task,
      }),
    };
  },
});

const groupDocumentsByTags = (documents = []) => {
  const groups = new Map();

  for (const document of documents.map(compactDocument)) {
    const label = document.tags[0] || "untagged";
    const group = groups.get(label) ?? {
      docIds: [],
      documents: [],
      label,
    };

    group.docIds.push(document.docId);
    group.documents.push(document);
    groups.set(label, group);
  }

  return [...groups.values()].sort((left, right) =>
    left.label.localeCompare(right.label)
  );
};

export const createDocumentOrganizeCapability = ({
  actionTaskService,
  ragService,
} = {}) => ({
  id: CAPABILITY_IDS.documentOrganize,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "Organize Documents",
  inputSchema: {
    type: "object",
    required: ["title"],
    properties: {
      docIds: {
        type: "array",
      },
      strategy: {
        type: "string",
      },
      taskId: {
        type: "string",
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
    sanitizedInputFields: ["taskId", "title", "docIds", "strategy"],
    storesResult: true,
  },
  execute: async ({ accessScope, input }) => {
    const selectedDocIds = new Set(normalizeTextList(input.docIds));
    const documents = toArray(ragService?.listDocuments?.(accessScope)).filter(
      (document) => selectedDocIds.size === 0 || selectedDocIds.has(document.docId)
    );
    const organization = {
      documentCount: documents.length,
      groups: groupDocumentsByTags(documents),
      strategy: normalizeText(input.strategy) || "profile_tags",
      title: normalizeText(input.title),
    };
    const task = await persistActionTask({
      accessScope,
      action: CAPABILITY_IDS.documentOrganize,
      actionTaskService,
      input,
      label: input.title,
      result: {
        organization,
      },
      status: TASK_STATUSES.completed,
      subject: {
        docIds: normalizeTextList(input.docIds),
        type: "documents",
      },
      summary: `Organized ${documents.length} document${documents.length === 1 ? "" : "s"}.`,
    });

    return {
      organization,
      task,
      text: buildTaskText({
        action: CAPABILITY_IDS.documentOrganize,
        label: "Document organization",
        task,
      }),
    };
  },
});

export const createSummaryCreateCapability = ({ actionTaskService } = {}) => ({
  id: CAPABILITY_IDS.summaryCreate,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "Create Summary",
  inputSchema: {
    type: "object",
    required: ["title", "summary"],
    properties: {
      citations: {
        type: "array",
      },
      docIds: {
        type: "array",
      },
      metadata: {
        type: "object",
      },
      summary: {
        type: "string",
      },
      taskId: {
        type: "string",
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
    sanitizedInputFields: [
      "taskId",
      "title",
      "summary",
      "docIds",
      "citations",
      "metadata",
    ],
    storesResult: true,
  },
  execute: async ({ accessScope, input }) => {
    const summary = {
      citations: toArray(input.citations),
      docIds: normalizeTextList(input.docIds),
      metadata: normalizeRecord(input.metadata),
      text: normalizeText(input.summary),
      title: normalizeText(input.title),
    };
    const task = await persistActionTask({
      accessScope,
      action: CAPABILITY_IDS.summaryCreate,
      actionTaskService,
      input,
      label: input.title,
      result: {
        summary,
      },
      status: TASK_STATUSES.completed,
      subject: {
        docIds: summary.docIds,
        type: "summary",
      },
      summary: summary.text,
    });

    return {
      summary,
      task,
      text: buildTaskText({
        action: CAPABILITY_IDS.summaryCreate,
        label: "Summary",
        task,
      }),
    };
  },
});

export const createExternalImportCapability = ({
  actionTaskService,
  externalImportService,
} = {}) => ({
  id: CAPABILITY_IDS.externalImport,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "External Import",
  inputSchema: {
    type: "object",
    required: ["provider", "title"],
    properties: {
      metadata: {
        type: "object",
      },
      provider: {
        type: "string",
      },
      sourceUrl: {
        type: "string",
      },
      taskId: {
        type: "string",
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
    externalCall: true,
    sanitizedInputFields: [
      "taskId",
      "provider",
      "sourceUrl",
      "title",
      "metadata",
    ],
    storesResult: true,
  },
  execute: async ({ accessScope, input }) => {
    const importRequest = {
      metadata: normalizeRecord(input.metadata),
      provider: normalizeText(input.provider),
      sourceUrl: normalizeText(input.sourceUrl),
      title: normalizeText(input.title),
    };
    const importResult = externalImportService?.importExternal
      ? await externalImportService.importExternal({
          accessScope,
          request: importRequest,
        })
      : null;
    const task = await persistActionTask({
      accessScope,
      action: CAPABILITY_IDS.externalImport,
      actionTaskService,
      input,
      label: input.title,
      result: {
        importRequest,
        importResult,
      },
      status: importResult ? TASK_STATUSES.completed : TASK_STATUSES.queued,
      subject: {
        provider: importRequest.provider,
        sourceUrl: importRequest.sourceUrl,
        type: "external_import",
      },
      summary: importResult
        ? `Imported ${importRequest.title}.`
        : `Queued external import for ${importRequest.title}.`,
    });

    return {
      importRequest,
      importResult,
      task,
      text: buildTaskText({
        action: CAPABILITY_IDS.externalImport,
        label: "External import",
        task,
      }),
    };
  },
});
