export const API_DOMAIN =
  import.meta.env.VITE_DOMAIN || "http://localhost:5001";

export const API_AUTH_TOKEN = import.meta.env.VITE_API_AUTH_TOKEN || "";

export const buildApiRequestConfig = (config = {}) => {
  const nextConfig = { ...config };
  const nextHeaders = {
    ...(config.headers ?? {}),
  };

  if (API_AUTH_TOKEN) {
    nextHeaders["x-api-key"] = API_AUTH_TOKEN;
  }

  if (Object.keys(nextHeaders).length > 0) {
    nextConfig.headers = nextHeaders;
  }

  return Object.keys(nextConfig).length > 0 ? nextConfig : undefined;
};
