import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import WorkspaceSidebar from "./WorkspaceSidebar";
import { createTranslator } from "../archiveI18n";

const t = createTranslator("en");

const renderSidebar = () => {
  const onClearDocuments = vi.fn();
  const onRemoveDocument = vi.fn();

  render(
    <WorkspaceSidebar
      activeDocuments={[
        { docId: "doc-1", fileName: "policy.pdf", pageCount: 2 },
        { docId: "doc-2", fileName: "memo.pdf", pageCount: 1 },
      ]}
      onClearDocuments={onClearDocuments}
      onRemoveDocument={onRemoveDocument}
      onRunSyntheticQuality={vi.fn()}
      recoveryRuns={[]}
      t={t}
    />
  );

  return { onClearDocuments, onRemoveDocument };
};

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
