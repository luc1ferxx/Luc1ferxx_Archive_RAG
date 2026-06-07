import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import App from "./App";

jest.mock("axios", () => ({
  get: jest.fn(),
  post: jest.fn(),
  delete: jest.fn(),
}));

jest.mock("./components/PdfUploader", () => () => <div>Uploader</div>);
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
});
