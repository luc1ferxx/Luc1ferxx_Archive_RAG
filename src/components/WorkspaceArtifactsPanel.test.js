import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  downloadWorkspaceArtifact,
  fetchWorkspaceArtifact,
  fetchWorkspaceArtifacts,
  requestWorkspaceArtifactArchive,
} from "../archiveApi";
import { createTranslator } from "../archiveI18n";
import WorkspaceArtifactsPanel from "./WorkspaceArtifactsPanel";

jest.mock("../archiveApi", () => ({
  downloadWorkspaceArtifact: jest.fn(),
  fetchWorkspaceArtifact: jest.fn(),
  fetchWorkspaceArtifacts: jest.fn(),
  requestWorkspaceArtifactArchive: jest.fn(),
}));

const t = createTranslator("en");
const zhT = createTranslator("zh");

const reportSummary = {
  artifactId: "artifact-report",
  artifactType: "report",
  citationCount: 2,
  createdAt: "2026-07-15T08:30:00.000Z",
  docCount: 3,
  fileName: "quarterly-risk-report.md",
  format: "markdown",
  mimeType: "text/markdown",
  sourceRunId: "run-7",
  sourceTaskId: "task-7",
  status: "active",
  title: "Quarterly risk report",
  updatedAt: "2026-07-15T08:30:00.000Z",
};

const summarySummary = {
  artifactId: "artifact-summary",
  artifactType: "summary",
  citationCount: 1,
  createdAt: "2026-07-14T08:30:00.000Z",
  docCount: 1,
  fileName: "renewal-summary.md",
  format: "markdown",
  mimeType: "text/markdown",
  sourceRunId: "run-6",
  sourceTaskId: "task-6",
  status: "active",
  title: "Renewal summary",
  updatedAt: "2026-07-14T08:30:00.000Z",
};

const buildDetail = (artifact) => ({
  ...artifact,
  archivedAt: null,
  citationManifest: [{ docId: "doc-1", title: "Policy" }],
  content:
    artifact.artifactType === "report"
      ? "# Risk findings\nEvidence drift remains the primary risk."
      : "Renewal requires 30 days notice.",
  docIds: artifact.artifactType === "report" ? ["doc-1", "doc-2", "doc-3"] : ["doc-1"],
  payload: {
    sectionCount: artifact.artifactType === "report" ? 2 : 1,
  },
  version: "1.0.0",
});

const createDeferred = () => {
  let reject;
  let resolve;
  const promise = new Promise((nextResolve, nextReject) => {
    reject = nextReject;
    resolve = nextResolve;
  });

  return { promise, reject, resolve };
};

