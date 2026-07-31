import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { useAuthenticatedDocumentPreview } from "./useAuthenticatedDocumentPreview";

const archiveApiMocks = vi.hoisted(() => ({
  fetchDocumentFile: vi.fn(),
}));

vi.mock("../archiveApi", () => archiveApiMocks);

const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL"
);
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL"
);

const createDeferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve,
  };
};

const createPdfDownload = (content) => ({
  blob: new Blob([content], {
    type: "application/pdf",
  }),
  fileName: "document.pdf",
  mimeType: "application/pdf",
});

const PreviewHarness = ({ docId, onRender }) => {
  const preview = useAuthenticatedDocumentPreview({
    docId,
    enabled: true,
  });

  onRender?.({
    docId,
    ...preview,
  });

  return (
    <output data-testid="preview-state" data-status={preview.status}>
      {preview.objectUrl}
    </output>
  );
};

describe("useAuthenticatedDocumentPreview", () => {
  beforeEach(() => {
    archiveApiMocks.fetchDocumentFile.mockReset();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();

    if (originalCreateObjectUrl) {
      Object.defineProperty(URL, "createObjectURL", originalCreateObjectUrl);
    } else {
      delete URL.createObjectURL;
    }

    if (originalRevokeObjectUrl) {
      Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectUrl);
    } else {
      delete URL.revokeObjectURL;
    }
  });

  test("never exposes an object URL owned by the previous document", async () => {
    const secondDownload = createDeferred();
    const renders = [];
    URL.createObjectURL
      .mockReturnValueOnce("blob:document-a")
      .mockReturnValueOnce("blob:document-b");
    archiveApiMocks.fetchDocumentFile
      .mockResolvedValueOnce(createPdfDownload("%PDF-a"))
      .mockReturnValueOnce(secondDownload.promise);

    const { rerender } = render(
      <PreviewHarness
        docId="document-a"
        onRender={(preview) => renders.push(preview)}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-state")).toHaveTextContent(
        "blob:document-a"
      );
    });

    rerender(
      <PreviewHarness
        docId="document-b"
        onRender={(preview) => renders.push(preview)}
      />
    );

    expect(
      renders
        .filter((preview) => preview.docId === "document-b")
        .every((preview) => preview.objectUrl !== "blob:document-a")
    ).toBe(true);

    await act(async () => {
      secondDownload.resolve(createPdfDownload("%PDF-b"));
    });
  });

  test("ignores a late response after switching documents", async () => {
    const firstDownload = createDeferred();
    const secondDownload = createDeferred();
    URL.createObjectURL.mockReturnValue("blob:document-b");
    archiveApiMocks.fetchDocumentFile
      .mockReturnValueOnce(firstDownload.promise)
      .mockReturnValueOnce(secondDownload.promise);

    const { rerender } = render(<PreviewHarness docId="document-a" />);

    await waitFor(() => {
      expect(archiveApiMocks.fetchDocumentFile).toHaveBeenCalledTimes(1);
    });
    const firstSignal =
      archiveApiMocks.fetchDocumentFile.mock.calls[0][1].signal;

    rerender(<PreviewHarness docId="document-b" />);

    await waitFor(() => {
      expect(archiveApiMocks.fetchDocumentFile).toHaveBeenCalledTimes(2);
    });
    const secondSignal =
      archiveApiMocks.fetchDocumentFile.mock.calls[1][1].signal;
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);

    await act(async () => {
      secondDownload.resolve(createPdfDownload("%PDF-b"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("preview-state")).toHaveTextContent(
        "blob:document-b"
      );
    });

    await act(async () => {
      firstDownload.resolve(createPdfDownload("%PDF-a"));
    });

    expect(screen.getByTestId("preview-state")).toHaveTextContent(
      "blob:document-b"
    );
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  test("revokes each owned object URL on replacement and unmount", async () => {
    const secondDownload = createDeferred();
    URL.createObjectURL
      .mockReturnValueOnce("blob:document-a")
      .mockReturnValueOnce("blob:document-b");
    archiveApiMocks.fetchDocumentFile
      .mockResolvedValueOnce(createPdfDownload("%PDF-a"))
      .mockReturnValueOnce(secondDownload.promise);

    const { rerender, unmount } = render(
      <PreviewHarness docId="document-a" />
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-state")).toHaveTextContent(
        "blob:document-a"
      );
    });

    rerender(<PreviewHarness docId="document-b" />);

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:document-a");

    await act(async () => {
      secondDownload.resolve(createPdfDownload("%PDF-b"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("preview-state")).toHaveTextContent(
        "blob:document-b"
      );
    });

    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenLastCalledWith("blob:document-b");
  });

  test("rejects conflicting PDF and Blob MIME types without creating a URL", async () => {
    archiveApiMocks.fetchDocumentFile.mockResolvedValue({
      blob: new Blob(["<script>unsafe()</script>"], {
        type: "text/html",
      }),
      fileName: "document.pdf",
      mimeType: "application/pdf",
    });

    render(<PreviewHarness docId="document-a" />);

    await waitFor(() => {
      expect(screen.getByTestId("preview-state")).toHaveAttribute(
        "data-status",
        "error"
      );
    });

    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  test("fails closed without requesting a blank document ID", () => {
    render(<PreviewHarness docId="   " />);

    expect(screen.getByTestId("preview-state")).toHaveAttribute(
      "data-status",
      "error"
    );
    expect(archiveApiMocks.fetchDocumentFile).not.toHaveBeenCalled();
  });
});
