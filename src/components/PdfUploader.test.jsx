import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import axios from "axios";
import { message } from "antd";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "../archiveI18n";
import PdfUploader, {
  getUploadErrorMessage,
  uploadToBackend,
  validateDocumentFile,
  MAX_UPLOAD_SIZE_MB,
  UPLOAD_ACCEPT,
} from "./PdfUploader";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("validateDocumentFile", () => {
  it("accepts a valid .pdf file", () => {
    const file = { name: "a.pdf", size: 1024, type: "application/pdf" };
    expect(validateDocumentFile(file)).toEqual({ ok: true });
  });

  it("accepts an uppercase .PDF with empty MIME type", () => {
    const file = { name: "report.PDF", size: 2048, type: "" };
    expect(validateDocumentFile(file)).toEqual({ ok: true });
  });

  it.each([
    ["notes.docx", DOCX_MIME_TYPE],
    ["deck.pptx", PPTX_MIME_TYPE],
    ["budget.xlsx", XLSX_MIME_TYPE],
    ["NOTES.DOCX", ""],
    ["Deck.PpTx", ""],
    ["BUDGET.XLSX", "application/octet-stream"],
  ])("accepts the Office file %s (type %j)", (name, type) => {
    expect(validateDocumentFile({ name, size: 1024, type })).toEqual({ ok: true });
  });

  it("accepts an Office file the browser names only by its MIME type", () => {
    expect(
      validateDocumentFile({ name: "download", size: 1024, type: PPTX_MIME_TYPE })
    ).toEqual({ ok: true });
  });

  it("rejects a non-PDF file as invalidType", () => {
    const file = { name: "a.exe", size: 1024, type: "application/octet-stream" };
    expect(validateDocumentFile(file)).toEqual({ ok: false, reason: "invalidType" });
  });

  it.each([
    ["legacy.doc", "application/msword"],
    ["legacy.xls", "application/vnd.ms-excel"],
    ["legacy.ppt", "application/vnd.ms-powerpoint"],
    ["macros.docm", "application/vnd.ms-word.document.macroEnabled.12"],
    ["template.dotx", ""],
    ["show.ppsx", ""],
    ["notes.txt", "text/plain"],
    ["archive.zip", "application/zip"],
    ["report.pdf.exe", ""],
  ])("rejects %s as invalidType", (name, type) => {
    expect(validateDocumentFile({ name, size: 1024, type })).toEqual({
      ok: false,
      reason: "invalidType",
    });
  });

  it("rejects a file exceeding the size limit as tooLarge", () => {
    const file = { name: "big.pdf", size: MAX_UPLOAD_SIZE_BYTES + 1, type: "application/pdf" };
    expect(validateDocumentFile(file)).toEqual({ ok: false, reason: "tooLarge" });
  });

  it("applies the size limit to Office files too", () => {
    const file = { name: "big.xlsx", size: MAX_UPLOAD_SIZE_BYTES + 1, type: XLSX_MIME_TYPE };
    expect(validateDocumentFile(file)).toEqual({ ok: false, reason: "tooLarge" });
  });

  it("accepts a file exactly at the size limit", () => {
    const file = { name: "exact.pdf", size: MAX_UPLOAD_SIZE_BYTES, type: "application/pdf" };
    expect(validateDocumentFile(file)).toEqual({ ok: true });
  });
});

describe("getUploadErrorMessage", () => {
  it("prefers the server's refusal over the request's own message", () => {
    expect(
      getUploadErrorMessage(
        Object.assign(new Error("Request failed with status code 415"), {
          response: {
            status: 415,
            data: {
              code: "DOCUMENT_FORMAT_LEGACY_OFFICE",
              error: "Legacy or password-protected Office files are not supported.",
            },
          },
        })
      )
    ).toBe("Legacy or password-protected Office files are not supported.");
    expect(
      getUploadErrorMessage({
        message: "Request failed with status code 413",
        response: { data: { error: { message: "The workbook has too many cells." } } },
      })
    ).toBe("The workbook has too many cells.");
  });

  it("falls back to the request's message, then a generic one", () => {
    expect(getUploadErrorMessage(new Error("Network Error"))).toBe("Network Error");
    expect(getUploadErrorMessage({ response: { data: { error: "  " } } })).toBe(
      "Upload failed"
    );
    expect(getUploadErrorMessage(undefined)).toBe("Upload failed");
  });
});

