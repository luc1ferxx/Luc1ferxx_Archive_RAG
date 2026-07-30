import React from "react";

const toArray = (value) => (Array.isArray(value) ? value : []);

const formatPreviewValue = (value) => {
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
      return "Preview unavailable";
    }
  }

  return String(value);
};

const formatRiskFlag = (value) =>
  String(value ?? "")
    .replaceAll("_", " ")
    .trim();

const ApprovalGatePreviewList = ({
  ariaLabel = "Pending approvals",
  gates = [],
}) => {
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
      <div className="archive-source-section-label">Pending approval</div>
      <div className="archive-approval-copy">
        Only policy-approved fields are shown. Long values and lists may be
        truncated or hidden; approval remains bound to the full input.
      </div>
      {pendingGates.map((gate, gateIndex) => {
        const previewEntries = Object.entries(
          gate?.inputPreview &&
            typeof gate.inputPreview === "object" &&
            !Array.isArray(gate.inputPreview)
            ? gate.inputPreview
            : {}
        );
        const riskFlags = toArray(gate?.riskFlags)
          .map(formatRiskFlag)
          .filter(Boolean);

        return (
          <div
            className="archive-approval-item"
            key={gate?.id ?? gate?.capabilityId ?? gateIndex}
          >
            <div className="archive-approval-head">
              <strong>
                {gate?.capabilityLabel ??
                  gate?.capabilityId ??
                  "Capability"}
              </strong>
              <span>{gate?.status ?? "pending"}</span>
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
                    <strong>{formatPreviewValue(value)}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <div className="archive-approval-copy">
                Input preview hidden by policy.
              </div>
            )}
            {riskFlags.length > 0 ? (
              <div className="archive-approval-risk-list">
                {riskFlags.map((flag) => (
                  <span className="archive-answer-chip is-warning" key={flag}>
                    {flag}
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
