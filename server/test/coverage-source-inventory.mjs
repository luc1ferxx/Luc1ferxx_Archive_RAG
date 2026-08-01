import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const parseTrackedBackendSourcePaths = (output) =>
  String(output ?? "")
    .split("\0")
    .map((filePath) => filePath.replaceAll("\\", "/"))
    .filter(Boolean)
    .filter((filePath) => /^server\/.+\.(?:js|mjs)$/.test(filePath))
    .filter((filePath) => !filePath.startsWith("server/test/"))
    .sort();

export const collectTrackedBackendSourcePaths = async ({
  repositoryDirectory,
}) => {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--", "server"],
    {
      cwd: repositoryDirectory,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }
  );

  return parseTrackedBackendSourcePaths(stdout);
};
