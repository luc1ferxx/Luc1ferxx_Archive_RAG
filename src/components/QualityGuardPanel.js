import {
  BarChartOutlined,
  ExperimentOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { Button } from "antd";

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

const formatQualityGateDelta = (check) => {
  if (!check) {
    return "No checks";
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

const formatQualityDate = (value) => {
  if (!value) {
    return "No date";
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

const formatQualityGateStatus = (status) =>
  ({
    fail: "Fail",
    idle: "Idle",
    ok: "OK",
    pass: "Pass",
    skipped: "Skipped",
    unknown: "Not reported",
    warn: "Warn",
  }[status] ?? String(status ?? "Not reported"));

const getPrimaryGateCheck = (gate) =>
  gate?.checks?.find((check) => check.status === "fail") ??
  gate?.checks?.find((check) => check.status === "warn") ??
  gate?.checks?.[0] ??
  null;

const normalizeGateStatus = (status) => status ?? "unknown";

const formatRecoveryPercent = (value) =>
  typeof value === "number" ? formatQualityPercent(value * 100) : "N/A";

const QualityGateCard = ({ gate, label = "Quality gate" }) => {
  if (!gate) {
    return (
      <div className="quality-gate quality-gate-unknown">
        <div className="quality-gate-head">
          <span>{label} not reported</span>
          <span>No checks</span>
        </div>
        <p>No backend gate state is loaded.</p>
      </div>
    );
  }

  const gateStatus = normalizeGateStatus(gate.status);
  const primaryGateCheck = getPrimaryGateCheck(gate);

  return (
    <div className={`quality-gate quality-gate-${gateStatus}`}>
      <div className="quality-gate-head">
        <span>
          {label} {formatQualityGateStatus(gateStatus)}
        </span>
        <span>{formatQualityGateDelta(primaryGateCheck)}</span>
      </div>
      <p>{gate.summary ?? "No backend gate summary is available."}</p>
    </div>
  );
};

const RecoveryGateCard = ({ gate }) => {
  if (!gate) {
    return null;
  }

  const recovery = gate.recovery ?? {};

  return (
    <div className={`quality-gate quality-gate-${normalizeGateStatus(gate.status)}`}>
      <div className="quality-gate-head">
        <span>Recovery gate {formatQualityGateStatus(gate.status)}</span>
        <span>{gate.skipped ? "Skipped" : gate.currentRunId ?? "latest"}</span>
      </div>
      <p>{gate.summary ?? "No recovery gate summary is available."}</p>
      <div className="quality-gate-metrics">
        <div>
          <span>Replay failures</span>
          <strong>{formatQualityNumber(recovery.stepReplayFailureCount)}</strong>
        </div>
        <div>
          <span>Manual failures</span>
          <strong>
            {formatQualityNumber(recovery.manualRecoveryActionFailureCount)}
          </strong>
        </div>
        <div>
          <span>Auto replay</span>
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
      ok: "OK",
      warn: "Warn",
      fail: "Fail",
      idle: "Idle",
    }[status] ?? status;
  const gateStatus = normalizeGateStatus(qualityGate?.status);

  return (
    <div className="quality-panel">
      <div className="quality-actions">
        <Button
          aria-label="Latest"
          className="archive-secondary-button quality-action-button"
          icon={<ReloadOutlined />}
          loading={isQualityLoading}
          onClick={() => void onLoadLatest()}
        >
          Latest
        </Button>
        <Button
          aria-label="History"
          className="archive-secondary-button quality-action-button"
          icon={<BarChartOutlined />}
          loading={isQualityLoading}
          onClick={() => void onLoadHistory()}
        >
          History
        </Button>
        <Button
          aria-label="Run eval"
          className="archive-secondary-button quality-action-button"
          icon={<ExperimentOutlined />}
          loading={isQualityLoading}
          onClick={() => void onRunSynthetic()}
        >
          Run eval
        </Button>
      </div>

      {qualityReport ? (
        <>
          <div className={`quality-status quality-status-${status}`}>
            <span>{statusLabel}</span>
            <span>{qualityReport.summary?.runId ?? "latest run"}</span>
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
              <strong>Gate {formatQualityGateStatus(gateStatus)}</strong>
              <span>
                {qualityGate?.summary ??
                  "No backend quality gate summary is loaded."}
              </span>
            </div>
          </div>

          <div className="quality-metrics">
            <div className="quality-metric">
              <span>Pass</span>
              <strong>{formatQualityPercent(metrics.overallPassPercent)}</strong>
            </div>
            <div className="quality-metric">
              <span>Page hit</span>
              <strong>{formatQualityPercent(metrics.qaPageHitPercent)}</strong>
            </div>
            <div className="quality-metric">
              <span>Citations</span>
              <strong>{formatQualityNumber(metrics.averageCitationCount)}</strong>
            </div>
          </div>

          {failedCases.length > 0 ? (
            <div className="quality-failure-list">
              {failedCases.slice(0, 3).map((caseResult) => (
                <div key={caseResult.id} className="quality-failure-item">
                  <span>{caseResult.id}</span>
                  <p>{caseResult.reasons?.join(", ") ?? "Case failed"}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="quality-empty-note">No failed cases in the latest run.</div>
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
          <div className="archive-empty-mark">No quality report loaded</div>
          <div>Load the latest report or run the default synthetic corpus.</div>
        </div>
      )}

      <QualityGateCard gate={qualityGate} label="Quality gate" />

      {regressionGate && qualityGate !== regressionGate ? (
        <QualityGateCard gate={regressionGate} label="Regression gate" />
      ) : null}

      <RecoveryGateCard gate={recoveryGate} />

      {recentRuns.length > 0 ? (
        <div className="quality-run-list">
          {recentRuns.slice(0, 3).map((run) => (
            <div key={`${run.runId}-${run.fileName}`} className="quality-run-item">
              <span>
                <strong>{formatQualityPercent(run.metrics?.overallPassPercent)}</strong>
                {run.status}
              </span>
              <span>{formatQualityDate(run.createdAt)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default QualityGuardPanel;
