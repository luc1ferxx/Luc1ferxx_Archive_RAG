import axios from "axios";
import { API_DOMAIN, buildApiRequestConfig } from "./config";

const buildUrl = (path) => `${API_DOMAIN}${path}`;

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
