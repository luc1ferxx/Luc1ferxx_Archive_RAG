import {
  ClusterOutlined,
  DownloadOutlined,
  FileDoneOutlined,
  FileTextOutlined,
  InboxOutlined,
  ReloadOutlined,
} from "@ant-design/icons";

import { useWorkspaceArtifacts } from "../hooks/useWorkspaceArtifacts";

const defaultT = (key, values = {}) =>
  Object.entries(values).reduce(
    (result, [valueKey, value]) => result.split(`{${valueKey}}`).join(value),
    key
  );

const TYPE_CONFIG = {
  document_collection: {
    icon: ClusterOutlined,
    labelKey: "artifact.type.collection",
  },
  report: {
    icon: FileTextOutlined,
    labelKey: "artifact.type.report",
  },
  summary: {
    icon: FileDoneOutlined,
    labelKey: "artifact.type.summary",
  },
};

const getTypeConfig = (artifactType) =>
  TYPE_CONFIG[artifactType] ?? TYPE_CONFIG.report;

const formatDate = (value, locale) => {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return value || "—";
  }

  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(timestamp);
};

const WorkspaceArtifactsPanel = ({ locale = "en", t = defaultT }) => {
  const {
    action,
    actionError,
    archiveArtifact,
    artifacts,
    detailError,
    downloadArtifact,
    error,
    isDetailLoading,
    isListLoading,
    isLoadingMore,
    loadArtifacts,
    loadMoreArtifacts,
    loadMoreError,
    retryDetail,
    selectedArtifact,
    selectedArtifactId,
    selectArtifact,
    setStatus,
    status,
    total,
  } = useWorkspaceArtifacts({ t });

  const renderListState = () => {
    if (isListLoading) {
      return (
        <div className="archive-home-artifact-state" role="status">
          <span className="archive-home-artifact-pulse" aria-hidden="true" />
          <strong>{t("artifact.loading")}</strong>
        </div>
      );
    }

    if (error) {
      return (
        <div className="archive-home-artifact-state is-error" role="alert">
          <strong>{t("artifact.unavailable")}</strong>
          <span>{error}</span>
          <button type="button" onClick={() => void loadArtifacts()}>
            <ReloadOutlined aria-hidden="true" />
            {t("artifact.tryAgain")}
          </button>
        </div>
      );
    }

    if (artifacts.length === 0) {
      return (
        <div className="archive-home-artifact-state">
          <InboxOutlined aria-hidden="true" />
          <strong>{t("artifact.emptyTitle")}</strong>
          <span>{t("artifact.emptyHint")}</span>
        </div>
      );
    }

    return (
      <div className="archive-home-artifact-list-shell">
        <div className="archive-home-artifact-list">
          {artifacts.map((artifact) => {
            const typeConfig = getTypeConfig(artifact.artifactType);
            const TypeIcon = typeConfig.icon;

            return (
              <button
                key={artifact.artifactId}
                type="button"
                aria-label={artifact.title}
                aria-current={
                  selectedArtifactId === artifact.artifactId ? "true" : undefined
                }
                className={[
                  `is-${artifact.artifactType}`,
                  selectedArtifactId === artifact.artifactId ? "is-selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => selectArtifact(artifact.artifactId)}
              >
                <span className="archive-home-artifact-type-icon">
                  <TypeIcon aria-hidden="true" />
                </span>
                <span className="archive-home-artifact-row-copy">
                  <small>{t(typeConfig.labelKey)}</small>
                  <strong>{artifact.title}</strong>
                  <span>
                    {t("artifact.rowMeta", {
                      citations: artifact.citationCount ?? 0,
                      date: formatDate(artifact.createdAt, locale),
                      docs: artifact.docCount ?? 0,
                    })}
                  </span>
                  <span className="archive-home-artifact-row-context">
                    {t("artifact.rowContext", {
                      status: t(`artifact.status.${artifact.status}`),
                      task: artifact.sourceTaskId || "—",
                    })}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {loadMoreError ? (
          <p className="archive-home-artifact-page-error" role="alert">
            {loadMoreError}
          </p>
        ) : null}
        {artifacts.length < total ? (
          <button
            type="button"
            className="archive-home-artifact-load-more"
            disabled={isLoadingMore}
            aria-busy={isLoadingMore}
            onClick={() => void loadMoreArtifacts()}
          >
            <ReloadOutlined aria-hidden="true" />
            {isLoadingMore
              ? t("artifact.loadingMore")
              : t("artifact.loadMore")}
          </button>
        ) : null}
      </div>
    );
  };

  const renderDetail = () => {
    if (isDetailLoading) {
      return (
        <div className="archive-home-artifact-detail-state" role="status">
          {t("artifact.detailLoading")}
        </div>
      );
    }

    if (detailError) {
      return (
        <div className="archive-home-artifact-detail-state is-error" role="alert">
          <strong>{t("artifact.unavailable")}</strong>
          <span>{detailError}</span>
          <button type="button" onClick={retryDetail}>
            <ReloadOutlined aria-hidden="true" />
            {t("artifact.tryAgain")}
          </button>
        </div>
      );
    }

    if (!selectedArtifact) {
      return (
        <div className="archive-home-artifact-detail-state">
          {t("artifact.noSelection")}
        </div>
      );
    }

    const typeConfig = getTypeConfig(selectedArtifact.artifactType);
    const isActionRunning = Boolean(action);
    const isArchiveRunning =
      action?.artifactId === selectedArtifact.artifactId &&
      action.type === "archive";
    const isDownloadRunning =
      action?.artifactId === selectedArtifact.artifactId &&
      action.type === "download";
    const structuredPayload = JSON.stringify(
      selectedArtifact.payload ?? {},
      null,
      2
    );

    return (
      <article
        className={`archive-home-artifact-detail is-${selectedArtifact.artifactType}`}
      >
        <div className="archive-home-artifact-provenance">
          <span>{t("artifact.generated")}</span>
          <strong>{t("artifact.notEvidence")}</strong>
        </div>

        <div className="archive-home-artifact-detail-head">
          <span>{t(typeConfig.labelKey)}</span>
          <h2>{selectedArtifact.title}</h2>
          <p>
            {t("artifact.detailMeta", {
              citations: selectedArtifact.citationCount ?? 0,
              docs:
                selectedArtifact.docCount ??
                selectedArtifact.docIds?.length ??
                0,
              version: selectedArtifact.version || "1.0.0",
            })}
          </p>
        </div>

        <div className="archive-home-artifact-body">
          <span>
            {selectedArtifact.content
              ? t("artifact.content")
              : t("artifact.payload")}
          </span>
          <pre>
            {selectedArtifact.content ||
              structuredPayload ||
              t("artifact.emptyBody")}
          </pre>
        </div>

        <dl className="archive-home-artifact-meta">
          <div>
            <dt>{t("artifact.status")}</dt>
            <dd>{t(`artifact.status.${selectedArtifact.status}`)}</dd>
          </div>
          <div>
            <dt>{t("artifact.sourceRun")}</dt>
            <dd>{selectedArtifact.sourceRunId || "—"}</dd>
          </div>
          <div>
            <dt>{t("artifact.sourceTask")}</dt>
            <dd>{selectedArtifact.sourceTaskId || "—"}</dd>
          </div>
          <div>
            <dt>{t("artifact.created")}</dt>
            <dd>{formatDate(selectedArtifact.createdAt, locale)}</dd>
          </div>
        </dl>

        {actionError?.artifactId === selectedArtifact.artifactId ? (
          <p className="archive-home-artifact-action-error" role="alert">
            {actionError.message}
          </p>
        ) : null}

        <div className="archive-home-artifact-actions">
          <button
            type="button"
            className="is-primary"
            disabled={isActionRunning}
            aria-busy={isDownloadRunning}
            onClick={() => void downloadArtifact(selectedArtifact)}
          >
            <DownloadOutlined aria-hidden="true" />
            {isDownloadRunning
              ? t("artifact.working")
              : t("artifact.download")}
          </button>
          {selectedArtifact.status === "active" ? (
            <button
              type="button"
              disabled={isActionRunning}
              aria-busy={isArchiveRunning}
              onClick={() => void archiveArtifact(selectedArtifact.artifactId)}
            >
              <InboxOutlined aria-hidden="true" />
              {isArchiveRunning
                ? t("artifact.working")
                : t("artifact.archive")}
            </button>
          ) : null}
        </div>
      </article>
    );
  };

  return (
    <section
      className="archive-home-artifacts"
      aria-label={t("artifact.region")}
      aria-busy={Boolean(action)}
    >
      <header className="archive-home-artifacts-head">
        <div>
          <span>{t("artifact.eyebrow")}</span>
          <strong>{t("artifact.title")}</strong>
        </div>
        <div
          className="archive-home-artifact-filters"
          role="group"
          aria-label={t("artifact.filter")}
        >
          {["active", "archived"].map((filterStatus) => (
            <button
              key={filterStatus}
              type="button"
              aria-pressed={status === filterStatus}
              onClick={() => setStatus(filterStatus)}
            >
              {t(`artifact.status.${filterStatus}`)}
            </button>
          ))}
        </div>
        <span className="archive-home-artifact-count">
          {t("artifact.count", { count: total })}
        </span>
      </header>

      <div className="archive-home-artifact-layout">
        <div className="archive-home-artifact-index">{renderListState()}</div>
        <div className="archive-home-artifact-preview">{renderDetail()}</div>
      </div>
    </section>
  );
};

export default WorkspaceArtifactsPanel;
