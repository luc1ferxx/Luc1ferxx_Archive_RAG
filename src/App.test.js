import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import App from "./App";

jest.mock("axios", () => ({
  get: jest.fn(),
  post: jest.fn(),
  delete: jest.fn(),
}));

jest.mock("./components/PdfUploader", () => ({ onUploadSuccess }) => (
  <button
    type="button"
    onClick={() =>
      onUploadSuccess?.({
        docId: "doc-upload",
        fileName: "rag-notes.pdf",
        pageCount: 2,
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      })
    }
  >
    Upload mock
  </button>
));
jest.mock("./components/ChatComponent", () => () => <div>Chat</div>);
jest.mock("./components/RenderQA", () => (props) => (
  <button
    type="button"
    onClick={() =>
      props.onFeedback?.({
        turnIndex: 0,
        feedbackType: "hallucination",
        note: "This answer is not supported.",
        question: "What changed?",
        answer: {
          agentAnswer: "Unsupported answer.",
          ragSources: [],
        },
      })
    }
  >
    Send feedback
  </button>
));
jest.mock("./components/PdfPreview", () => () => <div>Preview</div>);

describe("App", () => {
  beforeEach(() => {
    axios.get.mockResolvedValue({
      data: [
        {
          docId: "doc-1",
          fileName: "benefits-2025.pdf",
          pageCount: 3,
        },
      ],
    });
    axios.post.mockResolvedValue({ data: {} });
    axios.delete.mockResolvedValue({ data: {} });
    window.localStorage.clear();
  });

  test("loads persisted documents on startup", async () => {
    render(<App />);

    expect(await screen.findByText("benefits-2025.pdf")).toBeInTheDocument();
    expect(screen.getByText("Workspace documents")).toBeInTheDocument();
    expect(screen.getByText("Relevant documents")).toBeInTheDocument();
    expect(screen.getByText("Quality Guard")).toBeInTheDocument();
    expect(screen.getByText("History")).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith("http://localhost:5001/documents");
  });

  test("removes a document from the UI after delete succeeds", async () => {
    render(<App />);

    const removeButton = await screen.findByLabelText("Remove benefits-2025.pdf");
    removeButton.click();

    await waitFor(() =>
      expect(screen.queryByText("benefits-2025.pdf")).not.toBeInTheDocument()
    );
    expect(axios.delete).toHaveBeenCalledWith(
      "http://localhost:5001/documents/doc-1"
    );
  });

  test("posts answer feedback from the conversation panel", async () => {
    render(<App />);

    await screen.findByText("benefits-2025.pdf");
    fireEvent.click(screen.getByText("Send feedback"));

    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith(
        "http://localhost:5001/feedback",
        expect.objectContaining({
          docIds: ["doc-1"],
          feedbackType: "hallucination",
          note: "This answer is not supported.",
          question: "What changed?",
          answer: expect.objectContaining({
            agentAnswer: "Unsupported answer.",
          }),
        })
      )
    );
  });

  test("suggests arxiv papers after upload and imports after confirmation", async () => {
    let documentFetchCount = 0;

    axios.get.mockImplementation((url) => {
      if (url.includes("/documents/doc-upload/arxiv/suggestions")) {
        return Promise.resolve({
          data: {
            document: {
              docId: "doc-upload",
              fileName: "rag-notes.pdf",
            },
            topic: "retrieval augmented generation",
            requestedMaxResults: 3,
            selectionToken: "selection-token-1",
            papers: [
              {
                arxivId: "2401.00001v1",
                title: "Retrieval Augmented Generation for Archives",
              },
              {
                arxivId: "2401.00002v1",
                title: "Grounded Question Answering with Documents",
              },
              {
                arxivId: "2401.00003v1",
                title: "Hybrid Retrieval for Private Workspaces",
              },
            ],
          },
        });
      }

      documentFetchCount += 1;

      return Promise.resolve({
        data:
          documentFetchCount > 1
            ? [
                {
                  docId: "doc-1",
                  fileName: "benefits-2025.pdf",
                  pageCount: 3,
                },
                {
                  docId: "doc-upload",
                  fileName: "rag-notes.pdf",
                  pageCount: 2,
                },
                {
                  docId: "doc-arxiv",
                  fileName: "arxiv-2401.00001.pdf",
                  pageCount: 12,
                },
              ]
            : [
                {
                  docId: "doc-1",
                  fileName: "benefits-2025.pdf",
                  pageCount: 3,
                },
              ],
      });
    });
    axios.post.mockImplementation((url, payload) => {
      if (url.includes("/documents/doc-upload/arxiv/import")) {
        return Promise.resolve({
          data: {
            importedCount: 1,
            skippedCount: 0,
            failedCount: 0,
            importedPapers: [
              {
                docId: "doc-arxiv",
                fileName: "arxiv-2401.00001.pdf",
              },
            ],
          },
        });
      }

      return Promise.resolve({
        data: {},
      });
    });

    render(<App />);

    await screen.findByText("benefits-2025.pdf");
    fireEvent.click(screen.getByText("Upload mock"));

    expect(await screen.findByText("arXiv recommendations")).toBeInTheDocument();
    expect(
      await screen.findByText("Retrieval Augmented Generation for Archives")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Import 3/i }));

    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith(
        "http://localhost:5001/documents/doc-upload/arxiv/import",
        {
          selectionToken: "selection-token-1",
        }
      )
    );
    expect(await screen.findByText("arxiv-2401.00001.pdf")).toBeInTheDocument();
  });
});
