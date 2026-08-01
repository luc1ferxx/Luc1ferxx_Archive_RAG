export const COVERAGE_EVENT_PREFIX = "@@ARCHIVE_RAG_COVERAGE_V1@@";

const projectFileCoverage = (file) => ({
  path: file.path,
  totalLineCount: file.totalLineCount,
  totalBranchCount: file.totalBranchCount,
  totalFunctionCount: file.totalFunctionCount,
  coveredLineCount: file.coveredLineCount,
  coveredBranchCount: file.coveredBranchCount,
  coveredFunctionCount: file.coveredFunctionCount,
});

export default async function* coverageEventReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:coverage" || !event.data?.summary) {
      continue;
    }

    const summary = event.data.summary;
    const projection = {
      workingDirectory: summary.workingDirectory,
      files: summary.files.map(projectFileCoverage),
    };

    yield `${COVERAGE_EVENT_PREFIX}${JSON.stringify(projection)}\n`;
  }
}
