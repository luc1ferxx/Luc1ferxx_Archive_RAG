import { afterEach, vi } from "vitest";
import axios from "axios";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  axios.get.mockReset();
});

test("apiDownload sends auth only in the header and preserves cancellation", async () => {
  vi.stubEnv("VITE_API_AUTH_TOKEN", "super-secret-preview-token");
  const controller = new AbortController();
  const blob = new Blob(["%PDF"], {
    type: "application/pdf",
  });
  axios.get.mockResolvedValue({
    data: blob,
    headers: {
      "content-disposition": 'inline; filename="document.pdf"',
      "content-type": "application/pdf",
    },
  });
  const { apiDownload } = await import("./apiClient");

  await apiDownload("/documents/document-1/file", {
    responseType: "json",
    signal: controller.signal,
  });

  expect(axios.get).toHaveBeenCalledWith(
    "http://localhost:5001/documents/document-1/file",
    expect.objectContaining({
      headers: expect.objectContaining({
        "x-api-key": "super-secret-preview-token",
      }),
      responseType: "blob",
      signal: controller.signal,
    })
  );
  expect(axios.get.mock.calls[0][0]).not.toContain(
    "super-secret-preview-token"
  );
});
