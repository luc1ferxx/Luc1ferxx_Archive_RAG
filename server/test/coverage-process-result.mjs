export const normalizeChildProcessClose = ({ exitCode, signal } = {}) => ({
  exitCode: Number.isInteger(exitCode) ? exitCode : 1,
  signal: typeof signal === "string" && signal ? signal : null,
});
