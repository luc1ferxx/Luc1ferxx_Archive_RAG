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
  SafetyCertificateOutlined,
} from "@ant-design/icons";

const HOME_SECTION_IDS = ["home", "skills", "workflows", "drive", "runs", "more"];

const HOME_NAV_ITEMS = [
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

const HOME_ACTIONS = [
  {
    id: "upload",
    labelKey: "home.action.upload",
    icon: CloudUploadOutlined,
    type: "upload",
  },
  {
    id: "qa",
    labelKey: "home.action.citedQa",
    icon: FileSearchOutlined,
    skillId: "document_rag",
    target: "skills",
  },
  {
    id: "compare",
    labelKey: "home.action.compare",
    icon: BranchesOutlined,
    skillId: "compare_documents",
    target: "workflows",
  },
  {
    id: "risk",
    labelKey: "home.action.risk",
    icon: SafetyCertificateOutlined,
    skillId: "risk_review",
    target: "workflows",
  },
  {
    id: "timeline",
    labelKey: "home.action.timeline",
    icon: AuditOutlined,
    skillId: "extract_timeline",
    target: "workflows",
  },
  {
    id: "runs",
    labelKey: "home.action.viewRuns",
    icon: PlayCircleOutlined,
    target: "runs",
  },
];

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

const DOCUMENT_SKILLS = [
  {
    id: "document_rag",
    labelKey: "skill.document.label",
    metaKey: "skill.document.meta",
    icon: FileSearchOutlined,
    summaryKey: "skill.document.summary",
  },
  {
    id: "compare_documents",
    labelKey: "skill.compare.label",
    metaKey: "skill.compare.meta",
    icon: BranchesOutlined,
    summaryKey: "skill.compare.summary",
  },
  {
    id: "risk_review",
    labelKey: "skill.risk.label",
    metaKey: "skill.risk.meta",
    icon: SafetyCertificateOutlined,
    summaryKey: "skill.risk.summary",
  },
  {
    id: "extract_timeline",
    labelKey: "skill.timeline.label",
    metaKey: "skill.timeline.meta",
    icon: AuditOutlined,
    summaryKey: "skill.timeline.summary",
  },
  {
    id: "summarize_contract",
    labelKey: "skill.contract.label",
    metaKey: "skill.contract.meta",
    icon: FileDoneOutlined,
    summaryKey: "skill.contract.summary",
  },
];

const WORKFLOW_TEMPLATES = [
  {
    id: "compare",
    labelKey: "workflow.compare.label",
    skillId: "compare_documents",
    summaryKey: "workflow.compare.summary",
  },
  {
    id: "risk",
    labelKey: "workflow.risk.label",
    skillId: "risk_review",
    summaryKey: "workflow.risk.summary",
  },
  {
    id: "timeline",
    labelKey: "workflow.timeline.label",
    skillId: "extract_timeline",
    summaryKey: "workflow.timeline.summary",
  },
];

const SKILL_DRAFT_KEYS = {
  compare_documents: "workflow.compare.draft",
  risk_review: "workflow.risk.draft",
  extract_timeline: "workflow.timeline.draft",
  summarize_contract: "workflow.contract.draft",
  document_rag: "workflow.document.draft",
};

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
  t(SKILL_DRAFT_KEYS[skill?.id] ?? SKILL_DRAFT_KEYS.document_rag);

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
  children,
  documentCount = 0,
  documents = [],
  onNavigate,
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

  const renderHomeSection = () => (
    <section
      className="archive-home-section-grid archive-home-overview-grid"
      aria-label={t("workbench.workspaceOverview")}
    >
      <div className="archive-home-section">
        <div className="archive-home-section-head">
          <span>{t("home.documentSkills")}</span>
          <button type="button" onClick={() => handleNavigate("skills")}>
            {t("home.viewAll")}
          </button>
        </div>
        {renderSkillGrid()}
      </div>
      <div className="archive-home-section archive-home-side-panel">
        {renderSelectedSkill()}
        <button
          type="button"
          className="archive-home-primary-action"
          onClick={() => handleNavigate("workflows")}
        >
          {t("home.buildWorkflow")}
        </button>
      </div>
    </section>
  );

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

    return renderHomeSection();
  };

  return (
    <main className="archive-home" aria-label={t("workbench.workspaceHome")}>
      <header className="archive-home-nav">
        <button
          type="button"
          className="archive-home-brand"
          onClick={() => handleNavigate("home")}
        >
          <span className="archive-home-brand-mark">A</span>
          <strong>{t("home.brand")}</strong>
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
                className={activeSection === item.id ? "is-active" : ""}
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

        {languageSlot}

        <button
          type="button"
          className="archive-home-open-button"
          onClick={() => onOpenWorkspace?.()}
        >
          {t("home.openWorkspace")}
        </button>
      </header>

      <section className="archive-home-hero">
        <div className="archive-home-title-block">
          <span>{t("home.subtitle")}</span>
          <h1>{t("home.title")}</h1>
        </div>

        <div className="archive-home-task-input">{children}</div>

        <div className="archive-home-action-row">
          {HOME_ACTIONS.map((action) => {
            const ActionIcon = action.icon;

            return (
              <button
                key={action.id}
                type="button"
                onClick={() => handleAction(action)}
              >
                <ActionIcon aria-hidden="true" />
                {t(action.labelKey)}
              </button>
            );
          })}
        </div>
      </section>

      {renderPendingTask()}

      {HOME_SECTION_IDS.includes(activeSection)
        ? renderActiveSection()
        : renderHomeSection()}
    </main>
  );
};

export default WorkspaceEntryPanel;
