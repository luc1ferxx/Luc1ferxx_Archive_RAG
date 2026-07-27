import { useEffect, useMemo, useState } from "react";
import {
  AuditOutlined,
  CloudUploadOutlined,
  BranchesOutlined,
  EllipsisOutlined,
  FileDoneOutlined,
  FilePdfOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  HomeOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";

const HOME_SECTION_IDS = ["home", "skills", "workflows", "drive", "runs", "more"];

const HOME_NAV_ITEMS = [
  {
    id: "new",
    icon: PlusOutlined,
    kind: "command",
    labelKey: "home.nav.new",
    target: "new",
  },
  {
    id: "home",
    icon: HomeOutlined,
    labelKey: "home.nav.home",
    target: "home",
  },
  {
    id: "skills",
    icon: FileSearchOutlined,
    labelKey: "home.nav.skills",
    target: "skills",
  },
  {
    id: "workflows",
    icon: BranchesOutlined,
    labelKey: "home.nav.workflows",
    shortLabelKey: "home.nav.flows",
    target: "workflows",
  },
  {
    id: "drive",
    icon: FolderOpenOutlined,
    labelKey: "home.nav.drive",
    target: "drive",
  },
  {
    id: "runs",
    icon: PlayCircleOutlined,
    labelKey: "home.nav.runs",
    target: "runs",
  },
  {
    id: "more",
    icon: EllipsisOutlined,
    labelKey: "home.nav.more",
    target: "more",
  },
];

const CAPABILITY_DEFINITIONS = [
  {
    id: "upload",
    actionLabelKey: "home.action.upload",
    group: "sources",
    icon: CloudUploadOutlined,
    type: "upload",
  },
  {
    id: "document_rag",
    actionLabelKey: "home.action.citedQa",
    group: "sources",
    icon: FileSearchOutlined,
    labelKey: "skill.document.label",
    metaKey: "skill.document.meta",
    summaryKey: "skill.document.summary",
    target: "skills",
    draftKey: "workflow.document.draft",
  },
  {
    id: "compare_documents",
    actionLabelKey: "home.action.compare",
    group: "analysis",
    icon: BranchesOutlined,
    labelKey: "skill.compare.label",
    metaKey: "skill.compare.meta",
    summaryKey: "skill.compare.summary",
    target: "workflows",
    workflowLabelKey: "workflow.compare.label",
    workflowSummaryKey: "workflow.compare.summary",
    draftKey: "workflow.compare.draft",
  },
  {
    id: "risk_review",
    actionLabelKey: "home.action.risk",
    group: "analysis",
    icon: SafetyCertificateOutlined,
    labelKey: "skill.risk.label",
    metaKey: "skill.risk.meta",
    summaryKey: "skill.risk.summary",
    target: "workflows",
    workflowLabelKey: "workflow.risk.label",
    workflowSummaryKey: "workflow.risk.summary",
    draftKey: "workflow.risk.draft",
  },
  {
    id: "extract_timeline",
    actionLabelKey: "home.action.timeline",
    group: "analysis",
    icon: AuditOutlined,
    labelKey: "skill.timeline.label",
    metaKey: "skill.timeline.meta",
    summaryKey: "skill.timeline.summary",
    target: "workflows",
    workflowLabelKey: "workflow.timeline.label",
    workflowSummaryKey: "workflow.timeline.summary",
    draftKey: "workflow.timeline.draft",
  },
  {
    id: "summarize_contract",
    group: "analysis",
    icon: FileDoneOutlined,
    labelKey: "skill.contract.label",
    metaKey: "skill.contract.meta",
    summaryKey: "skill.contract.summary",
    draftKey: "workflow.contract.draft",
  },
  {
    id: "runs",
    actionLabelKey: "home.action.viewRuns",
    group: "workspace",
    icon: PlayCircleOutlined,
    target: "runs",
  },
];

const CAPABILITY_GROUPS = ["sources", "analysis", "workspace"];

const DOCUMENT_SKILLS = CAPABILITY_DEFINITIONS.filter(
  (capability) => capability.labelKey
);

const WORKFLOW_TEMPLATES = CAPABILITY_DEFINITIONS.filter(
  (capability) => capability.workflowLabelKey
).map((capability) => ({
  id: capability.id,
  labelKey: capability.workflowLabelKey,
  skillId: capability.id,
  summaryKey: capability.workflowSummaryKey,
}));

const HOME_ACTIONS = CAPABILITY_DEFINITIONS.filter(
  (capability) => capability.actionLabelKey
).map((capability) => ({
  ...capability,
  labelKey: capability.actionLabelKey,
  skillId: capability.labelKey ? capability.id : undefined,
}));

const WORKSPACE_STATS = [
  {
    id: "documents",
    labelKey: "home.stat.docs",
    valueKey: "documentCount",
  },
  {
    id: "pages",
    labelKey: "home.stat.pages",
    valueKey: "pageCount",
  },
  {
    id: "runs",
    labelKey: "home.stat.runs",
    valueKey: "taskCount",
  },
];

const defaultT = (key, values = {}) =>
  Object.entries(values).reduce(
    (result, [valueKey, value]) => result.split(`{${valueKey}}`).join(value),
    key
  );

const getDocumentLabel = (document) =>
  document?.fileName ?? document?.title ?? document?.docId;

const getDocumentPageLabel = (document, t) => {
  const pageCount = document?.pageCount ?? document?.pages;

  if (!pageCount) {
    return t("common.indexed");
  }

  return `${pageCount} ${t(pageCount === 1 ? "common.page" : "common.pages")}`;
};

const getSkillById = (skillId) =>
  DOCUMENT_SKILLS.find((skill) => skill.id === skillId);

const getSkillDraftQuestion = (skill, t) =>
  t(skill?.draftKey ?? getSkillById("document_rag").draftKey);

const getPendingTaskScopeLabel = (pendingTask, t) => {
  if (!pendingTask) {
    return "";
  }

  if (pendingTask.documentCount > 0) {
    return t(
      pendingTask.documentCount === 1
        ? "home.selectedDocuments"
        : "home.selectedDocuments_plural",
      {
        count: pendingTask.documentCount,
      }
    );
  }

  return t("home.currentWorkspaceScope");
};

const WorkspaceEntryPanel = ({
  activeSection = "home",
  artifactSlot,
  children,
  documentCount = 0,
  documents = [],
  onNavigate,
  onNew,
  onOpenWorkspace,
  onPrepareTask,
  onSkillSelect,
  onUploadClick,
  pageCount = 0,
  pendingTask,
  recoveryRuns = [],
  selectedSkillId,
  tasks = [],
  taskCount = 0,
  t = defaultT,
  uploadSlot,
  languageSlot,
}) => {
  const [compareDocIds, setCompareDocIds] = useState([]);
  const statValues = {
    documentCount,
    pageCount,
    taskCount,
  };
  const selectedSkill = useMemo(
    () => getSkillById(selectedSkillId) ?? DOCUMENT_SKILLS[0],
    [selectedSkillId]
  );
  const selectedCompareDocuments = documents.filter((document) =>
    compareDocIds.includes(document.docId)
  );
  const recentRuns = [...tasks, ...recoveryRuns].slice(0, 5);

  useEffect(() => {
    const documentIdSet = new Set(documents.map((document) => document.docId));

    setCompareDocIds((currentDocIds) =>
      currentDocIds.filter((docId) => documentIdSet.has(docId))
    );
  }, [documents]);

  const handleNavigate = (target) => {
    if (target === "new") {
      onNew?.();
      return;
    }

    onNavigate?.(target);
  };

  const selectActionSkill = (action) => {
    if (!action.skillId) {
      return;
    }

    const target = action.target ?? "workflows";
    const skill = getSkillById(action.skillId);

    onSkillSelect?.(skill);
    onNavigate?.(target);
  };

  const handleAction = (action) => {
    if (action.type === "upload") {
      onUploadClick?.();
      return;
    }

    if (action.skillId) {
      selectActionSkill(action);
      return;
    }

    onNavigate?.(action.target ?? action.id);
  };

  const handleSkillSelect = (skill) => {
    onSkillSelect?.(skill);
  };

  const prepareSkillTask = (skill, documentIds = []) => {
    onPrepareTask?.({
      documentIds,
      question: getSkillDraftQuestion(skill, t),
      skill,
    });
  };

  const toggleCompareDocument = (docId) => {
    setCompareDocIds((currentDocIds) =>
      currentDocIds.includes(docId)
        ? currentDocIds.filter((currentDocId) => currentDocId !== docId)
        : [...currentDocIds, docId]
    );
  };

  const prepareComparisonTask = () => {
    prepareSkillTask(getSkillById("compare_documents"), compareDocIds);
  };

  const renderSkillGrid = () => (
    <div className="archive-skill-card-grid">
      {DOCUMENT_SKILLS.map((skill) => {
        const SkillIcon = skill.icon;
        const isSelected = selectedSkill?.id === skill.id;

        return (
          <button
            key={skill.id}
            type="button"
            className={`archive-skill-card ${isSelected ? "is-selected" : ""}`}
            onClick={() => handleSkillSelect(skill)}
          >
            <span className="archive-skill-card-icon">
              <SkillIcon aria-hidden="true" />
            </span>
            <strong>{t(skill.labelKey)}</strong>
            <small>{`${t("home.skillPrefix")} · ${t(skill.metaKey)}`}</small>
            <p>{t(skill.summaryKey)}</p>
          </button>
        );
      })}
    </div>
  );

  const renderSelectedSkill = () => {
    const SelectedSkillIcon = selectedSkill.icon;

    return (
      <div className="archive-home-selected-skill">
        <span className="archive-skill-card-icon">
          <SelectedSkillIcon aria-hidden="true" />
        </span>
        <div>
          <span>{t("home.selectedSkill")}</span>
          <strong>{t(selectedSkill.labelKey)}</strong>
          <p>{t(selectedSkill.summaryKey)}</p>
        </div>
        <button type="button" onClick={() => prepareSkillTask(selectedSkill)}>
          {t("home.stageTask")}
        </button>
      </div>
    );
  };

  const renderPendingTask = () => {
    if (!pendingTask) {
      return null;
    }

    return (
      <div className="archive-home-staged-task" role="status">
        <span>{t("home.stagedTask")}</span>
        <strong>
          {t(getSkillById(pendingTask.skillId)?.labelKey ?? "skill.document.label")}
        </strong>
        <small>{getPendingTaskScopeLabel(pendingTask, t)}</small>
        <button type="button" onClick={() => onOpenWorkspace?.()}>
          {t("home.openWorkspace")}
        </button>
      </div>
    );
  };

  const renderDocumentList = ({ compareMode = false } = {}) => {
    if (documents.length === 0) {
      return (
        <div className="archive-home-empty-state">
          <strong>{t("home.emptyDocumentsTitle")}</strong>
          <span>{t("home.emptyDocumentsHint")}</span>
        </div>
      );
    }

    return (
      <div className="archive-home-document-list">
        {documents.map((document) => {
          const isChecked = compareDocIds.includes(document.docId);

          return (
            <label key={document.docId} className="archive-home-document-row">
              {compareMode ? (
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleCompareDocument(document.docId)}
                />
              ) : null}
              <span className="archive-home-document-icon">
                <FilePdfOutlined aria-hidden="true" />
              </span>
              <span className="archive-home-document-copy">
                <strong>{getDocumentLabel(document) ?? t("common.untitledDocument")}</strong>
                <small>{getDocumentPageLabel(document, t)}</small>
              </span>
            </label>
          );
        })}
      </div>
    );
  };

  const renderSkillsSection = () => (
    <section className="archive-home-section-grid" aria-label={t("home.documentSkills")}>
      <div className="archive-home-section">
        <div className="archive-home-section-head">
          <span>{t("home.skills")}</span>
          <strong>{t("home.skillCount", { count: DOCUMENT_SKILLS.length })}</strong>
        </div>
        {renderSkillGrid()}
      </div>
      <div className="archive-home-section archive-home-side-panel">
        {renderSelectedSkill()}
      </div>
    </section>
  );

  const renderWorkflowsSection = () => (
    <section
      className="archive-home-section-grid"
      aria-label={t("home.documentWorkflows")}
    >
      <div className="archive-home-section">
        <div className="archive-home-section-head">
          <span>{t("home.workflows")}</span>
          <strong>{t("home.templates", { count: WORKFLOW_TEMPLATES.length })}</strong>
        </div>
        <div className="archive-home-workflow-grid">
          {WORKFLOW_TEMPLATES.map((workflow) => {
            const skill = getSkillById(workflow.skillId);
            const isSelected = selectedSkill?.id === workflow.skillId;
            const WorkflowIcon = skill.icon;

            return (
              <button
                key={workflow.id}
                type="button"
                className={isSelected ? "is-selected" : ""}
                onClick={() => handleSkillSelect(skill)}
              >
                <span className="archive-home-workflow-icon">
                  <WorkflowIcon aria-hidden="true" />
                </span>
                <strong>{t(workflow.labelKey)}</strong>
                <span>{t(workflow.summaryKey)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="archive-home-section archive-home-compare-builder">
        <div className="archive-home-section-head">
          <span>{t("home.compareSetup")}</span>
          <strong>
            {t("home.selectedDocuments_plural", {
              count: selectedCompareDocuments.length,
            })}
          </strong>
        </div>
        {renderDocumentList({ compareMode: true })}
        <button
          type="button"
          className="archive-home-primary-action"
          disabled={compareDocIds.length < 2}
          onClick={prepareComparisonTask}
        >
          {compareDocIds.length < 2
            ? t("home.selectTwoDocuments")
            : t("home.stageComparison")}
        </button>
      </div>
    </section>
  );

  const renderDriveSection = () => (
    <section className="archive-home-section-grid" aria-label={t("workbench.workspaceDrive")}>
      {artifactSlot ? (
        <div className="archive-home-artifact-slot">{artifactSlot}</div>
      ) : null}
      <div className="archive-home-section">
        <div className="archive-home-section-head">
          <span>{t("home.drive")}</span>
          <strong>{t("common.docs", { count: documentCount })}</strong>
        </div>
        {renderDocumentList()}
      </div>
      <div className="archive-home-section archive-home-upload-panel">
        <div className="archive-home-section-head">
          <span>{t("home.upload")}</span>
          <button type="button" onClick={() => onOpenWorkspace?.()}>
            {t("home.openWorkspace")}
          </button>
        </div>
        {uploadSlot}
      </div>
    </section>
  );

  const renderRunsSection = () => (
    <section className="archive-home-section-grid" aria-label={t("home.recentRuns")}>
      <div className="archive-home-section">
        <div className="archive-home-section-head">
          <span>{t("home.recentRuns")}</span>
          <strong>{recentRuns.length}</strong>
        </div>
        {recentRuns.length > 0 ? (
          <div className="archive-home-run-list">
            {recentRuns.map((run, index) => (
              <button
                key={run.id ?? run.runId ?? `${run.label}-${index}`}
                type="button"
                onClick={() => onOpenWorkspace?.({ nav: "runs", view: "tasks" })}
              >
                <span>{run.status ?? "pending"}</span>
                <strong>{run.label ?? run.goal ?? t("home.agentRun")}</strong>
                <small>{run.summary ?? run.recovery?.reason ?? t("home.traceAvailable")}</small>
              </button>
            ))}
          </div>
        ) : (
          <div className="archive-home-empty-state">
            <strong>{t("home.noRunsTitle")}</strong>
            <span>{t("home.noRunsHint")}</span>
          </div>
        )}
      </div>
      <div className="archive-home-section archive-home-side-panel">
        <button
          type="button"
          className="archive-home-primary-action"
          onClick={() => onOpenWorkspace?.({ nav: "runs", view: "tasks" })}
        >
          {t("home.openRuns")}
        </button>
      </div>
    </section>
  );

  const renderMoreSection = () => (
    <section
      className="archive-home-section-grid"
      aria-label={t("workbench.workspaceDetails")}
    >
      <div className="archive-home-section">
        <div className="archive-home-section-head">
          <span>{t("home.facts")}</span>
          <strong>{t("home.currentIndex")}</strong>
        </div>
        <div className="archive-home-fact-grid">
          {WORKSPACE_STATS.map((stat) => (
            <button
              key={stat.id}
              type="button"
              onClick={() => handleNavigate(stat.id === "runs" ? "runs" : "drive")}
            >
              <span>{t(stat.labelKey)}</span>
              <strong>{statValues[stat.valueKey]}</strong>
            </button>
          ))}
        </div>
      </div>
      <div className="archive-home-section archive-home-side-panel">
        {renderSelectedSkill()}
      </div>
    </section>
  );

  const renderActiveSection = () => {
    if (activeSection === "skills") {
      return renderSkillsSection();
    }

    if (activeSection === "workflows") {
      return renderWorkflowsSection();
    }

    if (activeSection === "drive") {
      return renderDriveSection();
    }

    if (activeSection === "runs") {
      return renderRunsSection();
    }

    if (activeSection === "more") {
      return renderMoreSection();
    }

    return null;
  };

  return (
    <main
      className={`archive-home ${activeSection === "home" ? "is-home" : "is-compact"}`}
      aria-label={t("workbench.workspaceHome")}
      data-home-section={activeSection}
    >
      <header className="archive-home-nav">
        <button
          type="button"
          className="archive-home-brand"
          aria-label={t("home.brand")}
          onClick={() => handleNavigate("home")}
        >
          <span className="archive-home-brand-mark">A</span>
        </button>

        <nav aria-label={t("home.navigation")}>
          {HOME_NAV_ITEMS.map((item) => {
            const NavIcon = item.icon;

            return (
              <button
                key={item.id}
                type="button"
                aria-label={t(item.labelKey)}
                aria-current={activeSection === item.id ? "page" : undefined}
                className={[
                  activeSection === item.id ? "is-active" : "",
                  item.kind === "command" ? "is-command" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => handleNavigate(item.target)}
              >
                <NavIcon aria-hidden="true" />
                <span aria-hidden="true">
                  {t(item.shortLabelKey ?? item.labelKey)}
                </span>
              </button>
            );
          })}
        </nav>

        <div className="archive-home-nav-footer">
          <button
            type="button"
            className="archive-home-open-button"
            onClick={() => onOpenWorkspace?.()}
          >
            <FolderOpenOutlined aria-hidden="true" />
            <span>{t("home.openWorkspace")}</span>
          </button>
          {languageSlot}
        </div>
      </header>

      <section className="archive-home-hero">
        <div className="archive-home-title-block">
          <h1>{t("home.title")}</h1>
        </div>

        <div className="archive-home-task-input">{children}</div>

        <div
          className="archive-home-action-row"
          role="group"
          aria-label={t("home.capabilities")}
        >
          {CAPABILITY_GROUPS.map((group) => (
            <div className={`archive-home-action-group is-${group}`} key={group}>
              <span>{t(`home.group.${group}`)}</span>
              <div>
                {HOME_ACTIONS.filter((action) => action.group === group).map(
                  (action) => {
                    const ActionIcon = action.icon;

                    return (
                      <button
                        key={action.id}
                        type="button"
                        onClick={() => handleAction(action)}
                      >
                        <span className="archive-home-action-icon">
                          <ActionIcon aria-hidden="true" />
                        </span>
                        <strong>{t(action.labelKey)}</strong>
                      </button>
                    );
                  }
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {renderPendingTask()}

      {HOME_SECTION_IDS.includes(activeSection) ? renderActiveSection() : null}
    </main>
  );
};

export default WorkspaceEntryPanel;
