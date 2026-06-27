import { fireEvent, render, screen } from "@testing-library/react";
import AgentRunCenter from "./AgentRunCenter";

describe("AgentRunCenter", () => {
  test("renders goal plan steps from the task contract", () => {
    render(
      <AgentRunCenter
        tasks={[
          {
            id: "agent_goal:1",
            type: "agent_goal",
            status: "waiting_for_user",
            label: "Agent task",
            summary: "Agent task is waiting for capability approval.",
            requiredUserAction: "approve_capability",
            result: {
              approvalGates: [
                {
                  capabilityId: "web.search",
                },
              ],
              goalPlan: {
                completedIterations: 1,
                counts: {
                  completed: 2,
                  total: 4,
                },
                deliverables: {
                  counts: {
                    planned: 2,
                  },
                  items: [
                    {
                      capabilityId: "report.export",
                      id: "markdown_report:report.export",
                      label: "Markdown report",
                      output: {
                        fileName: "risk-report.md",
                      },
                      status: "completed",
                      summary: "Prepared report export risk-report.md.",
                    },
                  ],
                  status: "completed",
                },
                goalCompletion: {
                  checks: [
                    {
                      id: "plan_steps_completed",
                      label: "All public plan steps completed",
                      passed: false,
                    },
                    {
                      id: "no_pending_user_action",
                      label: "No pending approval or user action remains",
                      passed: false,
                    },
                  ],
                  status: "pending",
                  summary: "Goal completion checks are waiting for user action.",
                },
                goal: "Research renewal risk.",
                maxIterations: 3,
                researchTask: {
                  counts: {
                    completed: 1,
                    total: 2,
                  },
                  phases: [
                    {
                      id: "local_research",
                      label: "Local document research",
                      status: "completed",
                      summary: "Search selected local documents.",
                    },
                    {
                      id: "web_supplement",
                      label: "Web supplement",
                      status: "running",
                      summary: "Use current web context.",
                    },
                  ],
                  status: "running",
                },
                status: "waiting_for_user",
              },
            },
            items: [
              {
                id: "goal",
                label: "Goal",
                status: "completed",
                summary: "Research renewal risk.",
              },
              {
                id: "iteration-1",
                label: "Agent step 1",
                status: "completed",
                summary: "Renewal terms found.",
              },
              {
                id: "user-input",
                label: "Approval required",
                status: "waiting_for_user",
                summary: "Approve Web Search?",
              },
            ],
          },
        ]}
      />
    );

    expect(screen.getByText("Agent Run Center")).toBeInTheDocument();
    expect(screen.getAllByText("Research renewal risk.").length).toBeGreaterThan(
      0
    );
    expect(screen.getByText("2/4 done")).toBeInTheDocument();
    expect(screen.getByText("1/3 runs")).toBeInTheDocument();
    expect(screen.getByText("Agent step 1")).toBeInTheDocument();
    expect(screen.getByText("Approval required")).toBeInTheDocument();
    expect(screen.getByText("Local document research")).toBeInTheDocument();
    expect(screen.getByText("Web supplement")).toBeInTheDocument();
    expect(screen.getByText("Markdown report")).toBeInTheDocument();
    expect(
      screen.getByText("Prepared report export risk-report.md.")
    ).toBeInTheDocument();
    expect(screen.getByText("Goal completion")).toBeInTheDocument();
    expect(
      screen.getByText("All public plan steps completed")
    ).toBeInTheDocument();
    expect(
      screen.getByText("No pending approval or user action remains")
    ).toBeInTheDocument();
  });

  test("forwards approval actions through the task action callback", () => {
    const onTaskAction = jest.fn();
    const task = {
      id: "agent_goal:approval",
      type: "agent_goal",
      status: "waiting_for_user",
      label: "Agent task",
      requiredUserAction: "approve_capability",
      result: {
        approvalGates: [
          {
            capabilityId: "web.search",
          },
        ],
        goalPlan: {
          counts: {
            completed: 1,
            total: 3,
          },
          goal: "Check web updates.",
          status: "waiting_for_user",
        },
      },
      items: [],
    };

    render(<AgentRunCenter onTaskAction={onTaskAction} tasks={[task]} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onTaskAction).toHaveBeenCalledWith(task, "approve", {
      approval: {
        approved: true,
        decision: "approved",
        source: "agent_run_center",
      },
      capabilityId: "web.search",
    });
  });

  test("forwards deliverable approval through the task action callback", () => {
    const onTaskAction = jest.fn();
    const task = {
      id: "agent_goal:deliverables",
      type: "agent_goal",
      status: "waiting_for_user",
      label: "Agent task",
      requiredUserAction: "approve_deliverables",
      result: {
        goalPlan: {
          counts: {
            completed: 2,
            total: 4,
          },
          deliverables: {
            items: [
              {
                id: "markdown_report:report.export",
                label: "Markdown report",
                status: "waiting_for_approval",
                title: "Risk report",
              },
            ],
            status: "waiting_for_approval",
          },
          goal: "Create a risk report.",
          status: "waiting_for_user",
        },
      },
      items: [],
    };

    render(<AgentRunCenter onTaskAction={onTaskAction} tasks={[task]} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Approve deliverables" })
    );

    expect(onTaskAction).toHaveBeenCalledWith(task, "approve_deliverables", {
      approval: {
        approved: true,
        decision: "approved",
        source: "agent_run_center",
      },
    });
  });
});
