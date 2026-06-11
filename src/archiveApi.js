import axios from "axios";
import { API_DOMAIN, buildApiRequestConfig } from "./config";

const requestConfig = () => buildApiRequestConfig();

export const fetchDocuments = async () => {
  const config = requestConfig();
  const response = config
    ? await axios.get(`${API_DOMAIN}/documents`, config)
    : await axios.get(`${API_DOMAIN}/documents`);

  return response.data;
};

export const requestDocumentDelete = async (docId) => {
  const config = requestConfig();
  const response = config
    ? await axios.delete(`${API_DOMAIN}/documents/${docId}`, config)
    : await axios.delete(`${API_DOMAIN}/documents/${docId}`);

  return response.data;
};

export const requestDocumentClear = async () => {
  const config = requestConfig();
  const response = config
    ? await axios.post(`${API_DOMAIN}/documents/clear`, undefined, config)
    : await axios.post(`${API_DOMAIN}/documents/clear`);

  return response.data;
};

export const requestSessionClear = async (sessionId) => {
  if (!sessionId) {
    return;
  }

  const config = requestConfig();

  if (config) {
    await axios.delete(`${API_DOMAIN}/sessions/${sessionId}`, config);
    return;
  }

  await axios.delete(`${API_DOMAIN}/sessions/${sessionId}`);
};

export const fetchLatestQualityReport = async () => {
  const config = requestConfig();
  const response = config
    ? await axios.get(`${API_DOMAIN}/quality/latest`, config)
    : await axios.get(`${API_DOMAIN}/quality/latest`);

  return response.data;
};

export const fetchQualityHistory = async () => {
  const config = requestConfig();
  const response = config
    ? await axios.get(`${API_DOMAIN}/quality/history`, config)
    : await axios.get(`${API_DOMAIN}/quality/history`);

  return response.data;
};

export const requestSyntheticQualityRun = async () => {
  const payload = {
    corpusPath: "evaluation/synthetic-corpus-near-duplicate.json",
  };
  const config = requestConfig();
  const response = config
    ? await axios.post(`${API_DOMAIN}/quality/synthetic`, payload, config)
    : await axios.post(`${API_DOMAIN}/quality/synthetic`, payload);

  return response.data;
};

export const requestAnswerFeedback = async (payload) => {
  const config = requestConfig();
  const response = config
    ? await axios.post(`${API_DOMAIN}/feedback`, payload, config)
    : await axios.post(`${API_DOMAIN}/feedback`, payload);

  return response.data;
};
