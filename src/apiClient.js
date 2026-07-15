import axios from "axios";
import { API_DOMAIN, buildApiRequestConfig } from "./config";

const buildUrl = (path) => `${API_DOMAIN}${path}`;

const getResponseHeader = (headers, name) => {
  if (typeof headers?.get === "function") {
    return headers.get(name) ?? "";
  }

  return headers?.[name] ?? headers?.[name.toLowerCase()] ?? "";
};

const getDownloadFileName = (contentDisposition = "") => {
  const encodedMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);

  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch {
      return encodedMatch[1];
    }
  }

  return contentDisposition.match(/filename="?([^";]+)"?/i)?.[1] ?? "";
};

const readBlobText = (blob) => {
  if (typeof blob?.text === "function") {
    return blob.text();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(blob);
  });
};

const normalizeDownloadError = async (error) => {
  const responseData = error?.response?.data;
  const isBlobResponse =
    typeof Blob !== "undefined" && responseData instanceof Blob;

  if (!isBlobResponse) {
    return error;
  }

  try {
    const body = await readBlobText(responseData);
    const parsedBody = JSON.parse(body);

    error.response = {
      ...error.response,
      data: parsedBody,
    };
  } catch {
    // Preserve the original Axios error when the response is not JSON.
  }

  return error;
};

export const apiGet = async (path) => {
  const config = buildApiRequestConfig();
  const response = config
    ? await axios.get(buildUrl(path), config)
    : await axios.get(buildUrl(path));

  return response.data;
};

export const apiPost = async (path, payload) => {
  const config = buildApiRequestConfig();
  const url = buildUrl(path);
  const response = config
    ? await axios.post(url, payload, config)
    : payload === undefined
      ? await axios.post(url)
      : await axios.post(url, payload);

  return response.data;
};

export const apiDelete = async (path) => {
  const config = buildApiRequestConfig();
  const response = config
    ? await axios.delete(buildUrl(path), config)
    : await axios.delete(buildUrl(path));

  return response.data;
};

export const apiDownload = async (path) => {
  try {
    const response = await axios.get(
      buildUrl(path),
      buildApiRequestConfig({
        responseType: "blob",
      })
    );

    return {
      blob: response.data,
      fileName: getDownloadFileName(
        getResponseHeader(response.headers, "content-disposition")
      ),
      mimeType: getResponseHeader(response.headers, "content-type"),
    };
  } catch (error) {
    throw await normalizeDownloadError(error);
  }
};
