import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
