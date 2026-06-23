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
        }}
        qualityHistory={{
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
});
