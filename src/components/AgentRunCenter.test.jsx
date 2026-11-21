import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { createTranslator } from "../archiveI18n";
import AgentRunCenter from "./AgentRunCenter";

const APPROVAL_OBJECT_HASH = `sha256:${"a".repeat(64)}`;

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
                  approvalObjectHash: APPROVAL_OBJECT_HASH,
                  capabilityId: "web.search",
                  id: "approval:web.search:1.0.0",
                  status: "pending",
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

  // A plan stored before the server counted the runs past the budget
  // (2db8b776) has no overBudgetIterations.
  test.each([
    ["a current plan", { overBudgetIterations: 1 }],
    ["a plan stored before overBudgetIterations", {}],
  ])("counts runs within the budget and shows approval runs past it separately: %s", (_, planFields) => {
    render(
      <AgentRunCenter
        tasks={[
          {
            id: "agent_goal:approved-on-last-run",
            type: "agent_goal",
            status: "completed",
            result: {
              goalPlan: {
                completedIterations: 2,
                counts: { completed: 3, total: 3 },
                goal: "Search the web for the launch date.",
                maxIterations: 1,
                ...planFields,
                status: "completed",
              },
            },
            items: [],
          },
        ]}
      />
    );

    expect(screen.getByText("1/1 runs · 1 after approval")).toBeInTheDocument();
    expect(screen.queryByText("2/1 runs")).not.toBeInTheDocument();
  });

  test("shows task, step and approval statuses as labels in the app's language", () => {
    const tasks = [
      {
        id: "agent_goal:labels",
        type: "agent_goal",
        status: "waiting_for_user",
        label: "Agent task",
        requiredUserAction: "approve_capability",
        result: {
          approvalGates: [
            {
              approvalObjectHash: APPROVAL_OBJECT_HASH,
              capabilityId: "web.search",
              id: "approval:web.search:1.0.0",
              status: "pending",
            },
          ],
        },
        items: [
          { id: "goal", label: "Goal", status: "completed", summary: "Find the date." },
        ],
      },
    ];
    const { rerender } = render(<AgentRunCenter tasks={tasks} />);

    expect(screen.getByText("Waiting for user")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.queryByText(/waiting.for.user|^completed$|^pending$/)).toBeNull();

    rerender(<AgentRunCenter t={createTranslator("zh")} tasks={tasks} />);

    expect(screen.getByText("等待用户处理")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("待处理")).toBeInTheDocument();
  });

  test("forwards approval actions through the task action callback", () => {
    const onTaskAction = vi.fn();
    const task = {
      id: "agent_goal:approval",
      type: "agent_goal",
      status: "waiting_for_user",
      label: "Agent task",
      requiredUserAction: "approve_capability",
      result: {
        approvalGates: [
          {
            approvalObjectHash: APPROVAL_OBJECT_HASH,
            capabilityId: "web.search",
            capabilityLabel: "Web search",
            id: "approval:web.search:1.0.0",
            inputPreview: {
              query: "current renewal rules",
            },
            status: "pending",
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
    expect(
      screen.getByRole("region", { name: "Pending capability approvals" })
    ).toBeInTheDocument();
    expect(screen.getByText("Web search")).toBeInTheDocument();
    expect(screen.getByText("query")).toBeInTheDocument();
    expect(screen.getByText("current renewal rules")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onTaskAction).toHaveBeenCalledWith(task, "approve", {
      approval: {
        approved: true,
        decision: "approved",
        source: "agent_run_center",
      },
      approvalObjectHash: APPROVAL_OBJECT_HASH,
      gateId: "approval:web.search:1.0.0",
    });
  });

  test("does not submit a capability approval without an approval object hash", () => {
    const onTaskAction = vi.fn();
    const task = {
      id: "agent_goal:missing-approval-hash",
      type: "agent_goal",
      status: "waiting_for_user",
      requiredUserAction: "approve_capability",
      result: {
        approvalGates: [
          {
            capabilityId: "web.search",
            id: "approval:web.search:1.0.0",
            status: "pending",
          },
        ],
      },
      items: [],
    };

    render(<AgentRunCenter onTaskAction={onTaskAction} tasks={[task]} />);

    const approveButton = screen.getByRole("button", { name: "Approve" });
    expect(approveButton).toBeDisabled();
    fireEvent.click(approveButton);
    expect(onTaskAction).not.toHaveBeenCalled();
  });

  test("forwards deliverable approval through the task action callback", () => {
    const onTaskAction = vi.fn();
    const task = {
      id: "agent_goal:deliverables",
      type: "agent_goal",
      status: "waiting_for_user",
      label: "Agent task",
      requiredUserAction: "approve_deliverables",
      result: {
        approvalGates: [
          {
            approvalObjectHash: `sha256:${"a".repeat(64)}`,
            capabilityLabel: "Report export",
            id: "approval:report.export:1.0.0:report",
            inputPreview: {
              format: "markdown",
              title: "Risk report",
            },
            status: "pending",
          },
          {
            approvalObjectHash: `sha256:${"b".repeat(64)}`,
            capabilityLabel: "Follow-up task",
            id: "approval:task.create:1.0.0:follow-up",
            inputPreview: {
              priority: "medium",
              tags: ["agent-goal", "follow-up"],
            },
            status: "pending",
          },
        ],
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
    expect(
      screen.getByRole("region", { name: "Pending deliverable approvals" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Long values and lists may be truncated or hidden; approval remains bound to the full input/
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Report export")).toBeInTheDocument();
    expect(screen.getByText("format")).toBeInTheDocument();
    expect(screen.getByText("markdown")).toBeInTheDocument();
    expect(screen.getByText("title")).toBeInTheDocument();
    expect(screen.getAllByText("Risk report")).toHaveLength(2);
    expect(screen.getByText("Follow-up task")).toBeInTheDocument();
    expect(screen.getByText("priority")).toBeInTheDocument();
    expect(screen.getByText("medium")).toBeInTheDocument();
    expect(screen.getByText("tags")).toBeInTheDocument();
    expect(screen.getByText("agent-goal, follow-up")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Approve deliverables" })
    );

    expect(onTaskAction).toHaveBeenCalledWith(task, "approve_deliverables", {
      approvalBindings: [
        {
          approvalObjectHash: `sha256:${"a".repeat(64)}`,
          gateId: "approval:report.export:1.0.0:report",
        },
        {
          approvalObjectHash: `sha256:${"b".repeat(64)}`,
          gateId: "approval:task.create:1.0.0:follow-up",
        },
      ],
    });
  });

  test("counts only unfinished tasks as active", () => {
    const tasks = [
      { id: "task-running", label: "Running task", status: "running" },
      { id: "task-waiting", label: "Waiting task", status: "waiting_for_user" },
      { id: "task-done", label: "Done task", status: "completed" },
      { id: "task-failed", label: "Failed task", status: "failed" },
    ];
    const { rerender } = render(<AgentRunCenter tasks={tasks} />);

    expect(screen.getByText("2 active")).toBeInTheDocument();
    // The list still shows every task.
    expect(screen.getByText("Done task")).toBeInTheDocument();

    rerender(<AgentRunCenter t={createTranslator("zh")} tasks={tasks} />);
    expect(screen.getByText("2 个未完成")).toBeInTheDocument();
  });

  test("with no task, says how to start one and counts nothing", () => {
    render(<AgentRunCenter tasks={[]} />);

    expect(screen.getByText("0 active")).toBeInTheDocument();
    expect(screen.getByText("Awaiting question")).toBeInTheDocument();
  });

  // The paper items as server/rag/recommendation-task-builders.js builds them:
  // the summary is the paper's status code.
  test("reads a recommendation paper's status code as a label", () => {
    const paper = (id, status, resultStatus = "") => ({
      error: null,
      id,
      label: `Paper ${id}`,
      result: { docId: "", fileName: "", status: resultStatus },
      status,
      summary: resultStatus || status,
    });
    const tasks = [
      {
        id: "external_recommendation:arxiv:doc-1",
        items: [
          paper("p-1", "waiting_for_user"),
          paper("p-2", "completed", "already_indexed"),
          paper("p-3", "completed", "imported"),
        ],
        label: "arXiv recommendations",
        status: "waiting_for_user",
        type: "external_recommendation",
      },
    ];
    const { container, rerender } = render(<AgentRunCenter tasks={tasks} />);
    const summaries = () =>
      [...container.querySelectorAll(".archive-agent-plan-step p")].map((node) => node.textContent);

    // A summary that only repeats the paper's status is left out.
    expect(summaries()).toEqual(["Already indexed", "Imported"]);
    expect(container.textContent).not.toMatch(/waiting_for_user|already_indexed|imported/);

    rerender(<AgentRunCenter t={createTranslator("zh")} tasks={tasks} />);
    expect(summaries()).toEqual(["已在索引中", "已导入"]);
  });

  test("tells a capability call trace step apart from the step that asked for it", () => {
    render(
      <AgentRunCenter
        tasks={[
          { id: "web_search:primary", label: "Web Search", status: "skipped", type: "web_search" },
          { id: "capability:web.search", label: "Web Search", status: "failed", type: "capability_call" },
        ]}
      />
    );

    expect(screen.getByText("Web Search")).toBeInTheDocument();
    expect(screen.getByText("Web Search (capability call)")).toBeInTheDocument();
  });
});

