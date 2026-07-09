import {
  BarChartOutlined,
  ExperimentOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { Button } from "antd";
import { createTranslator } from "../archiveI18n";

const formatQualityPercent = (value) =>
  typeof value === "number" ? `${value.toFixed(value % 1 === 0 ? 0 : 1)}%` : "N/A";

const formatQualityNumber = (value) =>
  typeof value === "number" ? value.toFixed(value % 1 === 0 ? 0 : 1) : "N/A";

const formatQualityDelta = (value, scale = 1) => {
  if (typeof value !== "number") {
    return "N/A";
  }

  const scaledValue = value * scale;
  const prefix = scaledValue > 0 ? "+" : "";
  return `${prefix}${scaledValue.toFixed(Math.abs(scaledValue) % 1 === 0 ? 0 : 1)}`;
};

const formatQualityGateDelta = (check, t = defaultT) => {
  if (!check) {
    return t("quality.noChecks");
  }

  if (check.metric === "failedCaseCount" || check.metric === "averageCitationCount") {
    return formatQualityDelta(check.delta);
  }

  if (typeof check.delta !== "number") {
    const value =
      check.currentValue ?? check.value ?? check.actual ?? check.threshold ?? null;

    return value === null || value === undefined
      ? check.status ?? "reported"
      : String(value);
  }

  return `${formatQualityDelta(check.delta, 100)} pts`;
};

const formatQualityDate = (value, locale = "en") => {
  if (!value) {
    return locale === "zh" ? "无日期" : "No date";
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
};

const defaultT = createTranslator("en");

const formatQualityGateStatus = (status, t = defaultT) =>
  ({
    fail: t("quality.fail"),
    idle: t("quality.idle"),
    ok: t("quality.ok"),
    pass: t("quality.pass"),
    skipped: t("quality.skipped"),
    unknown: t("quality.notReported"),
    warn: t("quality.warn"),
  }[status] ?? String(status ?? t("quality.notReported")));

const getPrimaryGateCheck = (gate) =>
  gate?.checks?.find((check) => check.status === "fail") ??
  gate?.checks?.find((check) => check.status === "warn") ??
  gate?.checks?.[0] ??
  null;

const normalizeGateStatus = (status) => status ?? "unknown";

const formatRecoveryPercent = (value) =>
  typeof value === "number" ? formatQualityPercent(value * 100) : "N/A";

const QualityGateCard = ({ gate, label = "Quality gate", t = defaultT }) => {
  if (!gate) {
    return (
      <div className="quality-gate quality-gate-unknown">
        <div className="quality-gate-head">
          <span>
            {label} {t("quality.notReported")}
          </span>
          <span>{t("quality.noChecks")}</span>
        </div>
        <p>{t("quality.gateUnknown")}</p>
      </div>
    );
  }

  const gateStatus = normalizeGateStatus(gate.status);
  const primaryGateCheck = getPrimaryGateCheck(gate);

  return (
    <div className={`quality-gate quality-gate-${gateStatus}`}>
      <div className="quality-gate-head">
        <span>
          {label} {formatQualityGateStatus(gateStatus, t)}
        </span>
        <span>{formatQualityGateDelta(primaryGateCheck, t)}</span>
      </div>
      <p>{gate.summary ?? t("quality.gateUnknown")}</p>
    </div>
  );
};

const RecoveryGateCard = ({ gate, t = defaultT }) => {
  if (!gate) {
    return null;
  }

  const recovery = gate.recovery ?? {};

  return (
    <div className={`quality-gate quality-gate-${normalizeGateStatus(gate.status)}`}>
      <div className="quality-gate-head">
        <span>
          {t("quality.recoveryGate")} {formatQualityGateStatus(gate.status, t)}
        </span>
        <span>{gate.skipped ? t("quality.skipped") : gate.currentRunId ?? t("common.latest")}</span>
      </div>
      <p>{gate.summary ?? t("quality.noRecoverySummary")}</p>
      <div className="quality-gate-metrics">
        <div>
          <span>{t("quality.replayFailures")}</span>
          <strong>{formatQualityNumber(recovery.stepReplayFailureCount)}</strong>
        </div>
        <div>
          <span>{t("quality.manualFailures")}</span>
          <strong>
            {formatQualityNumber(recovery.manualRecoveryActionFailureCount)}
          </strong>
        </div>
        <div>
          <span>{t("quality.autoReplay")}</span>
          <strong>{formatRecoveryPercent(recovery.autoReplaySuccessRate)}</strong>
        </div>
      </div>
    </div>
  );
};

const QualityGuardPanel = ({
  isQualityLoading,
  onLoadHistory,
  onLoadLatest,
  onRunSynthetic,
  qualityHistory,
  qualityReport,
  locale = "en",
  t = defaultT,
}) => {
  const metrics = qualityReport?.summary?.metrics ?? {};
  const failedCases = qualityReport?.failedCases ?? [];
  const recommendations = qualityReport?.recommendations ?? [];
  const regressionGate = qualityHistory?.regressionGate ?? null;
  const qualityGate = qualityHistory?.qualityGate ?? regressionGate;
  const recoveryGate = qualityHistory?.recoveryGate ?? null;
  const recentRuns = qualityHistory?.runs ?? [];
  const status = qualityReport?.status ?? "idle";
  const statusLabel =
    {
      ok: t("quality.ok"),
      warn: t("quality.warn"),
      fail: t("quality.fail"),
      idle: t("quality.idle"),
    }[status] ?? status;
  const gateStatus = normalizeGateStatus(qualityGate?.status);

  return (
    <div className="quality-panel">
      <div className="quality-actions">
        <Button
          aria-label={t("quality.latest")}
          className="archive-secondary-button quality-action-button"
          icon={<ReloadOutlined />}
          loading={isQualityLoading}
          onClick={() => void onLoadLatest()}
        >
          {t("quality.latest")}
        </Button>
        <Button
          aria-label={t("quality.history")}
          className="archive-secondary-button quality-action-button"
          icon={<BarChartOutlined />}
          loading={isQualityLoading}
          onClick={() => void onLoadHistory()}
        >
          {t("quality.history")}
        </Button>
        <Button
          aria-label={t("quality.runEval")}
          className="archive-secondary-button quality-action-button"
          icon={<ExperimentOutlined />}
          loading={isQualityLoading}
          onClick={() => void onRunSynthetic()}
        >
          {t("quality.runEval")}
        </Button>
      </div>

      {qualityReport ? (
        <>
          <div className={`quality-status quality-status-${status}`}>
            <span>{statusLabel}</span>
            <span>{qualityReport.summary?.runId ?? t("common.latestRun")}</span>
          </div>

          <div className={`quality-score-card quality-score-${gateStatus}`}>
            <div className="quality-score-ring">
              <strong>
                {typeof metrics.overallPassPercent === "number"
                  ? Math.round(metrics.overallPassPercent)
                  : "N/A"}
              </strong>
              <span>/100</span>
            </div>
            <div className="quality-score-copy">
              <strong>
                {t("quality.gateShort")} {formatQualityGateStatus(gateStatus, t)}
              </strong>
              <span>
                {qualityGate?.summary ??
                  t("quality.gateSummaryMissing")}
              </span>
            </div>
          </div>

          <div className="quality-metrics">
            <div className="quality-metric">
              <span>{t("quality.pass")}</span>
              <strong>{formatQualityPercent(metrics.overallPassPercent)}</strong>
            </div>
            <div className="quality-metric">
              <span>{t("quality.pageHit")}</span>
              <strong>{formatQualityPercent(metrics.qaPageHitPercent)}</strong>
            </div>
            <div className="quality-metric">
              <span>{t("quality.citations")}</span>
              <strong>{formatQualityNumber(metrics.averageCitationCount)}</strong>
            </div>
          </div>

          {failedCases.length > 0 ? (
            <div className="quality-failure-list">
              {failedCases.slice(0, 3).map((caseResult) => (
                <div key={caseResult.id} className="quality-failure-item">
                  <span>{caseResult.id}</span>
                  <p>{caseResult.reasons?.join(", ") ?? t("quality.caseFailed")}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="quality-empty-note">{t("quality.failedCasesEmpty")}</div>
          )}

          <div className="quality-recommendation-list">
            {recommendations.slice(0, 2).map((recommendation) => (
              <div key={recommendation.label} className="quality-recommendation-item">
                {recommendation.label}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="archive-empty-state archive-empty-state-compact">
          <div className="archive-empty-mark">{t("quality.emptyReport")}</div>
          <div>{t("quality.emptyHint")}</div>
        </div>
      )}

      <QualityGateCard gate={qualityGate} label={t("quality.gate")} t={t} />

      {regressionGate && qualityGate !== regressionGate ? (
        <QualityGateCard
          gate={regressionGate}
          label={t("quality.regressionGate")}
          t={t}
        />
      ) : null}

      <RecoveryGateCard gate={recoveryGate} t={t} />

      {recentRuns.length > 0 ? (
        <div className="quality-run-list">
          {recentRuns.slice(0, 3).map((run) => (
            <div key={`${run.runId}-${run.fileName}`} className="quality-run-item">
              <span>
                <strong>{formatQualityPercent(run.metrics?.overallPassPercent)}</strong>
                {run.status}
              </span>
              <span>{formatQualityDate(run.createdAt, locale)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default QualityGuardPanel;
