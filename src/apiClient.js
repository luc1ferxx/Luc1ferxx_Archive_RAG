import axios from "axios";
import { API_DOMAIN, buildApiRequestConfig } from "./config";
import { handleUnauthorizedResponse, hasOidcAccessToken } from "./auth/tokenStore";

const DEFAULT_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

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

export const FORBIDDEN_MESSAGE = "You do not have permission to do this.";

const GENERIC_FORBIDDEN_TEXT = /^\s*(forbidden\.?)?\s*$/i;

const getMissingPermissionId = (data) =>
  [
    data?.permission,
    data?.permissionId,
    data?.requiredPermission,
    data?.adminAuthorization?.permissionId,
    data?.authorization?.permissionId,
  ].find((value) => typeof value === "string" && value) ?? "";

const getServerErrorText = (data) => {
  if (typeof data?.error === "string") return data.error;
  if (typeof data?.error?.message === "string") return data.error.message;
  return "";
};

// The server stays the authority: a 403 gets a clear message that names the
// missing permission when the server reports it, never anything else.
export const describeForbiddenResponse = (data) => {
  const serverText = getServerErrorText(data);

  if (serverText && !GENERIC_FORBIDDEN_TEXT.test(serverText)) {
    return serverText;
  }

  const permissionId = getMissingPermissionId(data);

  return permissionId
    ? `${FORBIDDEN_MESSAGE} Missing permission: ${permissionId}.`
    : FORBIDDEN_MESSAGE;
};

// Keeps the body's shape: `error` stays a string, or an object whose message
// is replaced, so existing readers of error.response.data.error keep working.
export const withForbiddenMessage = (data) => {
  const body = data && typeof data === "object" ? data : {};
  const message = describeForbiddenResponse(body);

  return {
    ...body,
    error:
      body.error && typeof body.error === "object"
        ? { ...body.error, message }
        : message,
  };
};

export const normalizeForbiddenError = (error) => {
  if (error?.response?.status !== 403) {
    return error;
  }

  const data = error.response.data;

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    // apiDownload parses the blob body first, then normalizes.
    return error;
  }

  error.response = {
    ...error.response,
    data: withForbiddenMessage(data),
  };
  error.permissionDenied = true;

  return error;
};

// A 401 on a request that carried an OIDC bearer token refreshes once and
// retries; if no refresh is possible the auth layer starts a new login. The
// static VITE_API_AUTH_TOKEN path never carries a bearer and is not retried.
const sendWithAuth = async (send) => {
  const usedBearer = hasOidcAccessToken();

  try {
    return await send();
  } catch (error) {
    if (
      error?.response?.status === 401 &&
      usedBearer &&
      (await handleUnauthorizedResponse())
    ) {
      try {
        return await send();
      } catch (retryError) {
        throw normalizeForbiddenError(retryError);
      }
    }

    throw normalizeForbiddenError(error);
  }
};

export const apiGet = async (path) => {
  const response = await sendWithAuth(() =>
    axios.get(buildUrl(path), buildApiRequestConfig({ timeout: DEFAULT_TIMEOUT_MS }))
  );

  return response.data;
};

export const apiPost = async (path, payload, requestConfig) => {
  const url = buildUrl(path);
  const response = await sendWithAuth(() =>
    axios.post(
      url,
      payload,
      buildApiRequestConfig({
        timeout: DEFAULT_TIMEOUT_MS,
        ...(requestConfig ?? {}),
      })
    )
  );

  return response.data;
};

export const apiDelete = async (path) => {
  const response = await sendWithAuth(() =>
    axios.delete(buildUrl(path), buildApiRequestConfig({ timeout: DEFAULT_TIMEOUT_MS }))
  );

  return response.data;
};

export const apiDownload = async (path, requestConfig = {}) => {
  const normalizedRequestConfig = requestConfig ?? {};

  try {
    const response = await sendWithAuth(() =>
      axios.get(
        buildUrl(path),
        buildApiRequestConfig({
          ...normalizedRequestConfig,
          responseType: "blob",
          timeout: normalizedRequestConfig.timeout ?? DOWNLOAD_TIMEOUT_MS,
        })
      )
    );

    return {
      blob: response.data,
      fileName: getDownloadFileName(
        getResponseHeader(response.headers, "content-disposition")
      ),
      mimeType: getResponseHeader(response.headers, "content-type"),
    };
  } catch (error) {
    throw normalizeForbiddenError(await normalizeDownloadError(error));
  }
};