describe("PdfUploader", () => {
  let errorMessage;

  beforeEach(() => {
    axios.get.mockReset();
    axios.post.mockReset();
    errorMessage = vi.spyOn(message, "error").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const getFileInput = (container) => container.querySelector('input[type="file"]');

  it("renders the English title when no locale is set", () => {
    render(<PdfUploader />);
    expect(screen.getByText("Add documents")).toBeInTheDocument();
    expect(
      screen.getByText("Drop PDF, Word, PowerPoint or Excel files here, or click to browse.")
    ).toBeInTheDocument();
  });

  it("renders the Chinese copy", () => {
    render(<PdfUploader t={createTranslator("zh")} />);
    expect(screen.getByText("添加文档")).toBeInTheDocument();
  });

  it("offers the four document formats in the file picker", () => {
    const { container } = render(<PdfUploader />);

    expect(UPLOAD_ACCEPT).toBe(".pdf,.docx,.pptx,.xlsx");
    expect(getFileInput(container)).toHaveAttribute("accept", ".pdf,.docx,.pptx,.xlsx");
  });

  it("refuses an unsupported file before sending anything", async () => {
    const { container } = render(<PdfUploader />);

    fireEvent.change(getFileInput(container), {
      target: { files: [new File(["text"], "notes.txt", { type: "text/plain" })] },
    });

    await waitFor(() => {
      expect(errorMessage).toHaveBeenCalledWith(
        "notes.txt is not a supported document. Upload PDF, Word (.docx), PowerPoint (.pptx) or Excel (.xlsx) files."
      );
    });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("sends a PowerPoint file and shows the server's refusal", async () => {
    axios.post.mockRejectedValue(
      Object.assign(new Error("Request failed with status code 415"), {
        response: {
          status: 415,
          data: {
            code: "DOCUMENT_FORMAT_DISABLED",
            error: "PowerPoint files are not enabled on this server.",
          },
        },
      })
    );
    const onUploadSuccess = vi.fn();
    const { container } = render(<PdfUploader onUploadSuccess={onUploadSuccess} />);

    fireEvent.change(getFileInput(container), {
      target: { files: [new File(["PK"], "Deck.PPTX", { type: PPTX_MIME_TYPE })] },
    });

    await waitFor(() => {
      expect(errorMessage).toHaveBeenCalledWith(
        "Deck.PPTX upload failed: PowerPoint files are not enabled on this server."
      );
    });
    expect(axios.post.mock.calls[0][0]).toMatch(/\/upload\/init$/);
    expect(axios.post.mock.calls[0][1]).toMatchObject({ fileName: "Deck.PPTX" });
    expect(onUploadSuccess).not.toHaveBeenCalled();
  });
});

describe("uploadToBackend", () => {
  const file = new File(["%PDF-1.4 small"], "notes.pdf", {
    type: "application/pdf",
    lastModified: 0,
  });
  const document = { docId: "doc-1", fileName: "notes.pdf", chunkCount: 3 };

  const mockChunkedUpload = (completeResponse) => {
    axios.post.mockImplementation(async (url) => {
      if (url.endsWith("/upload/init")) {
        return { status: 201, data: { sessionId: "doc-1", totalChunks: 1, uploadedChunks: [] } };
      }

      if (url.endsWith("/upload/chunk")) {
        return { status: 201, data: { uploadedChunks: [0] } };
      }

      return completeResponse;
    });
  };

  beforeEach(() => {
    axios.get.mockReset();
    axios.post.mockReset();
  });

  it("returns the document a synchronous 201 upload answers with", async () => {
    mockChunkedUpload({ status: 201, data: document });

    await expect(uploadToBackend(file)).resolves.toEqual(document);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("polls a 202 ingest job until it succeeds and returns its document", async () => {
    mockChunkedUpload({
      status: 202,
      data: { jobId: "job-1", docId: "doc-1", fileName: "notes.pdf", status: "queued" },
    });
    axios.get
      .mockResolvedValueOnce({ data: { jobId: "job-1", docId: "doc-1", status: "queued" } })
      .mockResolvedValueOnce({ data: { jobId: "job-1", docId: "doc-1", status: "running" } })
      .mockResolvedValueOnce({
        data: { jobId: "job-1", docId: "doc-1", status: "succeeded", document },
      });
    const sleep = vi.fn(async () => {});

    await expect(uploadToBackend(file, undefined, { sleep })).resolves.toEqual(document);
    expect(axios.get).toHaveBeenCalledTimes(3);
    expect(axios.get.mock.calls[0][0]).toMatch(/\/ingest-jobs\/job-1$/);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("rejects with the job's error when ingestion fails", async () => {
    mockChunkedUpload({
      status: 202,
      data: { jobId: "job-2", docId: "doc-2", fileName: "notes.pdf", status: "queued" },
    });
    axios.get.mockResolvedValueOnce({
      data: {
        jobId: "job-2",
        status: "failed",
        error: "No extractable text was found in the uploaded PDF.",
      },
    });

    await expect(
      uploadToBackend(file, undefined, { sleep: async () => {} })
    ).rejects.toThrow("No extractable text was found in the uploaded PDF.");
  });

  it("keeps polling through a rate limit or a restart and backs the interval off", async () => {
    mockChunkedUpload({
      status: 202,
      data: { jobId: "job-4", docId: "doc-1", fileName: "notes.pdf", status: "queued" },
    });
    axios.get
      .mockRejectedValueOnce(
        Object.assign(new Error("Request failed with status code 429"), {
          response: { status: 429, headers: { "retry-after": "3" }, data: {} },
        })
      )
      .mockRejectedValueOnce(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }))
      .mockResolvedValueOnce({ data: { jobId: "job-4", docId: "doc-1", status: "running" } })
      .mockResolvedValueOnce({
        data: { jobId: "job-4", docId: "doc-1", status: "succeeded", document },
      });
    const sleep = vi.fn(async () => {});

    await expect(uploadToBackend(file, undefined, { sleep })).resolves.toEqual(document);
    expect(axios.get).toHaveBeenCalledTimes(4);
    // 1 s, then the server's Retry-After (3 s), then 4.5 s, then the 5 s cap.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 3000, 4500, 5000]);
  });

  it("fails at once when the job is not found", async () => {
    mockChunkedUpload({
      status: 202,
      data: { jobId: "job-5", docId: "doc-5", fileName: "notes.pdf", status: "queued" },
    });
    axios.get.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 404"), {
        response: { status: 404, data: { error: "Ingest job not found." } },
      })
    );

    await expect(
      uploadToBackend(file, undefined, { sleep: async () => {} })
    ).rejects.toThrow(/404/);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it("gives up after the timeout while the job is still running", async () => {
    mockChunkedUpload({
      status: 202,
      data: { jobId: "job-3", docId: "doc-3", fileName: "notes.pdf", status: "queued" },
    });
    axios.get.mockResolvedValue({ data: { jobId: "job-3", status: "running" } });
    let clock = 0;

    await expect(
      uploadToBackend(file, undefined, {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        timeoutMs: 3000,
      })
    ).rejects.toThrow(/longer than expected/);
    expect(axios.get).toHaveBeenCalledTimes(3);
  });
});
