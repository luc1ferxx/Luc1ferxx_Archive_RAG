import React from "react";
import axios from "axios";
import { InboxOutlined } from "@ant-design/icons";
import { message, Upload } from "antd";
import { API_DOMAIN, buildApiRequestConfig } from "../config";
import { createTranslator, getInitialLocale } from "../archiveI18n";

const { Dragger } = Upload;
const CHUNK_SIZE_BYTES = 2 * 1024 * 1024;

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
  const response = requestConfig
    ? await axios.post(`${API_DOMAIN}/upload/complete`, payload, requestConfig)
    : await axios.post(`${API_DOMAIN}/upload/complete`, payload);

  return response.data;
};

const uploadToBackend = async (file, onProgress) => {
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

  return completeUpload(fileId);
};

const defaultT = createTranslator(getInitialLocale());

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
        const response = await uploadToBackend(file, onProgress);
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
