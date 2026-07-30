import { render, screen } from "@testing-library/react";
import QualityGuardPanel from "./QualityGuardPanel";

const noop = () => {};

describe("QualityGuardPanel", () => {
  test("renders backend quality and recovery gate facts without inferred copy", () => {
    render(
      <QualityGuardPanel
        isQualityLoading={false}
        onLoadHistory={noop}
        onLoadLatest={noop}
        onRunSynthetic={noop}
        qualityReport={{
          authoritativeForCurrentCommit: true,
          evidenceScope: "current",
          status: "warn",
          summary: {
            runId: "synthetic-latest",
            metrics: {
              averageCitationCount: 2.5,
              overallPassPercent: 88,
              qaPageHitPercent: 91,
            },
          },
          failedCases: [],
          recommendations: [],
          verification: {
            currentCommitVerified: true,
            scope: "current",
          },
        }}
        qualityHistory={{
          authoritativeForCurrentCommit: true,
          evidenceScope: "current",
          qualityGate: {
            status: "fail",
            summary: "Recovery observability failed 1 gate check.",
            checks: [
              {
                currentValue: 1,
                metric: "recoveryStepReplayFailureCount",
                status: "fail",
              },
            ],
          },
          recoveryGate: {
            currentRunId: "recovery-latest",
            status: "fail",
            summary:
              "Recovery observability failed 1 gate check; replay failures 1.",
            recovery: {
              autoReplaySuccessRate: 0.5,
              manualRecoveryActionFailureCount: 0,
              stepReplayFailureCount: 1,
            },
          },
          regressionGate: {
            status: "pass",
            summary: "Regression passed.",
            checks: [],
          },
          runs: [],
          verification: {
            currentCommitVerified: true,
            scope: "current",
          },
        }}
      />
    );

    expect(screen.getByText("Quality gate Fail")).toBeInTheDocument();
    expect(
      screen.getAllByText("Recovery observability failed 1 gate check.").length
    ).toBeGreaterThan(0);
    expect(screen.getByText("Recovery gate Fail")).toBeInTheDocument();
    expect(screen.getByText("recovery-latest")).toBeInTheDocument();
    expect(screen.getByText("Replay failures")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.queryByText("Excellent")).not.toBeInTheDocument();
  });

  test("labels legacy quality results as historical rather than current evidence", () => {
    render(
      <QualityGuardPanel
        isQualityLoading={false}
        onLoadHistory={noop}
        onLoadLatest={noop}
        onRunSynthetic={noop}
        qualityReport={{
          authoritativeForCurrentCommit: false,
          evidenceScope: "historical",
          status: "ok",
          summary: {
            runId: "old-pass",
            metrics: {
              overallPassPercent: 100,
            },
          },
          failedCases: [],
          recommendations: [],
          verification: {
            currentCommitVerified: false,
            scope: "historical",
          },
        }}
        qualityHistory={{
          authoritativeForCurrentCommit: false,
          evidenceScope: "historical",
          qualityGate: {
            status: "pass",
            summary: "No regression was found in the stored snapshot.",
            checks: [],
          },
          runs: [],
          verification: {
            currentCommitVerified: false,
            scope: "historical",
          },
        }}
      />
    );

    expect(screen.getByText("Historical snapshot Pass")).toBeInTheDocument();
    expect(
      screen.getByText("Historical quality snapshot Pass")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Historical evaluation only; it is not evidence for the current commit."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("Quality gate Pass")).not.toBeInTheDocument();
  });

  test("requires both the displayed report and history gate to be current", () => {
    render(
      <QualityGuardPanel
        isQualityLoading={false}
        onLoadHistory={noop}
        onLoadLatest={noop}
        onRunSynthetic={noop}
        qualityReport={{
          authoritativeForCurrentCommit: true,
          evidenceScope: "current",
          status: "ok",
          summary: {
            metrics: {
              overallPassPercent: 100,
            },
          },
          failedCases: [],
          recommendations: [],
          verification: {
            currentCommitVerified: false,
            scope: "historical",
          },
        }}
        qualityHistory={{
          qualityGate: {
            status: "pass",
            checks: [],
          },
          runs: [],
          verification: {
            currentCommitVerified: true,
            scope: "current",
          },
        }}
      />
    );

    expect(
      screen.getByText(
        "Historical evaluation only; it is not evidence for the current commit."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Historical snapshot Pass")).toBeInTheDocument();
  });

  test("fails closed when an older backend omits the verification marker", () => {
    render(
      <QualityGuardPanel
        isQualityLoading={false}
        onLoadHistory={noop}
        onLoadLatest={noop}
        onRunSynthetic={noop}
        qualityReport={{
          status: "ok",
          summary: {
            metrics: {
              overallPassPercent: 100,
            },
          },
          failedCases: [],
          recommendations: [],
        }}
        qualityHistory={{
          authoritativeForCurrentCommit: true,
          evidenceScope: "current",
          qualityGate: {
            status: "pass",
            checks: [],
          },
          runs: [],
        }}
      />
    );

    expect(screen.getByText("Unverified snapshot Pass")).toBeInTheDocument();
    expect(
      screen.getByText("Unverified quality snapshot Pass")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This evaluation is not verified against the current commit."
      )
    ).toBeInTheDocument();
  });

  test("does not let a root scope complete an incomplete canonical marker", () => {
    render(
      <QualityGuardPanel
        isQualityLoading={false}
        onLoadHistory={noop}
        onLoadLatest={noop}
        onRunSynthetic={noop}
        qualityReport={{
          evidenceScope: "current",
          status: "ok",
          summary: {
            metrics: {
              overallPassPercent: 100,
            },
          },
          failedCases: [],
          recommendations: [],
          verification: {
            currentCommitVerified: true,
          },
        }}
        qualityHistory={null}
      />
    );

    expect(
      screen.getByText("Unverified snapshot Not reported")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This evaluation is not verified against the current commit."
      )
    ).toBeInTheDocument();
  });
});