describe("WorkspaceArtifactsPanel", () => {
  const createObjectURL = jest.fn(() => "blob:workspace-artifact");
  const revokeObjectURL = jest.fn();
  const click = jest.fn();

  beforeEach(() => {
    createObjectURL.mockReset().mockReturnValue("blob:workspace-artifact");
    revokeObjectURL.mockReset();
    click.mockReset();
    fetchWorkspaceArtifacts.mockResolvedValue({
      artifacts: [reportSummary, summarySummary],
      limit: 50,
      offset: 0,
      total: 2,
    });
    fetchWorkspaceArtifact.mockImplementation(async (artifactId) => ({
      artifact: buildDetail(
        artifactId === reportSummary.artifactId ? reportSummary : summarySummary
      ),
    }));
    requestWorkspaceArtifactArchive.mockResolvedValue({
      artifact: {
        ...buildDetail(reportSummary),
        archivedAt: "2026-07-15T09:00:00.000Z",
        status: "archived",
      },
    });
    downloadWorkspaceArtifact.mockResolvedValue({
      blob: new Blob(["report"]),
      fileName: reportSummary.fileName,
    });
    Object.defineProperty(window.URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(window.URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(click);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("loads compact results and opens a safe artifact detail", async () => {
    render(<WorkspaceArtifactsPanel t={t} />);

    const region = await screen.findByRole("region", {
      name: "Workspace artifacts",
    });

    expect(
      await within(region).findByText("Quarterly risk report")
    ).toBeInTheDocument();
    expect(within(region).getByText("Renewal summary")).toBeInTheDocument();
    expect(
      await within(region).findByText(/Evidence drift remains the primary risk/)
    ).toBeInTheDocument();
    expect(within(region).getByText("Generated result")).toBeInTheDocument();
    expect(within(region).getByText("Not an evidence source")).toBeInTheDocument();
    expect(fetchWorkspaceArtifacts).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      status: "active",
    });
    expect(fetchWorkspaceArtifact).toHaveBeenCalledWith("artifact-report");

    fireEvent.click(within(region).getByRole("button", { name: "Renewal summary" }));
    expect(
      await within(region).findByText("Renewal requires 30 days notice.")
    ).toBeInTheDocument();
    expect(fetchWorkspaceArtifact).toHaveBeenCalledWith("artifact-summary");
  });

  test("downloads with the authenticated API and archives before refreshing", async () => {
    fetchWorkspaceArtifacts
      .mockResolvedValueOnce({
        artifacts: [reportSummary, summarySummary],
        limit: 50,
        offset: 0,
        total: 2,
      })
      .mockResolvedValue({
        artifacts: [summarySummary],
        limit: 50,
        offset: 0,
        total: 1,
      });
    render(<WorkspaceArtifactsPanel t={t} />);

    const region = await screen.findByRole("region", {
      name: "Workspace artifacts",
    });
    await within(region).findByText(/Evidence drift remains the primary risk/);

    fireEvent.click(within(region).getByRole("button", { name: "Download" }));
    await waitFor(() => {
      expect(downloadWorkspaceArtifact).toHaveBeenCalledWith("artifact-report");
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:workspace-artifact");

    const archiveButton = within(region).getByRole("button", { name: "Archive" });
    await waitFor(() => {
      expect(archiveButton).toBeEnabled();
    });
    fireEvent.click(archiveButton);
    await waitFor(() => {
      expect(requestWorkspaceArtifactArchive).toHaveBeenCalledWith(
        "artifact-report"
      );
    });
    await waitFor(() => {
      expect(within(region).queryByText("Quarterly risk report")).not.toBeInTheDocument();
    });
    expect(fetchWorkspaceArtifacts).toHaveBeenCalledTimes(2);
  });

  test("offers a retry after list failure and guides the empty state", async () => {
    fetchWorkspaceArtifacts
      .mockRejectedValueOnce({
        response: {
          data: {
            error: "Artifact store unavailable.",
          },
        },
      })
      .mockResolvedValueOnce({
        artifacts: [],
        limit: 50,
        offset: 0,
        total: 0,
      });
    render(<WorkspaceArtifactsPanel t={t} />);

    expect(await screen.findByText("Artifact store unavailable.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("No generated results yet")).toBeInTheDocument();
    expect(
      screen.getByText("Approved reports, summaries, and collections will appear here.")
    ).toBeInTheDocument();
  });

  test("shows a detail error and retries the selected artifact", async () => {
    fetchWorkspaceArtifact
      .mockRejectedValueOnce({
        response: {
          data: {
            error: "Stored artifact detail is temporarily unavailable.",
          },
        },
      })
      .mockResolvedValueOnce({
        artifact: buildDetail(reportSummary),
      });
    render(<WorkspaceArtifactsPanel t={t} />);

    expect(
      await screen.findByText("Stored artifact detail is temporarily unavailable.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByText(/Evidence drift remains the primary risk/)
    ).toBeInTheDocument();
    expect(fetchWorkspaceArtifact).toHaveBeenCalledTimes(2);
  });

  test("keeps the newest status result when list requests resolve out of order", async () => {
    const activeRequest = createDeferred();
    const archivedRequest = createDeferred();
    const archivedSummary = {
      ...summarySummary,
      artifactId: "artifact-archived",
      status: "archived",
      title: "Archived renewal summary",
    };
    fetchWorkspaceArtifacts.mockImplementation(({ status }) =>
      status === "archived" ? archivedRequest.promise : activeRequest.promise
    );
    fetchWorkspaceArtifact.mockImplementation(async (artifactId) => ({
      artifact: buildDetail(
        artifactId === archivedSummary.artifactId
          ? archivedSummary
          : reportSummary
      ),
    }));
    render(<WorkspaceArtifactsPanel t={t} />);

    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    await act(async () => {
      archivedRequest.resolve({
        artifacts: [archivedSummary],
        limit: 50,
        offset: 0,
        total: 1,
      });
    });
    expect(
      await screen.findByRole("button", { name: "Archived renewal summary" })
    ).toBeInTheDocument();

    await act(async () => {
      activeRequest.resolve({
        artifacts: [reportSummary],
        limit: 50,
        offset: 0,
        total: 1,
      });
    });

    expect(
      screen.getByRole("button", { name: "Archived renewal summary" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Quarterly risk report" })
    ).not.toBeInTheDocument();
  });

  test("labels the archive action as busy without relabeling download", async () => {
    const archiveRequest = createDeferred();
    requestWorkspaceArtifactArchive.mockReturnValue(archiveRequest.promise);
    render(<WorkspaceArtifactsPanel t={t} />);

    await screen.findByText(/Evidence drift remains the primary risk/);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Working…" })
    ).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      archiveRequest.resolve({
        artifact: {
          ...buildDetail(reportSummary),
          archivedAt: "2026-07-15T09:00:00.000Z",
          status: "archived",
        },
      });
    });
  });

  test("keeps a failed action error with the artifact that started it", async () => {
    const downloadRequest = createDeferred();
    downloadWorkspaceArtifact.mockReturnValue(downloadRequest.promise);
    render(<WorkspaceArtifactsPanel t={t} />);

    await screen.findByText(/Evidence drift remains the primary risk/);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("button", { name: "Renewal summary" }));
    expect(
      await screen.findByText("Renewal requires 30 days notice.")
    ).toBeInTheDocument();

    await act(async () => {
      downloadRequest.reject({
        response: {
          data: {
            error: "Report download failed.",
          },
        },
      });
    });

    expect(screen.queryByText("Report download failed.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Quarterly risk report" }));
    expect(await screen.findByText("Report download failed.")).toBeInTheDocument();
  });

  test("loads the next page when total exceeds the first 50 results", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      ...summarySummary,
      artifactId: `artifact-page-${index + 1}`,
      title: `Paged artifact ${index + 1}`,
    }));
    const lastArtifact = {
      ...summarySummary,
      artifactId: "artifact-page-51",
      title: "Paged artifact 51",
    };
    fetchWorkspaceArtifacts.mockImplementation(async ({ offset = 0 }) =>
      offset === 0
        ? {
            artifacts: firstPage,
            limit: 50,
            offset: 0,
            total: 51,
          }
        : {
            artifacts: [lastArtifact],
            limit: 50,
            offset: 50,
            total: 51,
          }
    );
    fetchWorkspaceArtifact.mockImplementation(async (artifactId) => ({
      artifact: buildDetail(
        artifactId === lastArtifact.artifactId ? lastArtifact : firstPage[0]
      ),
    }));
    render(<WorkspaceArtifactsPanel t={t} />);

    expect(
      await screen.findByRole("button", { name: "Paged artifact 1" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(
      await screen.findByRole("button", { name: "Paged artifact 51" })
    ).toBeInTheDocument();
    expect(fetchWorkspaceArtifacts).toHaveBeenLastCalledWith({
      limit: 50,
      offset: 50,
      status: "active",
    });
  });

  test("refreshes the current filter when archive finishes after a status change", async () => {
    const archiveRequest = createDeferred();
    const archivedReport = {
      ...reportSummary,
      archivedAt: "2026-07-15T09:00:00.000Z",
      status: "archived",
    };
    let archivedLoadCount = 0;
    fetchWorkspaceArtifacts.mockImplementation(async ({ status }) => {
      if (status === "active") {
        return {
          artifacts: [reportSummary],
          limit: 50,
          offset: 0,
          total: 1,
        };
      }

      archivedLoadCount += 1;
      return {
        artifacts: archivedLoadCount === 1 ? [] : [archivedReport],
        limit: 50,
        offset: 0,
        total: archivedLoadCount === 1 ? 0 : 1,
      };
    });
    fetchWorkspaceArtifact.mockImplementation(async () => ({
      artifact: buildDetail(reportSummary),
    }));
    requestWorkspaceArtifactArchive.mockReturnValue(archiveRequest.promise);
    render(<WorkspaceArtifactsPanel t={t} />);

    await screen.findByText(/Evidence drift remains the primary risk/);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(await screen.findByText("No generated results yet")).toBeInTheDocument();

    await act(async () => {
      archiveRequest.resolve({ artifact: buildDetail(archivedReport) });
    });

    expect(
      await screen.findByRole("button", { name: "Quarterly risk report" })
    ).toBeInTheDocument();
    expect(fetchWorkspaceArtifacts).toHaveBeenLastCalledWith({
      limit: 50,
      offset: 0,
      status: "archived",
    });
  });

  test("shows localized status and source task in both list and detail", async () => {
    render(<WorkspaceArtifactsPanel locale="zh" t={zhT} />);

    const region = await screen.findByRole("region", {
      name: "工作区 Artifact",
    });
    const reportButton = await within(region).findByRole("button", {
      name: "Quarterly risk report",
    });
    expect(
      within(reportButton).getByText("使用中 · 来源任务 task-7")
    ).toBeInTheDocument();

    const detail = await within(region).findByRole("article");
    expect(within(detail).getByText("状态")).toBeInTheDocument();
    expect(within(detail).getByText("使用中")).toBeInTheDocument();
    expect(within(detail).getByText("来源任务")).toBeInTheDocument();
    expect(within(detail).getByText("task-7")).toBeInTheDocument();
  });

  test("localizes the fallback error when the backend has no message", async () => {
    fetchWorkspaceArtifacts.mockRejectedValue(new Error());
    render(<WorkspaceArtifactsPanel locale="zh" t={zhT} />);

    expect(
      await screen.findByText("无法加载工作区 Artifact。")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
