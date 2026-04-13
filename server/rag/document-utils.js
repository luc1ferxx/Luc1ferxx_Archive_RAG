import path from "path";

export const buildPublicFilePath = (filePath = "") =>
  filePath ? `uploads/${path.basename(filePath).replace(/\\/g, "/")}` : "";
