// "same-origin" is for the single-container deployment, where the API server
// also serves this build (FRONTEND_BUILD_DIRECTORY): requests go to relative
// paths on whatever host served the page.
export const resolveApiDomain = (configuredDomain) =>
  configuredDomain === "same-origin" ? "" : configuredDomain || "http://localhost:5001";

export const API_DOMAIN = resolveApiDomain(import.meta.env.VITE_DOMAIN);

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
