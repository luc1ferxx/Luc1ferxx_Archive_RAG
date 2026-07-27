import { fireEvent, render, screen } from "@testing-library/react";
import PdfPreview from "./PdfPreview";

describe("PdfPreview", () => {
  test("renders selected source as one evidence object without fake citation counts", () => {
    render(
      <PdfPreview
        source={{
          docId: "renewal-policy",
          fileName: "Renewal Policy.pdf",
          pageNumber: 4,
          chunkIndex: 2,
          rank: 1,
          score: 0.87,
          excerpt: "Renewal notices must be sent before the contract end date.",
        }}
      />
    );

    expect(screen.getByText("Evidence object")).toBeInTheDocument();
    expect(screen.getAllByText("Renewal Policy.pdf").length).toBeGreaterThan(0);
    expect(screen.getByText("Citation")).toBeInTheDocument();
    expect(screen.queryByText("Citations (5)")).not.toBeInTheDocument();
    expect(screen.getByText("Rank")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("Score")).toBeInTheDocument();
    expect(screen.getByText("0.87")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Citation"));

    expect(screen.getByText("Selected citation")).toBeInTheDocument();
    expect(
      screen.getAllByText("Renewal notices must be sent before the contract end date.")
        .length
    ).toBeGreaterThan(0);
  });
});
