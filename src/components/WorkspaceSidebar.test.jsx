import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import WorkspaceSidebar from "./WorkspaceSidebar";
import { createTranslator } from "../archiveI18n";

const t = createTranslator("en");

const POLICY_DOCUMENT = { docId: "doc-1", fileName: "policy.pdf", pageCount: 2 };

const renderSidebar = (props = {}) => {
  const onClearDocuments = vi.fn();
  const onRemoveDocument = vi.fn();

  render(
    <WorkspaceSidebar
      activeDocuments={[
        POLICY_DOCUMENT,
        { docId: "doc-2", fileName: "memo.pdf", pageCount: 1 },
      ]}
      onClearDocuments={onClearDocuments}
      onRemoveDocument={onRemoveDocument}
      onRunSyntheticQuality={vi.fn()}
      recoveryRuns={[]}
      t={t}
      {...props}
    />
  );

  return { onClearDocuments, onRemoveDocument };
};

// A document's topic goes to arXiv only from this click.
describe("WorkspaceSidebar finds related arXiv papers on request", () => {
  test("asks for the clicked document, never for an arXiv import", () => {
    const onRequestArxivSuggestions = vi.fn();

    renderSidebar({
      activeDocuments: [
        POLICY_DOCUMENT,
        {
          docId: "doc-arxiv",
          fileName: "arxiv-2401.00001.pdf",
          pageCount: 12,
          profile: { source: { sourceType: "arxiv", arxivId: "2401.00001v1" } },
        },
      ],
      onRequestArxivSuggestions,
    });

    expect(
      screen.queryByRole("button", {
        name: "Find related arXiv papers for arxiv-2401.00001.pdf",
      })
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Find related arXiv papers for policy.pdf" })
    );

    expect(onRequestArxivSuggestions).toHaveBeenCalledTimes(1);
    expect(onRequestArxivSuggestions).toHaveBeenCalledWith(POLICY_DOCUMENT);
  });

  test("is disabled while a search runs", () => {
    renderSidebar({ isArxivSuggestionLoading: true });

    expect(
      screen.getByRole("button", { name: "Find related arXiv papers for policy.pdf" })
    ).toBeDisabled();
  });
});

// The server deletes at once and the workbench then resets the conversation,
// so neither delete may run on one click.
describe("WorkspaceSidebar deletes only after a confirm", () => {
  test("× names the file, Cancel keeps it, Delete removes it", async () => {
    const { onRemoveDocument } = renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Remove policy.pdf" }));

    expect(await screen.findByText("Delete policy.pdf?")).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    expect(onRemoveDocument).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRemoveDocument).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove policy.pdf" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onRemoveDocument).toHaveBeenCalledTimes(1));
    expect(onRemoveDocument).toHaveBeenCalledWith("doc-1");
  });

  test("Clear workspace says how many documents go and clears only on Delete", async () => {
    const { onClearDocuments } = renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: t("sidebar.clearWorkspace") }));

    expect(
      await screen.findByText("Delete all 2 documents in this workspace?")
    ).toBeInTheDocument();
    expect(onClearDocuments).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onClearDocuments).toHaveBeenCalledTimes(1));
  });
});

describe("WorkspaceSidebar counts", () => {
  test("take their singular for one", async () => {
    renderSidebar({
      activeDocuments: [POLICY_DOCUMENT],
      savedArxivSuggestionsByDocId: { "doc-1": { papers: [{ arxivId: "2401.00001v1" }] } },
      totalPages: 1,
    });

    expect(screen.getByText("1 document · 1 page")).toBeInTheDocument();
    expect(screen.getByText("1 arXiv recommendation")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t("sidebar.clearWorkspace") }));

    expect(
      await screen.findByText("Delete the 1 document in this workspace?")
    ).toBeInTheDocument();
  });
});

// The run a failed approved web search leaves: its self-check failed too, and
// Retry replays the capability call.
const CAPABILITY_CALL_SAFETY = {
  label: "Web Search",
  reasonCodes: ["non_idempotent"],
  stepId: "capability:web.search:gate-1",
  stepType: "capability_call",
  summary: "Capability calls replay only from a hash-bound approved gate.",
};
const FAILED_CAPABILITY_RUN = {
  goal: "Search the web for the launch date.",
  recovery: {
    actions: [
      {
        label: "Web Search",
        reason: "failed_step_ready",
        safety: CAPABILITY_CALL_SAFETY,
        stepId: "capability:web.search:gate-1",
        stepType: "capability_call",
        type: "retry_failed_step",
      },
    ],
    reason: "failed_step_ready",
    replaySafety: {
      reasonCodes: ["unsupported_step_type", "non_idempotent"],
      steps: [
        {
          label: "Self-check",
          reasonCodes: ["unsupported_step_type"],
          stepId: "self-check",
          stepType: "self_check",
          summary: "No replay safety policy is registered for this step type.",
        },
        CAPABILITY_CALL_SAFETY,
      ],
    },
    stepId: "capability:web.search:gate-1",
  },
  runId: "run-failed",
  status: "failed",
};

describe("WorkspaceSidebar recovery card", () => {
  test("describes the step its Retry replays, in labels rather than codes", () => {
    const onRecoveryAction = vi.fn();

    renderSidebar({ onRecoveryAction, recoveryRuns: [FAILED_CAPABILITY_RUN] });
    const card = within(document.querySelector(".archive-recovery-item"));

    expect(card.getAllByText("Failed")).toHaveLength(2);
    expect(card.getByText("A failed step can be retried")).toBeInTheDocument();
    expect(card.getByText("Web Search (capability call)")).toBeInTheDocument();
    expect(card.getByText("Not idempotent")).toBeInTheDocument();
    // The failed self-check is not what Retry runs, and no code shows raw.
    expect(
      card.queryByText(/self.check|Unsupported|No replay safety policy|hash-bound/i)
    ).toBeNull();
    expect(card.queryByText(/failed_step_ready|non_idempotent/)).toBeNull();

    fireEvent.click(card.getByRole("button", { name: "Retry failed step" }));
    expect(onRecoveryAction).toHaveBeenCalledWith({
      action: "retry_failed_step",
      runId: "run-failed",
      stepId: "capability:web.search:gate-1",
    });
  });

  test("follows the app's locale", () => {
    renderSidebar({
      recoveryRuns: [FAILED_CAPABILITY_RUN],
      t: createTranslator("zh"),
    });
    const card = within(document.querySelector(".archive-recovery-item"));

    expect(card.getAllByText("失败")).toHaveLength(2);
    expect(card.getByText("失败的步骤可以重试")).toBeInTheDocument();
    expect(card.getByText("Web Search（能力调用）")).toBeInTheDocument();
    expect(card.getByText("非幂等")).toBeInTheDocument();
  });
});

describe("WorkspaceSidebar labels", () => {
  test("a one-page PDF reads 1 page", () => {
    renderSidebar();

    expect(screen.getByText(/^1 page · ID doc-2/)).toBeInTheDocument();
    expect(screen.getByText(/^2 pages · ID doc-1/)).toBeInTheDocument();
  });

  // antd names each icon in English (aria-label "plus-circle"); a button
  // named by its text keeps it out of the name.
  test("names its buttons by their text alone, in Chinese too", () => {
    renderSidebar({ activeNavItem: "drive", t: createTranslator("zh") });

    for (const name of ["新对话", "搜索", "文件库", "添加文档"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
  });
});
