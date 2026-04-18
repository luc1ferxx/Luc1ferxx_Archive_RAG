import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let ragDataDirectory =
  process.env.RAG_DATA_DIRECTORY?.trim() ||
  path.join(__dirname, "..", "data", "rag");

export const configureRagDataDirectory = (nextDirectory) => {
  ragDataDirectory = path.resolve(nextDirectory);
};

export const getRagDataDirectory = () => ragDataDirectory;

export const getRagDataPath = (...segments) =>
  path.join(getRagDataDirectory(), ...segments);

export const ensureRagDataDirectorySync = () => {
  mkdirSync(getRagDataDirectory(), { recursive: true });
};

export const readJsonFileSync = (filePath, fallbackValue) => {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }

    console.error(`Failed to read JSON file at ${filePath}.`, error);
    return fallbackValue;
  }
};

export const writeJsonFileSync = (filePath, value) => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

export const fileExistsSync = (filePath) => existsSync(filePath);
