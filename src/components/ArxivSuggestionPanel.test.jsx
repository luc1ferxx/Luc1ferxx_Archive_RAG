import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import ArxivSuggestionPanel from "./ArxivSuggestionPanel";

const SUGGESTION = {
  document: { docId: "doc-1", fileName: "rag-notes.pdf" },
  papers: [
    { arxivId: "2401.00001v1", title: "Retrieval Augmented Generation for Archives" },
    { arxivId: "2401.00002v1", title: "Grounded Question Answering with Documents" },
  ],
  selectionToken: "selection-token-1",
  topic: "retrieval augmented generation",
};

// Each checked paper is downloaded and indexed, so the user picks them all.
describe("ArxivSuggestionPanel", () => {
  test("checks no paper and imports only the ones the user picks", () => {
    const onImport = vi.fn();

    render(<ArxivSuggestionPanel onImport={onImport} suggestion={SUGGESTION} />);

    screen.getAllByRole("checkbox").forEach((checkbox) => {
      expect(checkbox).not.toBeChecked();
    });
    expect(screen.getByText("0 of 2 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import 0/ })).toBeDisabled();

    fireEvent.click(
      screen.getByLabelText("Select Grounded Question Answering with Documents")
    );

    const importButton = screen.getByRole("button", { name: /Import 1/ });

    expect(importButton).toBeEnabled();
    fireEvent.click(importButton);
    expect(onImport).toHaveBeenCalledWith(["2401.00002v1"]);
  });

  test("starts a new search unchecked even when it finds the same papers", () => {
    const { rerender } = render(
      <ArxivSuggestionPanel onImport={vi.fn()} suggestion={SUGGESTION} />
    );

    fireEvent.click(
      screen.getByLabelText("Select Grounded Question Answering with Documents")
    );
    expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();

    // "Not now", then the user searches again and gets the same papers.
    rerender(<ArxivSuggestionPanel onImport={vi.fn()} suggestion={null} />);
    rerender(<ArxivSuggestionPanel isLoading onImport={vi.fn()} suggestion={null} />);
    rerender(
      <ArxivSuggestionPanel
        onImport={vi.fn()}
        suggestion={{ ...SUGGESTION, selectionToken: "selection-token-2" }}
      />
    );

    screen.getAllByRole("checkbox").forEach((checkbox) => {
      expect(checkbox).not.toBeChecked();
    });
    expect(screen.getByRole("button", { name: /Import 0/ })).toBeDisabled();
  });
});
