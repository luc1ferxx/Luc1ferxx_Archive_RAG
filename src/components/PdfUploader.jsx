import React from "react";
import axios from "axios";
import { InboxOutlined } from "@ant-design/icons";
import { message, Upload } from "antd";
import { API_DOMAIN, buildApiRequestConfig } from "../config";
import { createTranslator, getInitialLocale } from "../archiveI18n";

const defaultT = createTranslator(getInitialLocale());

const { Dragger } = Upload;
const CHUNK_SIZE_BYTES = 2 * 1024 * 1024;
// With RAG_INGEST_MODE=async the server answers 202 with an ingest job and a
// worker indexes the PDF; the uploader polls the job until it settles. The
// interval grows from 1 s to 5 s, so several files dropped at once stay well
// under the API's per-IP rate limit while their jobs wait in the queue.
export const INGEST_POLL_INTERVAL_MS = 1000;
export const INGEST_POLL_MAX_INTERVAL_MS = 5000;
export const INGEST_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const INGEST_POLL_BACKOFF = 1.5;

export const MAX_UPLOAD_SIZE_MB = 100;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

export const validatePdfFile = (file) => {
  const hasValidExtension = /\.pdf$/i.test(file.name);
  const hasValidMime = file.type === "application/pdf";
  if (!hasValidExtension && !hasValidMime) {
    return { ok: false, reason: "invalidType" };
  }
  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    return { ok: false, reason: "tooLarge" };
  }
  return { ok: true };
};

const buildFileId = (file) =>
  [file.name, file.size, file.lastModified].join("__");

const getTotalChunks = (file) =>
  Math.max(1, Math.ceil(file.size / CHUNK_SIZE_BYTES));

const initializeUpload = async (file, fileId) => {
  const payload = {
    fileId,
    fileName: file.name,
    fileSize: file.size,
    lastModified: file.lastModified,
    totalChunks: getTotalChunks(file),
    chunkSize: CHUNK_SIZE_BYTES,
  };
  const requestConfig = buildApiRequestConfig();
  const response = requestConfig
    ? await axios.post(`${API_DOMAIN}/upload/init`, payload, requestConfig)
    : await axios.post(`${API_DOMAIN}/upload/init`, payload);

  return response.data;
};

