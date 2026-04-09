import React from "react";
import axios from "axios";
import { InboxOutlined } from "@ant-design/icons";
import { message, Upload } from "antd";
import { API_DOMAIN } from "../config";

const { Dragger } = Upload;

const uploadToBackend = async (file) => {
  const formData = new FormData();
  formData.append("file", file);

  const response = await axios.post(`${API_DOMAIN}/upload`, formData, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });

  return response.data;
};

const PdfUploader = ({ onUploadSuccess }) => {
  const attributes = {
    name: "file",
    multiple: true,
    accept: ".pdf",
    showUploadList: false,
    className: "archive-uploader",
    customRequest: async ({ file, onSuccess, onError }) => {
      try {
        const response = await uploadToBackend(file);
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
        Drag files here or click to select.
      </p>
    </Dragger>
  );
};

export default PdfUploader;
