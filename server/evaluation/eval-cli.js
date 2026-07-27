import { writeFile } from "node:fs/promises";
import path from "node:path";

export const writeJson = async (filePath, value) => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

export const toRunId = () => new Date().toISOString().replace(/[:.]/g, "-");

export const getArgValue = (name) => {
  const inlinePrefix = `${name}=`;
  const inlineValue = process.argv.find((arg) => arg.startsWith(inlinePrefix));

  if (inlineValue) {
    return inlineValue.slice(inlinePrefix.length);
  }

  const index = process.argv.indexOf(name);

  return index >= 0 ? process.argv[index + 1] : null;
};

export const readOptionValue = ({ arg, args, index, option }) => {
  const inlinePrefix = `${option}=`;
  let value;
  let nextIndex = index;

  if (arg.startsWith(inlinePrefix)) {
    value = arg.slice(inlinePrefix.length);
  } else {
    nextIndex = index + 1;
    value = args[index + 1];
  }

  if (!value || String(value).startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }

  return {
    nextIndex,
    value,
  };
};

export const toPositiveInteger = (value, fallbackValue, name) => {
  if (value === undefined) {
    return fallbackValue;
  }

  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsedValue;
};

export const validateLatestName = (value, { defaultName, optionName }) => {
  const latestName = String(value ?? defaultName);

  if (!/^[A-Za-z0-9._-]+$/.test(latestName)) {
    throw new Error(`${optionName} must contain only letters, numbers, dots, underscores, or hyphens.`);
  }

  return latestName;
};

export const resolveCorpusPath = (requestedPath, defaultPath) =>
  path.resolve(process.cwd(), requestedPath ?? defaultPath);
