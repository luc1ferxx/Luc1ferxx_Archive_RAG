import axios from "axios";

import { apiDownload } from "./apiClient";

jest.mock("axios", () => ({
  get: jest.fn(),
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
