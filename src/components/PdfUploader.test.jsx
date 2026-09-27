import { beforeEach, describe, it, expect, vi } from "vitest";
import axios from "axios";
import { render, screen } from "@testing-library/react";
import PdfUploader, {
  uploadToBackend,
  validatePdfFile,
  MAX_UPLOAD_SIZE_MB,
} from "./PdfUploader";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

describe("validatePdfFile", () => {
  it("accepts a valid .pdf file", () => {
    const file = { name: "a.pdf", size: 1024, type: "application/pdf" };
    expect(validatePdfFile(file)).toEqual({ ok: true });
  });

  it("accepts an uppercase .PDF with empty MIME type", () => {
    const file = { name: "report.PDF", size: 2048, type: "" };
    expect(validatePdfFile(file)).toEqual({ ok: true });
  });

  it("rejects a non-PDF file as invalidType", () => {
    const file = { name: "a.exe", size: 1024, type: "application/octet-stream" };
    expect(validatePdfFile(file)).toEqual({ ok: false, reason: "invalidType" });
  });

  it("rejects a file exceeding the size limit as tooLarge", () => {
    const file = { name: "big.pdf", size: MAX_UPLOAD_SIZE_BYTES + 1, type: "application/pdf" };
    expect(validatePdfFile(file)).toEqual({ ok: false, reason: "tooLarge" });
  });

  it("accepts a file exactly at the size limit", () => {
    const file = { name: "exact.pdf", size: MAX_UPLOAD_SIZE_BYTES, type: "application/pdf" };
    expect(validatePdfFile(file)).toEqual({ ok: true });
  });
});

describe("PdfUploader", () => {
  it("renders the English title when no locale is set", () => {
    render(<PdfUploader />);
    expect(screen.getByText("Add PDFs")).toBeInTheDocument();
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
