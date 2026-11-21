import React from "react";
import { formatStatusLabel } from "./workbenchFormatters";

const toArray = (value) => (Array.isArray(value) ? value : []);

const formatPreviewValue = (value, t) => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return t("preview.unavailable");
    }
  }

  return String(value);
};

const ApprovalGatePreviewList = ({ ariaLabel, gates = [], t }) => {
  const pendingGates = toArray(gates).filter(
    (gate) => (gate?.status ?? "pending") === "pending"
  );

  if (pendingGates.length === 0) {
    return null;
  }

  return (
    <section
      aria-label={ariaLabel}
      className="archive-approval-panel"
    >
      <div className="archive-source-section-label">{t("run.pendingApproval")}</div>
      <div className="archive-approval-copy">{t("run.previewPolicy")}</div>
      {pendingGates.map((gate, gateIndex) => {
        const previewEntries = Object.entries(
          gate?.inputPreview &&
            typeof gate.inputPreview === "object" &&
            !Array.isArray(gate.inputPreview)
            ? gate.inputPreview
            : {}
        );
        const riskFlags = toArray(gate?.riskFlags).filter(Boolean);

        return (
          <div
            className="archive-approval-item"
            key={gate?.id ?? gate?.capabilityId ?? gateIndex}
          >
            <div className="archive-approval-head">
              <strong>
                {gate?.capabilityLabel ?? gate?.capabilityId ?? t("run.capability")}
              </strong>
              <span>{formatStatusLabel(gate?.status, t)}</span>
            </div>
            {gate?.reason ? (
              <div className="archive-approval-copy">{gate.reason}</div>
            ) : null}
            {previewEntries.length > 0 ? (
              <div className="archive-approval-preview">
                {previewEntries.map(([field, value]) => (
                  <div
                    className="archive-approval-preview-row"
                    key={field}
                  >
                    <span>{field}</span>
                    <strong>{formatPreviewValue(value, t)}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <div className="archive-approval-copy">{t("run.inputHidden")}</div>
            )}
            {riskFlags.length > 0 ? (
              <div className="archive-approval-risk-list">
                {riskFlags.map((flag) => (
                  <span className="archive-answer-chip is-warning" key={flag}>
                    {formatStatusLabel(flag, t)}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
};

export default React.memo(ApprovalGatePreviewList);
