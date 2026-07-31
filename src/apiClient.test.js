import { vi } from "vitest";
import axios from "axios";

import { apiDelete, apiDownload, apiGet, apiPost } from "./apiClient";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

test("apiDownload keeps request configuration and parses UTF-8 filenames", async () => {
  const blob = new Blob(["report"], {
    type: "text/markdown",
  });
  axios.get.mockResolvedValue({
    data: blob,
    headers: {
      "content-disposition":
        "attachment; filename*=UTF-8''quarterly%20risk%20report.md",
      "content-type": "text/markdown",
    },
  });

  const result = await apiDownload("/artifacts/artifact-1/download");

  expect(axios.get).toHaveBeenCalledWith(
    "http://localhost:5001/artifacts/artifact-1/download",
    expect.objectContaining({
      responseType: "blob",
    })
  );
  expect(result).toEqual({
    blob,
    fileName: "quarterly risk report.md",
    mimeType: "text/markdown",
  });
});

test("apiDownload exposes a structured 401 response from a blob error", async () => {
  const error = new Error("Request failed with status code 401");
  error.response = {
    data: new Blob(
      [JSON.stringify({ code: "api_auth_required", error: "API authentication is required." })],
      { type: "application/json" }
    ),
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    status: 401,
  };
  axios.get.mockRejectedValue(error);

  let rejection;

  try {
    await apiDownload("/artifacts/artifact-1/download");
  } catch (downloadError) {
    rejection = downloadError;
  }

  expect(rejection?.response?.status).toBe(401);
  expect(rejection?.response?.data?.code).toBe("api_auth_required");
  expect(rejection?.response?.data?.error).toBe(
    "API authentication is required."
  );
});

test("apiDownload exposes a structured 404 response from a blob error", async () => {
  const error = new Error("Request failed with status code 404");
  error.response = {
    data: new Blob(
      [JSON.stringify({ error: "Workspace artifact not found." })],
      { type: "application/json" }
    ),
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    status: 404,
  };
  axios.get.mockRejectedValue(error);

  let rejection;

  try {
    await apiDownload("/artifacts/missing/download");
  } catch (downloadError) {
    rejection = downloadError;
  }

  expect(rejection?.response?.status).toBe(404);
  expect(rejection?.response?.data?.error).toBe(
    "Workspace artifact not found."
  );
});

test("apiGet passes default timeout of 30000", async () => {
  axios.get.mockResolvedValue({ data: { ok: true } });

  await apiGet("/documents");

  expect(axios.get).toHaveBeenCalledWith(
    "http://localhost:5001/documents",
    expect.objectContaining({ timeout: 30000 })
  );
});

test("apiDownload passes timeout of 120000 and keeps responseType blob", async () => {
  const blob = new Blob(["data"]);
  axios.get.mockResolvedValue({
    data: blob,
    headers: {
      "content-disposition": "attachment; filename=\"file.bin\"",
      "content-type": "application/octet-stream",
    },
  });

  await apiDownload("/artifacts/a1/download");

  expect(axios.get).toHaveBeenCalledWith(
    "http://localhost:5001/artifacts/a1/download",
    expect.objectContaining({ timeout: 120000, responseType: "blob" })
  );
});

test("apiDownload treats a null request config as the default config", async () => {
  axios.get.mockResolvedValue({
    data: new Blob(["data"]),
    headers: {},
  });

  await apiDownload("/artifacts/a1/download", null);

  expect(axios.get).toHaveBeenCalledWith(
    "http://localhost:5001/artifacts/a1/download",
    expect.objectContaining({
      responseType: "blob",
      timeout: 120000,
    })
  );
});

test("apiPost with timeout 0 preserves the explicit zero", async () => {
  axios.post.mockResolvedValue({ data: {} });

  await apiPost("/chat", { question: "hi" }, { timeout: 0 });

  expect(axios.post).toHaveBeenCalledWith(
    "http://localhost:5001/chat",
    { question: "hi" },
    expect.objectContaining({ timeout: 0 })
  );
});

test("apiPost applies default timeout of 30000 when no config given", async () => {
  axios.post.mockResolvedValue({ data: {} });

  await apiPost("/feedback", { rating: 5 });

  expect(axios.post).toHaveBeenCalledWith(
    "http://localhost:5001/feedback",
    { rating: 5 },
    expect.objectContaining({ timeout: 30000 })
  );
});
