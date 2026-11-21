import { render, screen, within } from "@testing-library/react";
import { createTranslator } from "../archiveI18n";
import WorkspaceEntryPanel from "./WorkspaceEntryPanel";

describe("WorkspaceEntryPanel recent runs", () => {
  test("shows a run's status and recovery reason as labels in the app's language", () => {
    const props = {
      activeSection: "runs",
      // One array for every render: the panel prunes its picks whenever its
      // documents prop changes.
      documents: [],
      recoveryRuns: [
        {
          goal: "Search the web for the launch date.",
          recovery: { reason: "failed_step_ready" },
          runId: "run-failed",
          status: "failed",
        },
      ],
      tasks: [{ id: "task-arxiv", label: "arXiv recommendations", status: "waiting_for_user" }],
    };
    const getRuns = () => within(document.querySelector(".archive-home-run-list"));
    const { rerender } = render(
      <WorkspaceEntryPanel {...props} t={createTranslator("en")} />
    );

    expect(getRuns().getByText("Waiting for user")).toBeInTheDocument();
    expect(getRuns().getByText("Failed")).toBeInTheDocument();
    expect(getRuns().getByText("A failed step can be retried")).toBeInTheDocument();
    expect(getRuns().queryByText(/waiting_for_user|failed_step_ready/)).toBeNull();

    rerender(<WorkspaceEntryPanel {...props} t={createTranslator("zh")} />);

    expect(getRuns().getByText("等待用户处理")).toBeInTheDocument();
    expect(getRuns().getByText("失败的步骤可以重试")).toBeInTheDocument();
  });
});
