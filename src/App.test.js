import { render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import App from "./App";

jest.mock("axios", () => ({
  get: jest.fn(),
  post: jest.fn(),
  delete: jest.fn(),
}));

jest.mock("./components/PdfUploader", () => () => <div>Uploader</div>);
jest.mock("./components/ChatComponent", () => () => <div>Chat</div>);
jest.mock("./components/RenderQA", () => () => <div>Conversation</div>);
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
    expect(screen.getByText("1 documents")).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith("http://localhost:5001/documents");
  });

  test("removes a document from the UI after delete succeeds", async () => {
    render(<App />);

    const closeButton = await screen.findByLabelText("Close");
    closeButton.click();

    await waitFor(() =>
      expect(screen.queryByText("benefits-2025.pdf")).not.toBeInTheDocument()
    );
    expect(axios.delete).toHaveBeenCalledWith(
      "http://localhost:5001/documents/doc-1"
    );
  });
});