const uploadChunk = async ({ file, fileId, chunkIndex, totalChunks }) => {
  const start = chunkIndex * CHUNK_SIZE_BYTES;
  const end = Math.min(start + CHUNK_SIZE_BYTES, file.size);
  const formData = new FormData();

  formData.append("chunk", file.slice(start, end), `${file.name}.part-${chunkIndex}`);
  formData.append("fileId", fileId);
  formData.append("chunkIndex", String(chunkIndex));
  formData.append("totalChunks", String(totalChunks));

  const requestConfig = buildApiRequestConfig({
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
  const response = await axios.post(
    `${API_DOMAIN}/upload/chunk`,
    formData,
    requestConfig
  );

  return response.data;
};

const completeUpload = async (fileId) => {
  const payload = {
    fileId,
  };
  const requestConfig = buildApiRequestConfig();

  return requestConfig
    ? axios.post(`${API_DOMAIN}/upload/complete`, payload, requestConfig)
    : axios.post(`${API_DOMAIN}/upload/complete`, payload);
};

const apiGet = async (url) => {
  const requestConfig = buildApiRequestConfig();
  const response = requestConfig
    ? await axios.get(url, requestConfig)
    : await axios.get(url);

  return response.data;
};

const getIngestJob = (jobId) =>
  apiGet(`${API_DOMAIN}/ingest-jobs/${encodeURIComponent(jobId)}`);

const findUploadedDocument = async (docId) => {
  const documents = await apiGet(`${API_DOMAIN}/documents`);

  return Array.isArray(documents)
    ? documents.find((document) => document.docId === docId) ?? null
    : null;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A failed poll says nothing about the job unless the server answered it with
// a client error (404: no such job for this user). No response at all, a rate
// limit, or a 5xx during a restart is retried until the deadline.
const isTransientPollError = (error) => {
  const status = error?.response?.status;

  return !status || status === 408 || status === 429 || status >= 500;
};

const readRetryAfterMs = (error, now) => {
  const rawValue = error?.response?.headers?.["retry-after"];

  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return 0;
  }

  const seconds = Number(rawValue);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const retryAt = Date.parse(rawValue);

  return Number.isNaN(retryAt) ? 0 : Math.max(0, retryAt - now());
};

/**
 * Polls a queued ingest job until the worker settles it. Resolves to the
 * document, as a 201 upload response carries it; rejects with the job's own
 * error when it failed, with the server's error when the job is not found, or
 * when it is still unfinished after the timeout.
 */
export const waitForIngestJob = async (
  queuedJob,
  {
    intervalMs = INGEST_POLL_INTERVAL_MS,
    maxIntervalMs = INGEST_POLL_MAX_INTERVAL_MS,
    now = () => Date.now(),
    sleep = wait,
    t = defaultT,
    timeoutMs = INGEST_POLL_TIMEOUT_MS,
  } = {}
) => {
  const deadline = now() + timeoutMs;
  let delayMs = intervalMs;

  for (;;) {
    await sleep(delayMs);

    const nextDelayMs = Math.min(maxIntervalMs, delayMs * INGEST_POLL_BACKOFF);
    let job;

    try {
      job = await getIngestJob(queuedJob.jobId);
    } catch (error) {
      if (!isTransientPollError(error)) {
        throw error;
      }

      if (now() >= deadline) {
        throw new Error(t("uploader.ingestTimeout"));
      }

      delayMs = Math.max(nextDelayMs, readRetryAfterMs(error, now));
      continue;
    }

    if (job.status === "succeeded") {
      return (
        job.document ??
        (await findUploadedDocument(job.docId)) ?? {
          docId: job.docId,
          fileName: job.fileName,
        }
      );
    }

    if (job.status === "failed") {
      throw new Error(job.error || t("uploader.ingestFailed"));
    }

    if (now() >= deadline) {
      throw new Error(t("uploader.ingestTimeout"));
    }

    delayMs = nextDelayMs;
  }
};

export const uploadToBackend = async (file, onProgress, pollOptions = {}) => {
  const fileId = buildFileId(file);
  const session = await initializeUpload(file, fileId);
  const totalChunks = session.totalChunks ?? getTotalChunks(file);
  const uploadedChunks = new Set(session.uploadedChunks ?? []);
  let completedChunks = uploadedChunks.size;

  onProgress?.({
    percent: Math.round((completedChunks / totalChunks) * 100),
  });

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    if (uploadedChunks.has(chunkIndex)) {
      continue;
    }

    await uploadChunk({
      file,
      fileId,
      chunkIndex,
      totalChunks,
    });

    completedChunks += 1;
    onProgress?.({
      percent: Math.round((completedChunks / totalChunks) * 100),
    });
  }

  const response = await completeUpload(fileId);

  return response.status === 202
    ? waitForIngestJob(response.data, pollOptions)
    : response.data;
};

const PdfUploader = ({ onUploadSuccess, t = defaultT }) => {
  const attributes = {
    name: "file",
    multiple: true,
    accept: ".pdf",
    showUploadList: false,
    className: "archive-uploader",
    beforeUpload(file) {
      const result = validatePdfFile(file);
      if (!result.ok) {
        if (result.reason === "invalidType") {
          message.error(t("uploader.invalidType", { fileName: file.name }));
        } else if (result.reason === "tooLarge") {
          message.error(t("uploader.tooLarge", { fileName: file.name, maxSizeMb: MAX_UPLOAD_SIZE_MB }));
        }
        return Upload.LIST_IGNORE;
      }
      return true;
    },
    customRequest: async ({ file, onSuccess, onError, onProgress }) => {
      try {
        const response = await uploadToBackend(file, onProgress, { t });
        onUploadSuccess?.(response);
        onSuccess(response);
      } catch (error) {
        console.error("Error uploading file: ", error);
        onError(error);
      }
    },
    onChange(info) {
      const { status } = info.file;

      if (status === "done") {
        message.success(t("uploader.uploadSuccess", { fileName: info.file.name }));
      } else if (status === "error") {
        const errorMessage =
          info.file.error?.response?.data?.error ??
          info.file.error?.message ??
          "Upload failed";

        message.error(t("uploader.uploadFailed", { fileName: info.file.name, message: errorMessage }));
      }
    },
  };

  return (
    <Dragger {...attributes}>
      <div className="archive-uploader-row">
        <div className="archive-uploader-icon">
          <InboxOutlined />
        </div>

        <div className="archive-uploader-copy-wrap">
          <p className="archive-uploader-title">{t("uploader.title")}</p>
          <p className="archive-uploader-copy">
            {t("uploader.copy")}
          </p>
        </div>
      </div>
    </Dragger>
  );
};

export default PdfUploader;
