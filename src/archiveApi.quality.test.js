import { beforeEach, describe, expect, test, vi } from "vitest";

import { requestSyntheticQualityRun } from "./archiveApi";

const apiClientMocks = vi.hoisted(() => ({
  apiDelete: vi.fn(),
  apiDownload: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock("./apiClient", () => apiClientMocks);

describe("requestSyntheticQualityRun", () => {
  beforeEach(() => {
    apiClientMocks.apiGet.mockReset();
    apiClientMocks.apiPost.mockReset();
  });

  test("uses the controlled admin action and reloads the full latest report", async () => {
    const compactActionResult = {
      action: {
        id: "quality-refresh",
      },
      result: {
        quality: {
          runId: "quality-run",
        },
      },
    };
    const latestReport = {
      failedCases: [],
      status: "pass",
      summary: {
        runId: "quality-run",
      },
    };

    apiClientMocks.apiPost.mockResolvedValue(compactActionResult);
    apiClientMocks.apiGet.mockResolvedValue(latestReport);

    await expect(requestSyntheticQualityRun()).resolves.toBe(latestReport);
    expect(apiClientMocks.apiPost).toHaveBeenCalledWith(
      "/admin/actions/quality-refresh",
      {
        corpusId: "near-duplicate",
      },
      {
        timeout: 0,
      }
    );
    expect(apiClientMocks.apiGet).toHaveBeenCalledWith("/quality/latest");
  });

  test("does not read a stale report before the admin action completes", async () => {
    let completeAction;
    const actionPending = new Promise((resolve) => {
      completeAction = resolve;
    });
    const latestReport = {
      status: "pass",
      summary: {
        runId: "new-run",
      },
    };

    apiClientMocks.apiPost.mockReturnValue(actionPending);
    apiClientMocks.apiGet.mockResolvedValue(latestReport);

    const pending = requestSyntheticQualityRun();

    expect(apiClientMocks.apiGet).not.toHaveBeenCalled();
    completeAction({
      status: "completed",
    });

    await expect(pending).resolves.toBe(latestReport);
    expect(apiClientMocks.apiGet).toHaveBeenCalledTimes(1);
  });
});
