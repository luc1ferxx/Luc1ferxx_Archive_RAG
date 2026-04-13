import React from "react";
import axios from "axios";
import { InboxOutlined } from "@ant-design/icons";
import { message, Upload } from "antd";
import { API_DOMAIN } from "../config";

const { Dragger } = Upload;
const CHUNK_SIZE_BYTES = 2 * 1024 * 1024;

const buildFileId = (file) =>
  [file.name, file.size, file.lastModified].join("__");

const getTotalChunks = (file) =>
  Math.max(1, Math.ceil(file.size / CHUNK_SIZE_BYTES));

const initializeUpload = async (file, fileId) => {
  const response = await axios.post(`${API_DOMAIN}/upload/init`, {
    fileId,
    fileName: file.name,
    fileSize: file.size,
    lastModified: file.lastModified,
    totalChunks: getTotalChunks(file),
    chunkSize: CHUNK_SIZE_BYTES,
  });

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

  const response = await axios.post(`${API_DOMAIN}/upload/chunk`, formData, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });

  return response.data;
};

const completeUpload = async (fileId) => {
  const response = await axios.post(`${API_DOMAIN}/upload/complete`, {
    fileId,
  });

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

const PdfUploader = ({ onUploadSuccess }) => {
  const attributes = {
    name: "file",
    multiple: true,
    accept: ".pdf",
    showUploadList: false,
    className: "archive-uploader",
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
        message.success(`${info.file.name} uploaded successfully.`);
      } else if (status === "error") {
        const errorMessage =
          info.file.error?.response?.data?.error ??
          info.file.error?.message ??
          "Upload failed";

        message.error(`${info.file.name} upload failed: ${errorMessage}`);
      }
    },
  };

  return (
    <Dragger {...attributes}>
      <div className="archive-uploader-icon">
        <InboxOutlined />
      </div>
      <p className="archive-uploader-title">Upload PDFs</p>
      <p className="archive-uploader-copy">
        Drag files here or click to select. Uploads are chunked and resumable.
      </p>
    </Dragger>
  );
};

export default PdfUploader;
