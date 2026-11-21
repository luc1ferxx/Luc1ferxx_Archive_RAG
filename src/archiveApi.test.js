import { beforeEach, vi } from "vitest";
import { fetchAgentRun, fetchDocumentFile } from "./archiveApi";

const apiClientMocks = vi.hoisted(() => ({
  apiDelete: vi.fn(),
  apiDownload: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock("./apiClient", () => apiClientMocks);

describe("fetchDocumentFile", () => {
  beforeEach(() => {
    apiClientMocks.apiDownload.mockReset();
  });

  test("derives an encoded route from docId and forwards cancellation", async () => {
    const controller = new AbortController();
    apiClientMocks.apiDownload.mockResolvedValue({
      blob: new Blob(["%PDF"]),
      mimeType: "application/pdf",
    });

    await fetchDocumentFile(" policy/2026?draft ", {
      signal: controller.signal,
    });

    expect(apiClientMocks.apiDownload).toHaveBeenCalledWith(
      "/documents/policy%2F2026%3Fdraft/file",
      {
        signal: controller.signal,
      }
    );
  });

  test("rejects a blank docId before issuing a request", async () => {
    await expect(fetchDocumentFile("  ")).rejects.toThrow(
      "A document ID is required"
    );
    expect(apiClientMocks.apiDownload).not.toHaveBeenCalled();
  });
});

describe("fetchAgentRun", () => {
  test("reads one run by its encoded id", async () => {
    const run = { runId: "run/1", status: "failed" };
    apiClientMocks.apiGet.mockResolvedValue(run);

    await expect(fetchAgentRun("run/1")).resolves.toBe(run);
    expect(apiClientMocks.apiGet).toHaveBeenCalledWith("/agent-runs/run%2F1");
  });
});
